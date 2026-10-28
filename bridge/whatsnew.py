"""What changed in Mystical, told in the changelog (the scroll above UPDATE on the
dashboard's right rail): a row each install writes at boot from the commits that
landed (docs/superpowers/specs/changelog-v4.md). It pops like any news when it lands.

Why each install writes its own row rather than reading a committed CHANGELOG:
the range is known only here (`last_head` → HEAD), every path that moves the
checkout — the UPDATE button, `mystical update`, a hand pull and a restart —
passes through boot, and nobody has to remember to write an entry at merge time.
The cost is one haiku call per restart that found new commits, behind the UPDATE
NOTES switch; off, the row lists the commit subjects instead.

Why the waiting update is told too (`preview`): the summary above lands only after
PULL & RESTART, so nobody could see what an update brought before taking it. So the
bridge looks upstream (each dashboard's UPDATE poll, plus an hourly `watch` of its own
so an install with no dashboard open hears it on Telegram) and writes `HEAD..@{u}` into
one `coming` row. It is news once; as more commits land it is rewritten in place at most
hourly, so a busy upstream costs a call an hour, not one a push. The boot after the pull
takes that row's words for its UPDATED row when the ranges match: the one-shot moved
earlier instead of doubling.

Why a row the one-shot couldn't write is asked again (`retry`): an update that lands
while the login is at its limit got only its commit subjects, and nothing came back for
it (2026-10-24, twice in one night). The hourly watch asks haiku again for any such row
of the last week and rewrites it in place, so it is not news twice. Until then the
fallback reads like notes, `area: text` → `Area — text`, rather than as a git log.

Why a bullet may name a place (`go`, from PLACES): the changelog's Open › takes you to
the thing that changed. haiku picks from a fixed list or says null; anything else is
dropped, so a row never links somewhere the dashboard doesn't have.

Why a change can bring its own words and picture (`docs/changes/<slug>.md`, CHANGES_DIR):
a change that only shows in a state (a login at its limit, a question waiting) has nothing
Open › can show, and haiku guesses its place. So the session that ships one may commit a
note: frontmatter `area`, `when` (the state), `place` (from PLACES) and `for`, one sentence,
and `<slug>.webp|png|jpg` and/or `<slug>.mp4` beside it. A note added in the range is told
first, in its own words, with its picture (`meta.media`, `meta.when`, aligned with the bullets
like `go`); haiku is told to leave it out and a bullet of the same area goes. A note `for:` a
commit an older row already told decorates that row in place instead: a picture can come
later without telling the change twice. The repo is public, so a note's picture shows staged
data only (docs/changes/README.md).

Best-effort throughout: boot() never blocks start-up — everything after recording
HEAD runs in a daemon thread that prints and never raises.
"""

import json
import os
import re
import sys
import threading
import time

from bridge import aifeatures, config, git, native, notices, runner, selfupdate, store

_LAST_HEAD = "last_head"
_BULLET = 140   # the prompt asks for under 100; haiku overshoots a little, so keep those whole
_HEADLINE = 64  # the prompt asks for 40; the changelog wraps, so only a runaway is cut
_RETRY_S = 7 * 86400   # a fallback row older than this keeps its words
_LEGACY = re.compile(r"\d+ commits? pulled")   # a fallback written before meta["ai"]
_BODY = 600           # notices keeps a row's body to this: the bullets that fit
CHANGES_DIR = "docs/changes"
# A change note's picture: <slug>.webp|png|jpg (a still, a clip's poster too) and <slug>.mp4 (a clip).
MEDIA_TYPES = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4"}
MEDIA_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\.(?:webp|png|jpg|mp4)")
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_SHA = re.compile(r"[0-9a-f]{7,40}")
_COMING_EVERY = 3600   # a waiting update that grows is written again at most hourly
_WATCH_S = 3600        # the bridge's own look upstream, for an install with no dashboard open
_lock = threading.Lock()
_writing = False       # one preview at a time: two polls must not write two rows

