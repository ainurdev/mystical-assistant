"""What changed in Mystical, told in the changelog (the scroll above UPDATE on the
dashboard's right rail): a row each install writes at boot from the commits that
landed, and a note row for each heading a maintainer added to docs/notes.md
(docs/superpowers/specs/notif-updates.md). Both pop like any news when they land.

Why each install writes its own row rather than reading a committed CHANGELOG:
the range is known only here (`last_head` → HEAD), every path that moves the
checkout — the UPDATE button, `mystical update`, a hand pull and a restart —
passes through boot, and nobody has to remember to write an entry at merge time.
The cost is one haiku call per restart that found new commits, behind the UPDATE
NOTES switch; off, the row lists the commit subjects instead.

Why a note's heading is its identity: the file is diffed between the old and the
new HEAD, so an edit to a note's body tells nobody again and a changed heading is
a new note. `notes_seen` remembers what this install already showed, because the
feed forgets after a week.

Why the waiting update is told too (`preview`): the summary above lands only after
PULL & RESTART, so nobody could see what an update brought before taking it, and a
note could warn no one. So the bridge looks upstream (each dashboard's UPDATE poll,
plus an hourly `watch` of its own so an install with no dashboard open hears it on
Telegram) and writes `HEAD..@{u}` into one `coming` row, with the notes added in that
range. It is news once; as more commits land it is rewritten in place at most hourly,
so a busy upstream costs a call an hour, not one a push. The boot after the pull takes
that row's words for its UPDATED row when the ranges match: the one-shot moved earlier
instead of doubling, and a note the preview showed lands without a second pop.

Why SEND NOTE pushes: a local commit on master would make every later PULL &
RESTART (`--ff-only`) fail on an install that cannot push, so a refused push is
rolled back and nothing is left behind.

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

NOTES_PATH = "docs/notes.md"
NOTES_HEADER = (
    "# Notes for every install\n\n"
    "A heading per note. Each lands in the changelog of every Mystical that pulls it\n"
    "(bridge/whatsnew.py). Write one from the changelog, or by hand in this shape.\n"
)
_LAST_HEAD = "last_head"
_SEEN = "notes_seen"
_SEEN_MAX = 200
_BULLET = 140   # the prompt asks for under 100; haiku overshoots a little, so keep those whole
_COMING_EVERY = 3600   # a waiting update that grows is written again at most hourly
_WATCH_S = 3600        # the bridge's own look upstream, for an install with no dashboard open
_lock = threading.Lock()
_writing = False       # one preview at a time: two polls must not write two rows

# Tagged so the throwaway session stays out of the sessions list (native.scan).
_PROMPT = (
    native.INTERNAL_ONESHOT_TAG + "\n"
    "Below are the commit subjects of an update to Mystical, a tool that runs Claude Code "
    "from a dashboard, a Telegram bot and a Mini App. Write release notes for the person getting "
    "the update — not a developer. Respond with ONLY compact JSON, no markdown "
    "and no prose: {\"headline\": str, \"bullets\": [str], \"rest\": int}. headline: at most "
    "40 characters naming the two or three biggest things, no trailing period. bullets: up to "
    "five, biggest first, each `Lead — what it does for them`, the lead at most three words "
    "and the whole bullet under 100 characters; fold fixes and chores into rest, the count of "
    "commits the bullets leave out. Plain words: no shas, no file names, no commit jargon."
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
    """Notes first (cheap), then the changelog: a one-shot, ~30 s, unless the preview
    of this very range already wrote it."""
    repo = selfupdate.REPO
    try:
        row = notices.coming()
        m = row["meta"] if row else {}
        shown = {n.get("heading") for n in m.get("notes") or [] if isinstance(n, dict)}
        seen = _seen()
        before = {e["heading"] for e in notes_in(git.file_at(repo, old, NOTES_PATH))}
        for e in notes_in(git.file_at(repo, head, NOTES_PATH)):
            if e["heading"] in before or e["heading"] in seen:
                continue
            quiet = e["heading"] in shown   # read before the pull, in the preview: no second pop
            notices.emit("note", f"note:{e['heading']}", title=e["title"], body=e["body"],
                         meta={"author": e["author"], "date": e["date"], **({"quiet": True} if quiet else {})})
            seen.append(e["heading"])
            if not quiet:
                _telegram("note", f"NOTE · {e['title']}\n{e['body']}".rstrip())
        _remember(seen)
        if row and _holds(head, m.get("to")):
            notices.drop(row["id"])
        # the model's words for this very range, written before the pull; a fallback says "waiting"
        cl = (_changelog(old, head) if not m.get("ai") or (m.get("from"), m.get("to")) != (old, head) else
              {"headline": row["title"], "bullets": row["body"].split("\n"), "rest": m.get("rest", 0),
               "commits": m.get("commits", 0), "branch": m.get("branch", ""), "url": m.get("url")})
        if cl:
            notices.emit("updated", f"update:{head}", title=cl["headline"],
                         body="\n".join(cl["bullets"]),
                         meta={"from": old, "to": head, "commits": cl["commits"],
                               "branch": cl["branch"], "rest": cl["rest"], "url": cl["url"]})
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
    repo = selfupdate.REPO
    try:
        cl = _changelog(head, up, "waiting")
        if not cl:
            return
        before = {e["heading"] for e in notes_in(git.file_at(repo, head, NOTES_PATH))} | set(_seen())
        notes = [{k: e[k] for k in ("heading", "title", "body", "author")}
                 for e in notes_in(git.file_at(repo, up, NOTES_PATH)) if e["heading"] not in before][:3]
        body = "\n".join(cl["bullets"])
        meta = {"from": head, "to": up, "commits": cl["commits"], "branch": cl["branch"], "rest": cl["rest"],
                "url": cl["url"], "notes": notes, "ai": cl["ai"], "written": time.time()}
        if nid and notices.revise(nid, title=cl["headline"], body=body, meta=meta):
            return
        notices.emit("coming", "coming", title=cl["headline"], body=body, meta=meta)
        _telegram("coming", "\n".join([f"UPDATE READY · {cl['headline']}"] + [f"• {b}" for b in cl["bullets"]]
                                      + [f"NOTE · {n['title']}" for n in notes]
                                      + ["↓ UPDATE on the dashboard pulls it"]))
    except Exception as e:  # noqa: BLE001 — a preview must never take the bridge down
        print(f"[whatsnew] preview: {e}", file=sys.stderr)
    finally:
        with _lock:
            _writing = False


def _holds(head: str, sha: "str | None") -> bool:
    """HEAD already has this commit: pulled, the restart still to come."""
    return bool(head and sha) and git._run(selfupdate.REPO, "merge-base", "--is-ancestor", sha, head)[0] == 0


def watch() -> None:
    """The bridge's own look upstream: a dashboard's UPDATE poll does the same every
    5 min, but an install with no dashboard open would never hear of an update."""
    def loop() -> None:
        wait = 300   # soon after boot first: what waited while the bridge was down
        while True:
            time.sleep(wait)
            wait = _WATCH_S
            try:
                preview(selfupdate.check())
            except Exception as e:  # noqa: BLE001 — the next hour tries again
                print(f"[whatsnew] watch: {e}", file=sys.stderr)
    threading.Thread(target=loop, daemon=True, name="whatsnew-watch").start()


def _seen() -> list:
    try:
        raw = json.loads(store.get_setting(_SEEN) or "[]")
    except ValueError:
        raw = []
    return [str(h) for h in raw] if isinstance(raw, list) else []


def _remember(seen: list) -> None:
    store.set_setting(_SEEN, json.dumps(seen[-_SEEN_MAX:]))


def _changelog(old: str, head: str, word: str = "pulled") -> "dict | None":
    repo = selfupdate.REPO
    rc, out, _ = git._run(repo, "rev-list", "--count", "--no-merges", f"{old}..{head}")
    n = int(out.strip() or 0) if rc == 0 else 0
    if n <= 0:
        return None
    _rc, log, _ = git._run(repo, "log", "-80", "--no-merges", "--format=%s", f"{old}..{head}")
    subjects = [s for s in log.splitlines() if s.strip()]
    said = _summarise(subjects, n) if aifeatures.enabled("changelog") else None
    d = said or _fallback(subjects, n, word)
    d.update(commits=n, branch=git.current_branch(repo), url=_compare_url(old, head), ai=bool(said))
    return d


def _fallback(subjects: list, n: int, word: str = "pulled") -> dict:
    """Off, or the one-shot failed: the first clause of up to five subjects. The one
    path that does echo commits — nothing is lost, only shorter."""
    bullets = [_cut(s.split(" — ", 1)[0], _BULLET) for s in subjects[:5]]
    return {"headline": f"{n} commit{'' if n == 1 else 's'} {word}",
            "bullets": bullets, "rest": n - len(bullets)}


def _summarise(subjects: list, n: int) -> "dict | None":
    """One haiku call over the subjects → {headline, bullets, rest}, cut to the
    spec's limits; None when the reply is an error or not the JSON asked for."""
    result, _sid, _cost, is_error = runner.run_blocking(
        config.DASH_CHAT_ID, _PROMPT + "\n".join(subjects), cwd=selfupdate.REPO,
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
    headline = _cut(str(raw.get("headline") or ""), 40)
    items = raw.get("bullets") if isinstance(raw.get("bullets"), list) else []
    bullets = [_cut(str(x), _BULLET) for x in items if str(x).strip()][:5]
    if not headline or not bullets:
        return None
    rest = raw.get("rest")
    if isinstance(rest, bool) or not isinstance(rest, int) or rest < 0:
        rest = max(0, n - len(bullets))
    return {"headline": headline, "bullets": bullets, "rest": rest}


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


# --- a maintainer's note: write, commit that file, push — or roll back ------------------

def add_note(title: str, body: str) -> "tuple[bool, str]":
    """Append the note to docs/notes.md, commit only that file and push: one tap,
    like SHIP. The commit or the push refused: put the file back as it was (a hand
    edit included), drop the commit, return git's words — nothing is left behind.
    The caller validates lengths; here only line endings and whitespace are tidied."""
    repo = selfupdate.REPO
    path = os.path.join(repo, NOTES_PATH)
    title = title.strip()
    body = body.replace("\r\n", "\n").strip()
    # A line that starts "## " would read as the next note on every other install:
    # the file gets it behind a space, which notes_in takes off again.
    escaped = "\n".join(" " + l if l.startswith("## ") else l for l in body.split("\n"))
    author = git._run(repo, "config", "user.name")[1].strip()
    date = time.strftime("%Y-%m-%d")
    heading = f"{date} · {title}" + (f" — {author}" if author else "")
    before = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            before = f.read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write((before or NOTES_HEADER) + f"\n## {heading}\n" + (f"\n{escaped}\n" if escaped else ""))
    ok, out = git.commit_paths(repo, f"note: {title}", [NOTES_PATH])
    committed = ok
    if ok:
        ok, out = git.push(repo)
    if not ok:
        if committed:
            git._run(repo, "reset", "-q", "--soft", "HEAD~1")
        git._run(repo, "reset", "-q", "HEAD", "--", NOTES_PATH)
        # shortcut: a hand edit that was already staged comes back unstaged, upgrade if anyone stages notes by hand
        if before is None:
            os.remove(path)
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(before)
        return False, out
    nid = notices.emit("note", f"note:{heading}", title=title, body=body,
                       meta={"author": author, "date": date, "quiet": True})
    if nid:
        notices.mark_read([nid])   # your own note is not news to you
    seen = _seen()
    seen.append(heading)
    _remember(seen)
    return True, out


# --- the notes file ---------------------------------------------------------------------

# `## 2026-10-18 · Title — Author`; the author is optional and never holds an em
# dash, so the LAST ` — ` splits and a title keeps its own. Anything else under a
# `## ` is a hand-written heading: the title whole, no date, no author.
_HEADING = re.compile(r"^(\d{4}-\d{2}-\d{2}) · (.+?)(?: — ([^—]+))?$")


def notes_in(text: str) -> list:
    """The entries of docs/notes.md, in file order: {heading, date, title, author,
    body}. The heading line (without `## `) is the note's identity; the body is
    everything up to the next entry, stripped."""
    out: list = []
    for line in text.splitlines():
        if line.startswith("## "):
            heading = line[3:].strip()
            if not heading:
                continue   # a bare `## ` is nobody's note
            # shortcut: two notes with the same heading on one day are one note, upgrade to an id line if it ever happens
            m = _HEADING.match(heading)
            out.append({"heading": heading, "date": m.group(1) if m else "",
                        "title": (m.group(2) if m else heading).strip(),
                        "author": (m.group(3) or "").strip() if m else "", "body": ""})
        elif out:
            out[-1]["body"] += (line[1:] if line.startswith(" ## ") else line) + "\n"
    for e in out:
        e["body"] = e["body"].strip()
    return out
