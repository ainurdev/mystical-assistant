"""TEAM: which Rivendell teammates have Mystical on, and sending them a session, a
picture or a file (docs/superpowers/specs/team-share.md).

Rivendell carries all of it, over the link the bridge already holds
(ainurhq/rivendell, backend/src/team-shares):
  - GET /plugin/teammates is the roster. "On" means that person's Mystical holds the
    agent socket right now (AgentGateway.isOnline). Rivendell's web app tracks no
    presence, so someone working only in the browser reads as away.
  - A share is a row plus its files in Rivendell's storage: POST /plugin/shares,
    PUT each file, POST /send. Rivendell then pushes a `team-share` frame to the
    recipient's bridges, and GET /plugin/shares?box=in is the catch-up for a
    bridge that was off. Stamps (delivered, opened, continued, dismissed) go back
    as `team-share-update` frames to the sender.

What arrives is a teammate's, so nothing of it runs here without a tap:
  - A session becomes a read-only session (origin "team:<instance>", ref
    "share:<id>"). Its transcript is rebuilt from a whitelist of event types and
    fields (_sanitize); anything else in the payload is dropped. It keeps no Claude
    session id, opens no path a line names, and its pictures land under names made
    here. runner.start_streaming_job refuses a turn in it, store.claim_orphaned_turns
    leaves it alone, and store.latest_session never picks it, the same as a
    teammate's device run (bridge/device_view.py).
  - CONTINUE HERE starts your own session: the transcript as Markdown and the
    pictures go into the composer as attachments, the code (when it came) into a
    new worktree branch, and the opening prompt is an unsent draft.
  - A file is kept in the bridge's state folder, never in a project, and the
    dashboard hands it out only as a download.

Token-shaped text is blanked out before anything leaves (redact, broader than
device_side.redact: Rivendell and GitHub tokens, AWS keys, private-key blocks,
NAME_TOKEN=… lines), and again on arrival. .env files never go: not with the code
(device_ask.snapshot(env=False)) and not as a file.

Not built: watching a teammate's running session live, sending to a group, the
Mini App, Rivendell's own web bell, presence pushed by frames (the TEAM tab polls
while it is open).
"""

import gzip
import io
import json
import math
import os
import re
import shutil
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from bridge import config, device_view, notices, store

ORIGIN = "team"
REFUSAL = "This is a teammate's session, read only here. CONTINUE HERE starts your own."
NO_LINK = "Rivendell isn't linked, so there's no team here. Link it in Settings ▸ Plugins."
NOT_YOURS = "Only your own sessions can be sent; this one is a teammate's."
KINDS = ("session", "picture", "file")
STATES = ("opened", "continued", "dismissed")

_RAW_MAX = 9 * 1024 * 1024         # one file, as Rivendell takes a raw upload
_JSON_MAX = 64 * 1024 * 1024       # a transcript, unzipped
_UNPACK_MAX = 128 * 1024 * 1024    # code, unpacked (device_ask's _RAW_MAX)
_PIC_MAX = 5 * 1024 * 1024
_PICS = 20
_ATTACH = 8                        # the composer's own ceiling (UPLOAD_MAX_COUNT)
_TITLE_MAX, _NOTE_MAX = 200, 2000
_TEXT_MAX = 20000                  # one field of one event
_OUT_MAX = 8000                    # one tool's output
_EVENTS_MAX = 4000                 # share.py's ceiling for a page
_TURNS_MAX = 500
_TTL = 20                          # seconds the roster and the out-box are cached
_SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_REPO = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}")
_SHA = re.compile(r"[0-9a-f]{7,40}")
_NAME_BAD = re.compile(r"[^A-Za-z0-9._-]")
# Token-shaped text, broader than device_side.redact: what a session most often
# prints (Anthropic, Rivendell, GitHub, AWS, Slack keys, private-key blocks) and
# any NAME_TOKEN=value line.
_SECRET = re.compile(
    r"sk-ant-[A-Za-z0-9_.-]+|rvd_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"
    r"|CLAUDE_CODE_OAUTH_TOKEN=\S+")
_NAMED = re.compile(r"\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)"
                    r"[A-Z0-9_]*)[ \t]*=[ \t]*(?!\[redacted\])[^\s]+")
# What a share's transcript may carry: these event types, these fields, nothing else.
_FIELDS = {
    "text": ("text",),
    "thinking": ("ms", "text"),
    "tool": ("id", "name", "summary"),
    "tool_done": ("id", "ms", "output", "is_error", "images"),
    "result": ("result", "cost", "elapsed", "is_error"),
    "error": ("message",),
    "divider": ("text",),
    "steer": ("text",),
}