# Tagged so the throwaway session stays out of the sessions list (native.scan).
# Where a change can be seen in the dashboard: the changelog's Open › (Settings tabs and
# right-rail tabs, lib/theme.ts RIGHT_TABS). The hints are what the prompt shows haiku.
PLACES = {
    "settings:appearance": "theme, colours, typeface, loading screen",
    "settings:transcript": "chat layout, composer, working indicator",
    "settings:notifications": "pop-ups, sounds, quiet hours",
    "settings:projects": "repos, their names, logos and profiles",
    "settings:aimgmt": "logins, profiles, skills, MCP servers",
    "settings:integrations": "Rivendell, Claude Design",
    "settings:system": "the bridge itself, updates",
    "settings:move": "export and import to another machine",
    "rail:files": "the session's changed files",
    "rail:git": "branches, push and pull",
    "rail:rivendell": "Rivendell tasks and jobs",
    "rail:team": "teammates and shared sessions",
    "rail:usage": "usage limits",
}
_PROMPT = (
    native.INTERNAL_ONESHOT_TAG + "\n"
    "Below are the commit subjects of an update to Mystical, a tool that runs Claude Code "
    "from a dashboard, a Telegram bot and a Mini App. Write release notes for the person getting "
    "the update — not a developer. Respond with ONLY compact JSON, no markdown "
    "and no prose: {\"headline\": str, \"bullets\": [str], \"go\": [str or null], \"rest\": int}. "
    "headline: at most 40 characters naming the two or three biggest things, no trailing period. "
    "bullets: up to five, biggest first, each `Lead — what it does for them`, the lead at most "
    "three words and the whole bullet under 100 characters; fold fixes and chores into rest, the "
    "count of commits the bullets leave out. go: one per bullet, the place in the dashboard where "
    "they would see that change, or null when there isn't one: "
    + "; ".join(f"{k} ({v})" for k, v in PLACES.items()) + ". "
    "Plain words: no shas, no file names, no commit jargon."
    "\n\nCOMMITS:\n"
)
_GITHUB = re.compile(r"github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?/?$")


# --- boot: the range since the last boot ----------------------------------------------

def boot() -> "threading.Thread | None":
    """Record HEAD; when it moved on from the last boot's, announce the range
    off-thread (the thread is returned so a test can join it). A first boot
    announces the last day's commits instead, so the changelog doesn't open empty
    until the next update. An unmoved HEAD, or an old HEAD that isn't an ancestor
    (a branch switch in a dev checkout), says nothing."""
    repo = selfupdate.REPO
    head = git.head_sha(repo)
    if not head:
        return None
    old = store.get_setting(_LAST_HEAD)
    store.set_setting(_LAST_HEAD, head)
    if not old:
        old = git._run(repo, "rev-list", "-1", "--before=1 day ago", head)[1].strip()
    if not old or old == head:
        return None
    if git._run(repo, "merge-base", "--is-ancestor", old, head)[0] != 0:
        return None
    t = threading.Thread(target=_announce, args=(old, head), daemon=True)
    t.start()
    return t


def _announce(old: str, head: str) -> None:
    """The changelog: a one-shot, ~30 s, unless the preview of this very range already
    wrote it."""
    try:
        row = notices.coming()
        m = row["meta"] if row else {}
        if row and _holds(head, m.get("to")):
            notices.drop(row["id"])
        # a note for a change an older row told goes onto that row; the rest are this update's
        fresh = [c for c in changes_in(old, head) if not (c["for"] and _decorate(c))]
        # the model's words for this very range, written before the pull; a fallback says "waiting"
        cl = (_changelog(old, head, told=[c["area"] for c in fresh])
              if not m.get("ai") or (m.get("from"), m.get("to")) != (old, head) else
              {"headline": row["title"], "bullets": row["body"].split("\n"), "rest": m.get("rest", 0),
               "commits": m.get("commits", 0), "branch": m.get("branch", ""), "url": m.get("url"),
               "go": m.get("go"), "ai": True})
        if cl:
            cl = _with_changes(cl, fresh)
            notices.emit("updated", f"update:{head}", title=cl["headline"],
                         body="\n".join(cl["bullets"]),
                         meta={"from": old, "to": head, "commits": cl["commits"],
                               "branch": cl["branch"], "rest": cl["rest"], "url": cl["url"], "ai": cl["ai"],
                               **_aligned(cl)})
            _telegram("updated", "\n".join([f"UPDATED · {cl['headline']}"]
                                           + [f"• {b}" for b in cl["bullets"]]))
    except Exception as e:  # noqa: BLE001 — a changelog must never take the bridge down
        print(f"[whatsnew] {e}", file=sys.stderr)


# --- preview: the update waiting upstream, before it is taken -------------------------

def preview(info: dict) -> "threading.Thread | None":
    """What the update waiting upstream brings (selfupdate.check()'s answer in: its
    fetch is the one this reads). One `coming` row at a time: written when the bridge
    first sees commits upstream, so it pops; rewritten in place at most hourly as more
    land; dropped once nothing waits, unless HEAD already holds it (pulled, its restart
    still to come, whose boot turns it into the UPDATED row). The summary runs off-thread,
    returned so a test can join it; None when there is nothing to write."""
    try:
        return _preview(info)
    except Exception as e:  # noqa: BLE001 — UPDATE's poll answers whatever this does
        print(f"[whatsnew] preview: {e}", file=sys.stderr)
        return None


def _preview(info: dict) -> "threading.Thread | None":
    global _writing
    if not info.get("repo"):
        return None
    repo = selfupdate.REPO
    head = git.head_sha(repo)
    rc, out, _ = git._run(repo, "rev-parse", "-q", "--verify", "@{u}")
    up = out.strip() if rc == 0 else ""
    # counted here, not taken from check(): a read that failed must not pass for "nothing waits"
    rc, out, _ = git._run(repo, "rev-list", "--count", "--no-merges", f"{head}..{up}") if head and up else (1, "", "")
    if rc != 0:
        return None   # no upstream, or git didn't answer: nothing to say, nothing dropped on a guess
    n = int(out.strip() or 0)
    row = notices.coming()
    m = row["meta"] if row else {}
    if not n:
        # done, unless pulled with the code running still older: that restart's boot takes its words
        running = store.get_setting(_LAST_HEAD) or ""
        if row and not (_holds(head, m.get("to")) and not _holds(running, m.get("to"))):
            notices.drop(row["id"])
        return None
    # what waits, not HEAD: a dev checkout's own commits move HEAD and change nothing incoming
    if row and ((m.get("to"), m.get("commits")) == (up, n)
                or time.time() - float(m.get("written") or 0) < _COMING_EVERY):
        return None
    with _lock:
        if _writing:
            return None
        _writing = True
    t = threading.Thread(target=_write_coming, args=(head, up, row["id"] if row else None), daemon=True)
    t.start()
    return t


def _write_coming(head: str, up: str, nid: "int | None") -> None:
    global _writing
    try:
        # shortcut: no pictures until pulled (the media route serves this checkout's files), upgrade to
        # `git show up:<file>` if a waiting picture is ever wanted; a note for an older change waits for the boot
        changes = [{**c, "media": None} for c in changes_in(head, up) if not c["for"]]
        cl = _changelog(head, up, "waiting", told=[c["area"] for c in changes])
        if not cl:
            return
        cl = _with_changes(cl, changes)
        body = "\n".join(cl["bullets"])
        meta = {"from": head, "to": up, "commits": cl["commits"], "branch": cl["branch"], "rest": cl["rest"],
                "url": cl["url"], "ai": cl["ai"], "written": time.time(), **_aligned(cl)}
        if nid and notices.revise(nid, title=cl["headline"], body=body, meta=meta):
            return
        notices.emit("coming", "coming", title=cl["headline"], body=body, meta=meta)
        _telegram("coming", "\n".join([f"UPDATE READY · {cl['headline']}"] + [f"• {b}" for b in cl["bullets"]]
                                      + ["↓ UPDATE on the dashboard pulls it"]))
    except Exception as e:  # noqa: BLE001 — a preview must never take the bridge down
        print(f"[whatsnew] preview: {e}", file=sys.stderr)
    finally:
        with _lock:
            _writing = False


def _holds(head: str, sha: "str | None") -> bool:
    """HEAD already has this commit: pulled, the restart still to come."""
    return bool(head and sha) and git._run(selfupdate.REPO, "merge-base", "--is-ancestor", sha, head)[0] == 0


def _aligned(cl: dict) -> dict:
    """A row's per-bullet columns for its meta: `go` (a place), `when` (the state it shows in)
    and `media` (a note's picture), each only when some bullet has one."""
    return {k: cl[k] for k in ("go", "when", "media") if any(cl.get(k) or [])}