_lock = threading.RLock()
_busy: set = set()                 # share ids being taken in now: a frame and a catch-up can bring one twice
_cache: dict = {}                  # "roster" | "outbox" -> (at, rows)


class TeamError(Exception):
    """A sentence for the person: why a send or a continue didn't go."""


def is_team(origin) -> bool:
    """Is this the origin of a session a teammate sent?"""
    return isinstance(origin, str) and origin.startswith(ORIGIN + ":")


def refusal(origin) -> "str | None":
    """Why nothing may run in, title, copy or link a session of this origin, or None
    when it is yours: a teammate's device run or a session a teammate sent."""
    if device_view.is_device_run(origin):
        return device_view.REFUSAL
    return REFUSAL if is_team(origin) else None


# --- the link ---------------------------------------------------------------------------------

def _instance(iid: "str | None" = None) -> "dict | None":
    from bridge import device_ask     # here: device_ask reaches rivendell, which imports this module
    return device_ask._instance(iid)


def _client(iid: "str | None" = None):
    """A Worker for the instance named, else the first enabled one: for its _api."""
    inst = _instance(iid)
    if not inst:
        raise TeamError(NO_LINK)
    from bridge import device_ask
    return device_ask._client(inst)


def _why(e: Exception) -> str:
    """One sentence for a failed call to Rivendell."""
    if isinstance(e, urllib.error.HTTPError):
        msg = ""
        try:
            m = json.loads(e.read() or b"{}").get("message")
            msg = (m if isinstance(m, str) else "; ".join(map(str, m)) if isinstance(m, list) else "")[:200]
        except Exception:  # noqa: BLE001 — the status alone still says something
            pass
        if msg.startswith("Cannot ") or (e.code == 404 and not msg):
            return "Rivendell doesn't take shares yet: it needs the TEAM update deployed."
        if e.code in (401, 403) and not msg:
            return "Rivendell refused this bridge's token."
        if e.code == 413:
            return "That's too big for Rivendell: 9 MB a file."
        return msg or f"Rivendell answered {e.code}."
    if isinstance(e, urllib.error.URLError):
        return "Rivendell can't be reached right now."
    return "Rivendell's answer didn't make sense."


def _cached(key: str, path: str) -> list:
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < _TTL:
            return hit[1]
    rows = _client()._api(path)
    rows = rows if isinstance(rows, list) else []
    with _lock:
        _cache[key] = (time.time(), rows)
    return rows


# --- redaction and the transcript's whitelist -----------------------------------------------------

def redact(text) -> "tuple[str, int]":
    """`text` with token-shaped strings blanked out, and how many there were."""
    if not isinstance(text, str) or not text:
        return text, 0
    text, n = _SECRET.subn("[redacted]", text)
    text, m = _NAMED.subn(lambda mm: f"{mm.group(1)}=[redacted]", text)
    return text, n + m


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _clean_event(ev, picture, ids: dict) -> "tuple[dict | None, int]":
    """One stored event as a share carries it: a whitelisted type with only its
    whitelisted fields, strings capped and redacted, ids plain (another one stands
    in for an id that isn't, the same one each time), pictures by what `picture`
    gives for each (None drops one). Returns (event or None, redactions)."""
    kind = ev.get("type") if isinstance(ev, dict) else None
    if kind not in _FIELDS:
        return None, 0
    out, n = {"type": kind}, 0
    for k in _FIELDS[kind]:
        v = ev.get(k)
        if v is None:
            continue
        if k == "id":
            if isinstance(v, str):
                out[k] = v if _SAFE_ID.fullmatch(v) else ids.setdefault(v, uuid.uuid4().hex)
        elif k == "images":
            if isinstance(v, list):
                got = [p for p in (picture(x) for x in v[:_PICS] if isinstance(x, str)) if p]
                if got:
                    out[k] = got
        elif k in ("ms", "cost", "elapsed"):
            if _num(v):
                out[k] = v
        elif k == "is_error":
            if isinstance(v, bool):
                out[k] = v
        elif isinstance(v, str):
            out[k], m = redact(v[:_OUT_MAX if k == "output" else _TEXT_MAX])
            n += m
    return out, n


def _one_line(v, cap: int) -> str:
    return " ".join(str(v or "").split())[:cap]


def _clean_name(name, default: str = "file") -> str:
    """A file name safe to keep and to put in a URL: [A-Za-z0-9._-], never hidden."""
    base = _NAME_BAD.sub("_", os.path.basename(str(name or "")).strip()).lstrip(".")[:120]
    return base or default


def _img_ext(head: bytes) -> "str | None":
    """A picture's extension by its bytes; None for anything else (never SVG)."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


# --- packing and sending ----------------------------------------------------------------------

def _session_dir(s: dict) -> str:
    """Where a session works: its worktree while that still exists, else its folder."""
    wt = s.get("work_cwd") or ""
    return wt if wt and os.path.isdir(wt) else (s.get("cwd") or "")


def pack_session(session_id: str, pictures: bool = True) -> dict:
    """A session of yours, packed to send: {payload (gzipped transcript JSON),
    pictures [(name, path)], meta, title}. Raises TeamError."""
    from bridge import git, github
    s = store.get_session(session_id or "")
    if not s:
        raise TeamError("That session is gone.")
    if refusal(s.get("origin")):
        raise TeamError(NOT_YOURS)
    t = store.transcript(session_id)
    up = os.path.realpath(config.UPLOAD_DIR) + os.sep
    pics: list = []
    names: dict = {}

    def picture(path):
        if not pictures or not isinstance(path, str):
            return None
        if path in names:
            return names[path]
        real = os.path.realpath(path)
        if len(pics) >= _PICS or not real.startswith(up) or not os.path.isfile(real) \
                or os.path.getsize(real) > _PIC_MAX:
            return None
        with open(real, "rb") as f:
            ext = _img_ext(f.read(16))
        if not ext:
            return None
        names[path] = f"pic-{len(pics) + 1}{ext}"
        pics.append((names[path], real))
        return names[path]

    by_turn: dict = {}
    for ev in t["events"]:
        by_turn.setdefault(ev.get("turn_id"), []).append(ev)
    turns, redacted, kept = [], 0, 0
    for turn in t["turns"][-_TURNS_MAX:]:
        events, ids = [], {}
        for ev in by_turn.get(turn["id"], []):
            if kept >= _EVENTS_MAX:
                break
            clean, n = _clean_event(ev, picture, ids)
            if clean:
                events.append(clean)
                kept += 1
                redacted += n
        prompt, n = redact((turn.get("prompt") or "")[:_TEXT_MAX])
        redacted += n
        turns.append({"prompt": prompt, "at": turn.get("started"), "model": turn.get("model"),
                      "effort": turn.get("effort"), "status": turn.get("status"),
                      "attachments": [p for p in (picture(a) for a in turn.get("attachments") or []) if p],
                      "events": events})
    title, n = redact((s.get("title") or "Session")[:_TITLE_MAX])
    redacted += n
    payload = gzip.compress(json.dumps({"v": 1, "title": title, "turns": turns}).encode())
    if len(payload) > _RAW_MAX:
        raise TeamError(f"This session packs to {len(payload) / 1048576:.1f} MB; a share takes up to 9 MB.")
    cwd = _session_dir(s)
    meta = {"project": s.get("project"), "repo": github.remote_slug(cwd) if cwd else None,
            "branch": (git.current_branch_cached(cwd) or None) if cwd else None, "turns": len(turns),
            "pictures": len(pics), "code": False, "commitSha": None, "redacted": redacted}
    return {"payload": payload, "pictures": pics, "meta": meta, "title": title}


def preview(session_id: str) -> dict:
    """What the send sheet shows about a session before it goes."""
    p = pack_session(session_id)
    m = p["meta"]
    return {"title": p["title"], "project": m["project"], "repo": m["repo"], "branch": m["branch"],
            "turns": m["turns"], "pictures": m["pictures"], "redacted": m["redacted"]}


def _read(path: str, cap: int) -> bytes:
    with open(path, "rb") as f:
        data = f.read(cap + 1)
    if len(data) > cap:
        raise TeamError(f"It's over {cap // 1048576} MB; a share takes up to {cap // 1048576} MB.")
    return data


def _picture_file(path) -> "tuple[str, bytes]":
    """A picture this bridge holds (its upload folder), checked by its bytes."""
    real = os.path.realpath(str(path or ""))
    if not real.startswith(os.path.realpath(config.UPLOAD_DIR) + os.sep) or not os.path.isfile(real):
        raise TeamError("That picture can't be sent from here.")
    data = _read(real, _PIC_MAX)
    if not _img_ext(data[:16]):
        raise TeamError("That isn't a picture this can send (PNG, JPEG, GIF or WebP).")
    return real, data


def _plain_file(path) -> "tuple[str, bytes]":
    """A file in one of your projects. Never a .env file."""
    real = os.path.realpath(str(path or ""))
    if not real.startswith(os.path.realpath(config.BASE_PATH) + os.sep) or not os.path.isfile(real):
        raise TeamError("That file isn't inside your projects.")
    if os.path.basename(real).lower().startswith(".env"):
        raise TeamError(".env files never go to anyone.")
    return real, _read(real, _RAW_MAX)


def send(kind: str, to: str, note: str = "", *, session_id: "str | None" = None, pictures: bool = True,
         code: bool = False, path: "str | None" = None) -> dict:
    """Send a session, a picture or a file to teammate `to` through Rivendell:
    create the share, upload its files, then send it. Returns Rivendell's ShareDto.
    Raises TeamError with a sentence for the person."""
    if kind not in KINDS:
        raise TeamError("Nothing to send.")
    if not isinstance(to, str) or not _UUID.fullmatch(to):
        raise TeamError("Pick a teammate to send it to.")
    note, _ = redact(str(note or "").strip()[:_NOTE_MAX])
    w = _client()
    if kind == "session":
        packed = pack_session(session_id, pictures)
        files = [("transcript.json.gz", "transcript", packed["payload"])]
        files += [(name, "picture", _read(p, _PIC_MAX)) for name, p in packed["pictures"]]
        meta, title = packed["meta"], packed["title"]
        if code:
            from bridge import device_ask
            try:
                snap = device_ask.snapshot(_session_dir(store.get_session(session_id)), env=False)
            except device_ask.DeviceAskError as e:
                # Its sentences name device runs, whose cap this shares.
                raise TeamError(str(e).replace("device runs take", "a share takes")) from None
            files.append(("code.tar.gz", "code", snap["tar_gz"]))
            meta.update(code=True, commitSha=snap["commitSha"], repo=snap["repository"])
    else:
        real, data = _picture_file(path) if kind == "picture" else _plain_file(path)
        name = _clean_name(os.path.basename(real))
        files, meta, title = [(name, kind, data)], {"name": name, "bytes": len(data)}, name
    body = {"toUserId": to, "kind": kind, "title": title[:_TITLE_MAX], "meta": meta}
    if note:
        body["note"] = note
    try:
        share_id = w._api("/plugin/shares", body)["id"]
        for name, role, data in files:
            w._api_put_bytes(f"/plugin/shares/{share_id}/files/{urllib.parse.quote(name, safe='')}?role={role}",
                             data, "application/octet-stream")
        share = w._api(f"/plugin/shares/{share_id}/send", {})
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as e:
        raise TeamError(_why(e)) from None
    with _lock:
        _cache.pop("outbox", None)
    return share


# --- what this bridge was sent: team.json beside the DB (0600) -------------------------------------

def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "team.json")


def _files_dir(share_id: str) -> str:
    """Where a received file is kept: the bridge's state folder, never a project."""
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "team", share_id)