def retry() -> None:
    """Ask haiku again for the newest UPDATED row of the last week that holds the
    fallback (meta ai false, or a "N commits pulled" row from before that mark), and
    rewrite it in place: same id, time and read mark. One call a tick at most, so a
    week of rows the switch was off for doesn't spend ten at once; a refusal waits
    for the next tick, since a login at its limit refuses them all."""
    if not aifeatures.enabled("changelog"):
        return
    for row in store.list_notices(time.time() - _RETRY_S, 10, ("updated",)):
        m = row["meta"]
        if m.get("ai") is not False and ("ai" in m or not _LEGACY.fullmatch(row["title"] or "")):
            continue
        n, subjects = _subjects(m["from"], m["to"]) if m.get("from") and m.get("to") else (0, [])
        if not n:
            continue   # the range is gone (history rewritten): nothing to say, the next row may have one
        notes = _notes_of(row)
        said = _summarise(subjects, n, [c["area"] for c in notes])
        if said:
            said = _with_changes(said, notes)
            notices.revise(row["id"], title=said["headline"], body="\n".join(said["bullets"]),
                           meta={**{k: v for k, v in m.items() if k not in ("go", "when", "media")},
                                 "rest": said["rest"], "ai": True, **_aligned(said)})
        return


def watch() -> None:
    """The bridge's own look upstream: a dashboard's UPDATE poll does the same every
    5 min, but an install with no dashboard open would never hear of an update. The
    same tick asks again for any changelog row the one-shot couldn't write (`retry`)."""
    def loop() -> None:
        wait = 300   # soon after boot first: what waited while the bridge was down
        while True:
            time.sleep(wait)
            wait = _WATCH_S
            try:
                preview(selfupdate.check())
            except Exception as e:  # noqa: BLE001 — the next hour tries again
                print(f"[whatsnew] watch: {e}", file=sys.stderr)
            try:
                retry()
            except Exception as e:  # noqa: BLE001 — the next hour tries again
                print(f"[whatsnew] retry: {e}", file=sys.stderr)
    threading.Thread(target=loop, daemon=True, name="whatsnew-watch").start()


def _subjects(old: str, head: str) -> "tuple[int, list]":
    """The range's commit count and up to 80 subjects, newest first, merges left out."""
    repo = selfupdate.REPO
    rc, out, _ = git._run(repo, "rev-list", "--count", "--no-merges", f"{old}..{head}")
    n = int(out.strip() or 0) if rc == 0 else 0
    if n <= 0:
        return 0, []
    _rc, log, _ = git._run(repo, "log", "-80", "--no-merges", "--format=%s", f"{old}..{head}")
    return n, [s for s in log.splitlines() if s.strip()]


def _changelog(old: str, head: str, word: str = "pulled", told: "list | tuple" = ()) -> "dict | None":
    repo = selfupdate.REPO
    n, subjects = _subjects(old, head)
    if n <= 0:
        return None
    said = _summarise(subjects, n, told) if aifeatures.enabled("changelog") else None
    d = said or _fallback(subjects, n, word)
    d.update(commits=n, branch=git.current_branch(repo), url=_compare_url(old, head), ai=bool(said))
    return d


# nothing for the person updating
_SKIP = {"docs", "doc", "test", "tests", "chore", "ci", "build", "style"}
_TYPES = {"feat", "fix", "perf", "refactor", "revert"}                       # a kind, not a place: its scope leads
_AREA = re.compile(r"(?P<area>[A-Za-z][\w .&/-]{0,23}?)(?:\((?P<scope>[^)]{1,24})\))?!?: (?P<text>.+)")


def _lead(subject: str) -> "tuple[str, str] | None":
    """A subject's first clause as (lead, text): `area: text` → ("Area", "text"), a
    conventional type gives way to its scope, and a docs/test/chore commit says nothing."""
    s = subject.split(" — ", 1)[0].strip()
    m = _AREA.fullmatch(s)
    if not m:
        return "", s[:1].upper() + s[1:]
    area, text = m["area"].strip(), m["text"].strip()
    if area.lower() in _SKIP:
        return None
    if area.lower() in _TYPES:
        area = (m["scope"] or "").strip()
    return area[:1].upper() + area[1:], text if area else text[:1].upper() + text[1:]