def _load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            got = json.load(f)
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(shares: dict) -> None:
    path = _path()
    with os.fdopen(os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600),
                   "w", encoding="utf-8") as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(shares, f)
    os.replace(path + ".tmp", path)


def _get(share_id: str) -> "dict | None":
    with _lock:
        return _load().get(share_id)


def _put(share_id: str, rec: dict) -> None:
    with _lock:
        shares = _load()
        shares[share_id] = rec
        _save(shares)


def _drop_local(share_id: str, rec: dict) -> None:
    """The local copy of a share: its read-only session, its pictures, its file."""
    if rec.get("session"):
        store.delete_session(rec["session"])
        shutil.rmtree(os.path.join(config.UPLOAD_DIR, rec["session"]), ignore_errors=True)
        for tid in rec.get("turns") or []:
            shutil.rmtree(os.path.join(config.UPLOAD_DIR, tid), ignore_errors=True)
    shutil.rmtree(os.path.join(config.UPLOAD_DIR, f"team-{share_id}"), ignore_errors=True)
    shutil.rmtree(_files_dir(share_id), ignore_errors=True)


def _prune(now: "float | None" = None) -> None:
    """Shares past their expiry go, local copy and all, as Rivendell drops them."""
    now = time.time() if now is None else now
    with _lock:
        shares = _load()
        gone = [k for k, r in shares.items() if (r.get("expires_at") or now + 1) < now]
        for k in gone:
            _drop_local(k, shares.pop(k))
        if gone:
            _save(shares)


# --- receiving ----------------------------------------------------------------------------------

def on_share(worker, frame: dict) -> None:
    """A `team-share` frame, or a catch-up row: take it in. Never raises."""
    try:
        _receive(worker, frame)
    except Exception as e:  # noqa: BLE001 — a teammate's share must never take the link down
        print(f"[team] a share wasn't taken in: {e}", file=sys.stderr)


def catch_up(worker) -> None:
    """At each connect: the shares sent while this bridge was away. Never raises."""
    try:
        rows = worker._api("/plugin/shares?box=in")
    except Exception as e:  # noqa: BLE001 — nothing to catch up
        if not (isinstance(e, urllib.error.HTTPError) and e.code == 404):    # 404: a Rivendell without shares
            print(f"[team] catch-up skipped: {e}", file=sys.stderr)
        return
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict):
            on_share(worker, row)


def on_update(worker, frame: dict) -> None:
    """A `team-share-update` frame: a share you sent was delivered, opened,
    continued or dismissed. The out-box is read again on the next look."""
    with _lock:
        _cache.pop("outbox", None)


def _iso_epoch(v) -> "float | None":
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def _clean_meta(meta, kind: str) -> dict:
    """The facts a share carries that the dashboard shows, typed and capped."""
    m = meta if isinstance(meta, dict) else {}
    if kind != "session":
        return {"name": _clean_name(m.get("name")), "bytes": m["bytes"] if _num(m.get("bytes")) else None}
    repo, sha = m.get("repo"), m.get("commitSha")
    return {"project": _one_line(m.get("project"), 200) or None,
            "repo": repo if isinstance(repo, str) and _REPO.fullmatch(repo) else None,
            "branch": _one_line(m.get("branch"), 200) or None,
            "turns": int(m["turns"]) if _num(m.get("turns")) else None,
            "pictures": int(m["pictures"]) if _num(m.get("pictures")) else 0,
            "code": m.get("code") is True,
            "commitSha": sha if isinstance(sha, str) and _SHA.fullmatch(sha) else None}


def _receive(worker, row: dict) -> None:
    share_id = row.get("requestId") or row.get("id")
    kind = row.get("kind")
    if not isinstance(share_id, str) or not _SAFE_ID.fullmatch(share_id) or kind not in KINDS:
        return
    with _lock:
        if share_id in _busy or share_id in _load():
            return
        _busy.add(share_id)
    try:
        frm = row.get("from") if isinstance(row.get("from"), dict) else {}
        files = [{"id": f["id"], "role": f.get("role"), "name": _clean_name(f.get("name"))}
                 for f in (row.get("files") or [])[:_PICS + 2]
                 if isinstance(f, dict) and isinstance(f.get("id"), str) and _SAFE_ID.fullmatch(f["id"])]
        rec = {"instance": worker.id, "kind": kind,
               "title": redact(_one_line(row.get("title"), _TITLE_MAX))[0] or kind.capitalize(),
               "note": redact(str(row.get("note") or "")[:_NOTE_MAX].strip())[0],
               "from": {"id": _one_line(frm.get("id"), 64), "name": _one_line(frm.get("name"), 80) or "A teammate"},
               "sent": _one_line(row.get("sentAt"), 40), "expires_at": _iso_epoch(row.get("expiresAt")),
               "meta": _clean_meta(row.get("meta"), kind), "files": files, "at": time.time(),
               "session": None, "turns": [], "file": None,
               "opened": False, "continued": False, "dismissed": False}
        if kind == "session":
            _materialize(worker, share_id, rec)
        else:
            _keep_file(worker, share_id, rec)
        _put(share_id, rec)
        _announce(worker, share_id, rec)
        _stamp(worker, share_id, "delivered")
    finally:
        with _lock:
            _busy.discard(share_id)


def _download(worker, share_id: str, f: dict, cap: int) -> bytes:
    """One of a share's files, by the signed link Rivendell hands out, at most `cap`."""
    got = worker._api(f"/plugin/shares/{share_id}/files/{f['id']}")
    url = got.get("url") if isinstance(got, dict) else None
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise ValueError("no download link")
    with urllib.request.urlopen(url, timeout=60) as r:
        data = r.read(cap + 1)
    if len(data) > cap:
        raise ValueError(f"{f['name']} is over its cap")
    return data


def _gunzip(raw: bytes, cap: int) -> bytes:
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as g:
        out = g.read(cap + 1)
    if len(out) > cap:
        raise ValueError("the transcript unpacks too big")
    return out