def _fallback(subjects: list, n: int, word: str = "pulled") -> dict:
    """Off, or the one-shot failed: up to five subjects, read like notes. One per area
    first, so a busy area doesn't hide the rest, then the next ones in order; the headline
    names the areas. Chores alone fall back to the bare first clauses — nothing is lost."""
    said = [x for x in map(_lead, subjects) if x]
    if not said:
        bullets = [_cut(s.split(" — ", 1)[0], _BULLET) for s in subjects[:5]]
        return {"headline": f"{n} commit{'' if n == 1 else 's'} {word}", "bullets": bullets, "rest": n - len(bullets)}
    keys = [lead.lower() or text for lead, text in said]
    first = [i for i, k in enumerate(keys) if k not in keys[:i]]
    pick = sorted((first + [i for i in range(len(said)) if i not in first])[:5])
    bullets = [_cut(f"{said[i][0]} — {said[i][1]}" if said[i][0] else said[i][1], _BULLET) for i in pick]
    leads = list(dict.fromkeys(said[i][0] for i in pick if said[i][0]))
    headline = (f"{n} commit{'' if n == 1 else 's'} {word}" if not leads
                else f"{leads[0]} updates" if len(leads) == 1
                else f"{leads[0]} and {leads[1]}" if len(leads) == 2
                else ", ".join(leads[:3]) + (" and more" if len(leads) > 3 else ""))
    return {"headline": _cut(headline, _HEADLINE), "bullets": bullets, "rest": n - len(bullets)}


def _summarise(subjects: list, n: int, told: "list | tuple" = ()) -> "dict | None":
    """One haiku call over the subjects → {headline, bullets, rest}, cut to the
    spec's limits; None when the reply is an error or not the JSON asked for.
    `told`: the areas change notes already tell, for the model to leave out."""
    prompt = _PROMPT + "\n".join(subjects) + (f"\n\nALREADY TOLD, leave out: {'; '.join(told)}" if told else "")
    result, _sid, _cost, is_error = runner.run_blocking(
        config.DASH_CHAT_ID, prompt, cwd=selfupdate.REPO,
        timeout=180, model="haiku", skip_pack=True)
    text = "" if is_error else (result or "")
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        raw = json.loads(text[a:b + 1])
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    headline = _cut(str(raw.get("headline") or ""), _HEADLINE)
    items = raw.get("bullets") if isinstance(raw.get("bullets"), list) else []
    go = raw.get("go") if isinstance(raw.get("go"), list) else []
    kept = [(_cut(str(x), _BULLET), go[i] if i < len(go) and go[i] in PLACES else None)
            for i, x in enumerate(items) if str(x).strip()][:5]
    bullets = [b for b, _ in kept]
    if not headline or not bullets:
        return None
    rest = raw.get("rest")
    if isinstance(rest, bool) or not isinstance(rest, int) or rest < 0:
        rest = max(0, n - len(bullets))
    return {"headline": headline, "bullets": bullets, "rest": rest, "go": [g for _, g in kept]}


def _cut(s: str, n: int) -> str:
    """At most n characters, ending on a whole word and "…" when it had to cut:
    a slice mid-word printed "…Nyan Cat, and Or" in the changelog."""
    s = s.strip()
    if len(s) <= n:
        return s
    head = s[:n - 1]
    at = head.rfind(" ")
    return (head[:at] if at > 0 else head).rstrip(" ,;:—-") + "…"


def _compare_url(old: str, head: str) -> "str | None":
    rc, out, _ = git._run(selfupdate.REPO, "remote", "get-url", "origin")
    m = _GITHUB.search(out.strip()) if rc == 0 else None
    return f"https://github.com/{m.group(1)}/compare/{old[:7]}...{head[:7]}" if m else None


def _telegram(kind: str, text: str) -> None:
    """The group's Telegram route, as the weekly report sends: every allowed chat."""
    try:
        if not notices.telegram_ok(kind):
            return
        from bridge.telegram import send   # lazy: the bot is the heavy half
        for chat in config.ALLOWED_CHAT_IDS:
            send(chat, text, silent=True)   # news, not an ask: no ring
    except Exception as e:  # noqa: BLE001
        print(f"[whatsnew] telegram: {e}", file=sys.stderr)


# --- change notes: docs/changes/<slug>.md ----------------------------------------------

def change_note(text: str) -> "dict | None":
    """A change note: `key: value` lines between `---` fences (area, when, place, for), then
    its sentence. No area or no sentence is no note; a place outside PLACES and a `for`
    that isn't a sha are dropped, so a note never links somewhere the dashboard lacks."""
    lines = [l.strip() for l in (text or "").strip().splitlines()]
    if len(lines) < 2 or lines[0] != "---" or "---" not in lines[1:]:
        return None
    end = lines.index("---", 1)
    keys = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:end])}
    said = " ".join(l for l in lines[end + 1:] if l)
    if not keys.get("area") or not said:
        return None
    sha = keys.get("for", "").lower()
    return {"area": keys["area"], "text": said, "when": keys.get("when") or None,
            "place": keys.get("place") if keys.get("place") in PLACES else None,
            "for": sha if _SHA.fullmatch(sha) else None}