def _write_new(path: str, data: bytes) -> None:
    """A file of this bridge's making: never over an existing one, never through a link."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def _materialize(worker, share_id: str, rec: dict) -> None:
    """A session share as a read-only session here: its transcript rebuilt from the
    whitelist, its pictures under names made here. Fills rec's session and turns.
    Nothing half-made is left when any of it fails."""
    tf = next((f for f in rec["files"] if f["role"] == "transcript"), None)
    if not tf:
        raise ValueError("no transcript")
    doc = json.loads(_gunzip(_download(worker, share_id, tf, _RAW_MAX), _JSON_MAX))
    if not isinstance(doc, dict) or not isinstance(doc.get("turns"), list):
        raise ValueError("not a transcript")
    pics = {f["name"]: f for f in rec["files"] if f["role"] == "picture"}
    sid = store.create_session(config.DASH_CHAT_ID, "/", origin=f"{ORIGIN}:{worker.id}", cwd=config.BASE_PATH)["id"]
    rec["session"] = sid
    got: dict = {}

    def picture(name, folder):
        if not isinstance(name, str) or name not in pics:
            return None
        if (folder, name) not in got:
            raw = _download(worker, share_id, pics[name], _PIC_MAX)
            ext = _img_ext(raw[:16])
            got[(folder, name)] = None
            if ext:
                path = os.path.join(folder, f"tp-{len(got)}{ext}")
                _write_new(path, raw)
                got[(folder, name)] = path
        return got[(folder, name)]

    try:
        turns, events, seq = [], [], 0
        updir = os.path.join(config.UPLOAD_DIR, sid)
        for t in doc["turns"][:_TURNS_MAX]:
            if not isinstance(t, dict):
                continue
            tid = uuid.uuid4().hex
            rec["turns"].append(tid)
            at = t["at"] if _num(t.get("at")) else time.time()
            ids: dict = {}
            for ev in (t.get("events") or [])[:_EVENTS_MAX]:
                if seq >= _EVENTS_MAX:
                    break
                clean, _ = _clean_event(ev, lambda n: picture(n, updir), ids)
                if clean:
                    events.append({**clean, "turn_id": tid, "seq": seq, "ts": at})
                    seq += 1
            atts = [os.path.basename(p) for p in (picture(a, os.path.join(config.UPLOAD_DIR, tid))
                                                  for a in (t.get("attachments") or [])[:_PICS]) if p]
            model = t.get("model")
            turns.append({"id": tid, "seq": len(turns), "prompt": redact(str(t.get("prompt") or "")[:_TEXT_MAX])[0],
                          "attachments": atts, "status": t.get("status") if t.get("status") in ("done", "error") else "done",
                          "started": at, "model": model[:80] if isinstance(model, str) else None})
        store.rename(sid, rec["title"][:60])
        store.set_ref(sid, f"share:{share_id}")
        store.set_team(sid, {"share": share_id, "instance": worker.id, "kind": "session", "from": rec["from"],
                             "note": rec["note"], "sent": rec["sent"], "meta": rec["meta"]})
        store.import_transcript(sid, turns, events)
    except Exception:
        _drop_local(share_id, rec)
        raise


def _keep_file(worker, share_id: str, rec: dict) -> None:
    """A picture lands in the upload folder, where the lightbox serves it; any other
    file in the state folder, which the dashboard hands out only as a download."""
    want = "picture" if rec["kind"] == "picture" else "file"
    f = next((f for f in rec["files"] if f["role"] == want), None)
    if not f:
        raise ValueError(f"no {want}")
    if want == "picture":
        raw = _download(worker, share_id, f, _PIC_MAX)
        ext = _img_ext(raw[:16])
        if not ext:
            raise ValueError("not a picture")
        path = os.path.join(config.UPLOAD_DIR, f"team-{share_id}", os.path.splitext(f["name"])[0][:100] + ext)
    else:
        raw = _download(worker, share_id, f, _RAW_MAX)
        path = os.path.join(_files_dir(share_id), f["name"])
    _write_new(path, raw)
    rec["file"] = path


def _what(kind: str) -> str:
    return {"session": "a session", "picture": "a picture", "file": "a file"}[kind]


def _announce(worker, share_id: str, rec: dict) -> None:
    """A row in the bell (a click opens the session), and Telegram where NOTIFY routes it."""
    name, note = rec["from"]["name"], rec["note"]
    meta = {"share": share_id, "kind": rec["kind"], "instance_id": worker.id}
    if rec["session"]:
        meta["session_id"] = rec["session"]
    notices.emit("team_in", f"team:{share_id}", title=f"{name} sent you {_what(rec['kind'])}",
                 body=rec["title"] + (f" — “{note}”" if note else ""), meta=meta)
    if notices.telegram_ok("team_in"):
        worker._deliver_telegram(f"{name} sent you {_what(rec['kind'])}: {rec['title']}"
                                 + (f"\n“{note}”" if note else "") + "\nIt's in Mystical's TEAM tab.", None)


def _stamp(worker, share_id: str, state: str) -> None:
    """Tell Rivendell, which tells the sender. Best effort: the share is here either way."""
    try:
        worker._api(f"/plugin/shares/{share_id}/{state}", {})
    except Exception as e:  # noqa: BLE001
        print(f"[team] {state} not stamped on {share_id}: {e}", file=sys.stderr)


# --- what the dashboard reads and does ------------------------------------------------------------

def _file_url(rec: dict, share_id: str) -> "str | None":
    if not rec.get("file"):
        return None
    if rec["kind"] == "picture":
        return "/local/attachment?path=" + urllib.parse.quote(rec["file"])
    return f"/local/rivendell/team/file?id={share_id}"


def inbox() -> list:
    """What teammates sent this bridge, newest first, dismissed ones left out."""
    _prune()
    with _lock:
        shares = _load()
    rows = [{"id": k, "kind": r["kind"], "title": r["title"], "note": r["note"], "from": r["from"],
             "sent": r["sent"], "meta": r["meta"], "session": r.get("session"),
             "file": os.path.basename(r["file"]) if r.get("file") else None, "url": _file_url(r, k),
             "opened": r["opened"], "continued": r["continued"], "at": r["at"]}
            for k, r in shares.items() if not r.get("dismissed")]
    return sorted(rows, key=lambda r: r["at"], reverse=True)


def overview() -> dict:
    """The TEAM tab: the roster, what you were sent, what you sent, and the unread count."""
    out = {"roster": [], "outbox": [], "inbox": inbox(), "error": None}
    try:
        out["roster"] = _cached("roster", "/plugin/teammates")
        out["outbox"] = _cached("outbox", "/plugin/shares?box=out")
    except TeamError as e:
        out["error"] = str(e)
    except (urllib.error.URLError, OSError, ValueError) as e:
        out["error"] = _why(e)
    out["unread"] = sum(1 for r in out["inbox"] if not r["opened"])
    return out


def mark(share_id: str, state: str) -> dict:
    """You opened, continued or dismissed a share: note it here and tell Rivendell.
    Dismissing drops the local copy, session, pictures and file alike."""
    if state not in STATES:
        raise TeamError("Nothing to mark.")
    with _lock:
        shares = _load()
        rec = shares.get(share_id)
        if not rec:
            raise TeamError("That share is gone.")
        if rec.get(state):
            return rec
        rec[state] = True
        if state == "dismissed":
            _drop_local(share_id, rec)
            rec.update(session=None, file=None, turns=[])
        _save(shares)
    try:
        _stamp(_client(rec["instance"]), share_id, state)
    except TeamError:
        pass
    return rec


def file_path(share_id: str) -> "tuple[str, str] | None":
    """A received file's path and its name, for the download route."""
    rec = _get(share_id or "")
    if not rec or rec["kind"] != "file" or not rec.get("file") or not os.path.isfile(rec["file"]):
        return None
    return rec["file"], os.path.basename(rec["file"])


def _slug(text: str, cap: int) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:cap].strip("-") or "share"


def _local_project(meta: dict) -> "str | None":
    """Your checkout of the repository a session came from: the project whose remote
    is the same GitHub repository, else one at the same path as theirs."""
    from bridge import browser, github
    projects = browser.list_projects()
    repo = (meta.get("repo") or "").lower()
    if repo:
        for p in projects:
            if repo in {r.lower() for r in github.remote_slugs(os.path.join(config.BASE_PATH, p.lstrip("/")))}:
                return p
    return meta.get("project") if meta.get("project") in projects else None


def continue_plan(share_id: str) -> dict:
    """What CONTINUE HERE needs to set up your own session: the project to start it
    in (None when the repository isn't cloned here), the branch for their code and
    the commit to cut it from, the unsent draft, and the attachments."""
    from bridge import git
    rec = _get(share_id or "")
    if not rec or rec.get("dismissed"):
        raise TeamError("That share is gone.")
    name, note, meta = rec["from"]["name"], rec["note"], rec["meta"]
    said = f" Their note: “{note}”" if note else ""
    if rec["kind"] != "session":
        return {"project": None, "repo": None, "branch": None, "base": None, "title": None,
                "draft": f"{name} sent me this {rec['kind']}.{said}",
                "attachments": [{"name": os.path.basename(rec["file"]), "url": _file_url(rec, share_id)}]
                if rec.get("file") else []}
    project = _local_project(meta)
    code = bool(meta.get("code")) and project is not None
    first = _slug(name.split()[0] if name.split() else "teammate", 20)
    base = meta.get("commitSha") if code else None
    if base and git._run(os.path.join(config.BASE_PATH, project.lstrip("/")), "cat-file", "-e", base + "^{commit}")[0]:
        base = None      # not here (never pushed, or not fetched): the branch starts from your default
    attach = [{"name": "transcript.md", "url": f"/local/rivendell/team/transcript.md?id={share_id}"}]
    attach += [{"name": os.path.basename(p), "url": "/local/attachment?path=" + urllib.parse.quote(p)}
               for p in _session_pictures(rec)[:_ATTACH - 1]]
    return {"project": project, "repo": meta.get("repo"), "title": rec["title"],
            "branch": f"from-{first}/{_slug(rec['title'], 40)}" if code else None, "base": base,
            "draft": f"{name} sent me this session to pick up. Read the attached transcript first"
                     + (", then look at their code on this branch." if code else ".") + said,
            "attachments": attach}