def changes_in(old: str, head: str) -> list:
    """The change notes added in old..head, in path order, each with its picture at head:
    {area, text, when, place, for, media: {still, clip} or None}."""
    repo = selfupdate.REPO
    rc, added, _ = git._run(repo, "diff", "--name-only", "--diff-filter=A", old, head, "--", CHANGES_DIR)
    rc2, tree, _ = git._run(repo, "ls-tree", "--name-only", head, CHANGES_DIR + "/")
    if rc != 0 or rc2 != 0:
        return []
    have = {os.path.basename(p) for p in tree.splitlines()}
    out = []
    for path in added.splitlines():
        slug, ext = os.path.splitext(os.path.basename(path))
        c = change_note(git.file_at(repo, head, path)) if ext == ".md" and _SLUG.fullmatch(slug) else None
        if c:
            still = next((slug + e for e in (".webp", ".png", ".jpg") if slug + e in have), None)
            clip = slug + ".mp4" if slug + ".mp4" in have else None
            out.append({**c, "media": {"still": still, "clip": clip} if still or clip else None})
    return out


def _key(area: str) -> str:
    return re.sub(r"[^a-z0-9]", "", area.lower())


def _area(bullet: str) -> str:
    return bullet.split(" — ", 1)[0] if " — " in bullet else ""


def _with_changes(cl: dict, notes: list) -> dict:
    """The notes first, in their own words with their place, state and picture, then the
    summary's bullets about anything else: as many as fit the row's body."""
    if not notes:
        return cl
    told = {_key(c["area"]) for c in notes}
    go = cl.get("go") or []
    rows = ([(_cut(f"{c['area']} — {c['text']}", _BULLET), c["place"], c["when"], c["media"]) for c in notes]
            + [(b, go[i] if i < len(go) else None, None, None) for i, b in enumerate(cl["bullets"])
               if _key(_area(b)) not in told or not _area(b)])
    kept: list = []
    for r in rows:
        if len("\n".join([k[0] for k in kept] + [r[0]])) > _BODY:
            break
        kept.append(r)
    return {**cl, **{k: [r[i] for r in kept] for i, k in enumerate(("bullets", "go", "when", "media"))}}


def _decorate(c: dict) -> bool:
    """A note for a change an older row already told (`for:` one of its commits): that row's
    bullet of the same area takes the note's words, place, state and picture, or the note
    joins the row. Revised in place, so a picture that comes later is not news again."""
    for row in store.list_notices(0, 50, ("updated",)):
        m = row["meta"]
        if not (m.get("from") and m.get("to")) or not _holds(m["to"], c["for"]) or _holds(m["from"], c["for"]):
            continue
        bullets = [b for b in row["body"].split("\n") if b]
        n = len(bullets)
        cols = {k: ((m.get(k) if isinstance(m.get(k), list) else []) + [None] * n)[:n] for k in ("go", "when", "media")}
        i = next((j for j, b in enumerate(bullets) if _area(b) and _key(_area(b)) == _key(c["area"])), n)
        line = _cut(f"{c['area']} — {c['text']}", _BULLET)
        if i == n:
            bullets.append(line)
            for col in cols.values():
                col.append(None)
        else:
            bullets[i] = line
        # the note's words are the change's, its place too: none drops the model's guess
        cols["go"][i], cols["when"][i], cols["media"][i] = c["place"], c["when"], c["media"]
        body = "\n".join(bullets)
        if len(body) > _BODY:
            return False
        meta = {**{k: v for k, v in m.items() if k not in cols}, **_aligned(cols)}
        return notices.revise(row["id"], title=row["title"], body=body, meta=meta)
    return False


def _notes_of(row: dict) -> list:
    """A row's bullets that came from notes, as notes again, so a rewrite keeps their words
    first: a state or a picture marks one, and so does a place, since retry() only rewrites
    fallback rows and the fallback never names a place."""
    m = row["meta"]
    bullets = [b for b in row["body"].split("\n") if b]
    col = {k: (m.get(k) if isinstance(m.get(k), list) else []) + [None] * len(bullets) for k in ("go", "when", "media")}
    return [{"area": _area(b), "text": b.split(" — ", 1)[1], "place": col["go"][i], "when": col["when"][i],
             "media": col["media"][i]} for i, b in enumerate(bullets) if _area(b) and (col["when"][i] or col["media"][i] or col["go"][i])]