def _session_pictures(rec: dict) -> list:
    """The received session's pictures, in the order they were taken in."""
    if not rec.get("session"):
        return []
    found = []
    for folder in [os.path.join(config.UPLOAD_DIR, rec["session"])] + \
            [os.path.join(config.UPLOAD_DIR, t) for t in rec.get("turns") or []]:
        try:
            found += sorted((os.path.join(folder, n) for n in os.listdir(folder) if n.startswith("tp-")),
                            key=lambda p: int(re.sub(r"\D", "", os.path.basename(p)) or 0))
        except OSError:
            continue
    return found


def unpack(share_id: str, cwd: str) -> int:
    """Their code into `cwd`, the fresh worktree CONTINUE HERE made: plain files and
    folders only, every path inside it, never .git nor a .env file. Returns how many
    files it wrote. Raises TeamError."""
    rec = _get(share_id or "")
    if not rec or rec["kind"] != "session":
        raise TeamError("That share is gone.")
    f = next((f for f in rec["files"] if f["role"] == "code"), None)
    if not f:
        raise TeamError("No code came with it.")
    root = os.path.realpath(str(cwd or ""))
    if not root.startswith(os.path.realpath(config.BASE_PATH) + os.sep) or not os.path.isdir(root):
        raise TeamError("That folder isn't inside your projects.")
    from bridge import git
    rc, out, _ = git._run(root, "status", "--porcelain")
    if rc == 0 and out.strip():      # a second CONTINUE HERE reuses the branch's worktree: never over your work
        raise TeamError("That worktree already has changes, so their code wasn't unpacked over them.")
    try:
        raw = _download(_client(rec["instance"]), share_id, f, _RAW_MAX)
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as t:
            members, total = [], 0
            for m in t.getmembers():
                parts = [p for p in m.name.replace("\\", "/").split("/") if p not in ("", ".")]
                if not parts or m.name.startswith(("/", "\\")) or ".." in parts or ":" in parts[0] \
                        or any(p.lower() == ".git" for p in parts) or parts[-1].lower().startswith(".env"):
                    continue
                if not (m.isfile() or m.isdir()):
                    continue     # links and devices could lead anywhere
                total += m.size
                if total > _UNPACK_MAX:
                    raise TeamError("Their code unpacks too big.")
                m.name = "/".join(parts)
                members.append(m)
            # The "data" filter checks each path again where Python has it (3.12+).
            t.extractall(root, members=members, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    except TeamError:
        raise
    except (urllib.error.URLError, OSError, ValueError, tarfile.TarError) as e:
        raise TeamError(f"Their code couldn't be unpacked: {_why(e) if isinstance(e, urllib.error.URLError) else e}") from None
    return sum(1 for m in members if m.isfile())


def transcript_md(share_id: str) -> "str | None":
    """A received session as Markdown, for CONTINUE HERE to attach."""
    rec = _get(share_id or "")
    if not rec or not rec.get("session") or not store.get_session(rec["session"]):
        return None
    t = store.transcript(rec["session"])
    by_turn: dict = {}
    for ev in t["events"]:
        by_turn.setdefault(ev["turn_id"], []).append(ev)
    out = [f"# {rec['title']}", "", f"A session {rec['from']['name']} sent on {rec['sent'][:10] or 'an earlier day'}."]
    if rec["note"]:
        out += ["", f"Their note: “{rec['note']}”"]
    for i, turn in enumerate(t["turns"], 1):
        out += ["", f"## Turn {i}", "", "**Prompt**", "", turn["prompt"] or "(no words)", ""]
        for ev in by_turn.get(turn["id"], []):
            if ev["type"] == "text" and ev.get("text"):
                out += [ev["text"], ""]
            elif ev["type"] == "tool":
                out.append(f"- `{ev.get('name', 'tool')}` {ev.get('summary') or ''}".rstrip())
            elif ev["type"] == "error":
                out += [f"> error: {ev.get('message', '')}", ""]
    return "\n".join(out).rstrip() + "\n"
