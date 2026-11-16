"""The feature branch a skill path builds on.

No automatic step may build on the default branch. When a path reaches BUILD,
ensure_feature_branch finds or makes `<type>/<short-name>` in its own worktree, and
carry_and_commit moves the flow's decisions (the grill's GLOSSARY.md and
docs/adr/*, the spec) there and commits them.

The branch is named for what is being built (GLOSSARY: Feature branch). The agent that
hands over to BUILD names it through StepDone (branch_name), because only it knows what
the work became: a session's title summarises its first message, so a name made from it
says how the session began (`feat/run-the-arda-project` held a globe prototype), was cut
mid-word, and filed every fix under feat/. The title is the fallback only (title_slug),
for a StepDone that named none and a BUILD whose grill is off. A name that exists is
joined, never given a -2: a flow that comes back to its feature goes on on its branch.

Only the files this flow's turns wrote move (flow_files), never the whole dirty
tree: the session's checkout may hold other sessions' half-done edits, and those
must stay exactly where they are. A stash carries them because it is the one
git primitive that moves chosen files, untracked ones included, between two
worktrees of one repo: the stash list is shared across them. That sharing is
also the hazard: a bare `stash pop` takes the newest entry, which may be someone
else's, so carry_and_commit pops only when its own push added an entry, and then
exactly that one, found by its commit id (indexes shift whenever anyone stashes).

A whole file is still too much when someone else's uncommitted edit sits in the
same file: a GLOSSARY.md another flow appended to rode along with this one (and
landed on the wrong feature branch). So a tracked file is carried by hunk: only the
hunks whose added lines all come from this flow's own writes (added_lines: Write,
Edit and MultiEdit inputs from the CLI transcript, and Bash heredocs redirected into
a file) move, as a patch applied in dst and reversed in src; a hunk nobody can tie to
the flow stays, with a log line. A file the flow wrote with Bash heredocs counts as
written too. A new file moves whole, as before.
"""

import os
import re
import subprocess
import sys

from bridge import git, store, taskcheck, transcript_jsonl


class FlowBranchError(Exception):
    """Files existed but could not be moved or committed; the message says why."""


def _log(msg: str) -> None:
    print(f"[flowbranch] {msg}", file=sys.stderr)


# What a feature branch's name opens with: the Conventional Commits types.
TYPES = ("feat", "fix", "refactor", "docs", "chore", "ci", "test", "perf", "build", "style", "revert")
# How a title opens when its first prompt went out as a command: "/design-first ...", which
# the titler words as "Design-First ...". That names how the session began, never the work.
# shortcut: unslashed, only the commands a flow's first prompt is sent as (paths.start_flow);
# add one here when a flow starts with another. A title about a command ("/status shows stale
# sessions") loses that word as well; keep a slashed word that isn't a skill's if that reads wrong.
_COMMAND = re.compile(r"\s*(?:/[\w:-]+(?=\s|$)\s*)?(?:(?:design-first|grill-with-docs|diagnosing-bugs|"
                      r"improve-codebase-architecture)\b[\s:-]*)?", re.I)


def short_name(text: str) -> str:
    """`text` as a branch's short name: branch-safe, 40 characters at most, cut at a whole
    word. "" when nothing valid is left."""
    s = git.cut_words(git._SLUG_RE.sub("-", text or "").strip("-"), 40)  # noqa: SLF001
    s = re.sub(r"\.{2,}", ".", s).strip(".-/")
    s = s.removesuffix(".lock").strip(".-/")
    ok = s and git._run(".", "check-ref-format", "--branch", f"feat/{s}")[0] == 0  # noqa: SLF001
    return s if ok else ""


def feature_slug(title: str) -> str:
    """A branch-safe slug from a session title or a ticket folder's name; "flow" when
    nothing valid is left.
    shortcut: every title that leaves nothing (no Latin letters or digits) gets "flow", so two
    such flows in one repo share feat/flow; add the session's id if that ever happens."""
    return short_name((title or "").lower()) or "flow"


def title_slug(title: str) -> str:
    """feature_slug of a session title, less the command it began with."""
    title = title or ""
    return feature_slug(title[_COMMAND.match(title).end():])


def branch_name(given: "str | None") -> "tuple[str, str] | None":
    """(type, short name) of the feature branch an agent named as `type/short-name`, or
    None when no usable name is left. A type outside TYPES, or none, is feat. The name is
    lower case but for a task's key, which stays as written (fix/NRA-61-login-redirect),
    and is one level deep: git can't hold both feat/ui and feat/ui/globe."""
    kind, sep, name = (given or "").strip().partition("/")
    if not sep:
        kind, name = "", kind
    parts = re.split(f"({taskcheck.key_re().pattern})", name)   # the keys are the odd ones
    name = short_name("".join(p if i % 2 else p.lower() for i, p in enumerate(parts)))
    return (kind.lower() if kind.lower() in TYPES else "feat", name) if name else None


_WRITES = ("Write", "Edit", "MultiEdit", "NotebookEdit")


def _checkout(session: dict) -> str:
    return session.get("work_cwd") or session.get("cwd") or ""


# `cat >> f <<'EOF'` / `cat > f <<EOF` / `tee [-a] f <<EOF`, body up to the closing word.
_HEREDOC = re.compile(r"(?:cat|tee(?:\s+-a)?)\s*>?>?\s*([^\s<>;&|'\"]+)\s*<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n(.*?)\n\2(?=\s|$)", re.S)
_CD = re.compile(r"^\s*cd\s+(['\"]?)([^'\"\s;&|]+)\1\s*&&")


def bash_writes(cmd: str, root: str) -> list[tuple[str, str]]:
    """(absolute path, body) of each heredoc the command writes into a file. A
    relative path is read from a leading `cd <dir> &&`, else from `root`.
    shortcut: heredocs only; a file a script edits (python, sed -i) isn't seen, so
    its hunks stay behind with a log line; parse those too if flows start using them."""
    m = _CD.match(cmd or "")
    base = os.path.expanduser(m.group(2)) if m else root
    out = []
    for path, _word, body in _HEREDOC.findall(cmd or ""):
        p = os.path.expanduser(path)
        out.append((os.path.normpath(p if os.path.isabs(p) else os.path.join(base, p)), body))
    return out


def _inside(root: str, p: str) -> bool:
    return bool(root) and os.path.isabs(p) and os.path.realpath(p).startswith(root + os.sep)


def written(session_id: str, since: int) -> list[str]:
    """Files the session's Write/Edit/MultiEdit/NotebookEdit calls touched since
    `since`, inside its checkout, in the order first written. Tool events keep the
    call's first input field as `summary` (cut at 120 chars, the whole text in
    `detail`), which for these tools is file_path. shortcut: NotebookEdit's
    notebook_path isn't a summary key, so notebooks are missed; add it if a flow
    ever writes one."""
    s = store.get_session(session_id) or {}
    root = os.path.realpath(_checkout(s))
    out: list[str] = []
    for ev in store.timed_events(session_id):
        if ev.get("type") != "tool" or ev.get("ts", 0) < since:
            continue
        if ev.get("name") == "Bash":
            ps = [p for p, _ in bash_writes(ev.get("detail") or ev.get("summary") or "", root)]
        elif ev.get("name") in _WRITES:
            ps = [ev.get("detail") or ev.get("summary") or ""]
        else:
            continue
        out += [p for p in ps if _inside(root, p) and p not in out]
    return out


def added_lines(session_id: str, since: int) -> "dict[str, set[str]] | None":
    """Per real path, the lines this flow's writes put in since `since`: Write
    content, Edit/MultiEdit new text (the CLI transcript keeps the inputs whole; the
    bridge's events cut them) and Bash heredoc bodies. None when the transcript can't
    be found, and the carry then moves whole files as it did before."""
    s = store.get_session(session_id) or {}
    path = transcript_jsonl.find_transcript(s.get("claude_session_id") or "")
    if not path:
        return None
    root = os.path.realpath(_checkout(s))
    out: dict[str, set[str]] = {}

    def add(p, text):
        if isinstance(p, str) and isinstance(text, str) and p:
            out.setdefault(os.path.realpath(p), set()).update(l for l in text.splitlines() if l.strip())

    import json
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") != "assistant" or transcript_jsonl._ts(rec) < since:  # noqa: SLF001
                continue
            for b in (rec.get("message") or {}).get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                inp, name = b.get("input") or {}, b.get("name")
                if name == "Write":
                    add(inp.get("file_path"), inp.get("content"))
                elif name == "Edit":
                    add(inp.get("file_path"), inp.get("new_string"))
                elif name == "MultiEdit":
                    for e in inp.get("edits") or []:
                        add(inp.get("file_path"), (e or {}).get("new_string"))
                elif name == "Bash":
                    for p, body in bash_writes(inp.get("command") or "", root):
                        add(p, body)
    return out


def flow_files(session_id: str, since: int) -> list[str]:
    """written(), less what git can't carry: the files a carry moves."""
    out = written(session_id, since)
    s = store.get_session(session_id) or {}
    root = os.path.realpath(_checkout(s))
    if out:   # git can't stash what it ignores (.mystical/, so the ticket files) or an untracked file gone again
        # quotePath=false, as git.py does: a C-quoted "caf\303\251" would never match (-z needs --stdin)
        ignored = set(git._run(root, "-c", "core.quotePath=false", "check-ignore", "--", *out)[1].splitlines())  # noqa: SLF001
        keep = []
        for p in out:
            if p in ignored:
                why = "ignored"
            elif not os.path.lexists(p) and git._run(root, "ls-files", "--error-unmatch", "--", p)[0] != 0:  # noqa: SLF001
                why = "missing"   # a tracked file gone again is a deletion, and is carried
            else:
                keep.append(p)
                continue
            _log(f"{p} stays out of the carry: {why}")
        out = keep
    return out


def ensure_feature_branch(session: dict, slug: str, prefix: str = "feat") -> tuple[str, str]:
    """(branch, checkout) BUILD works in. A linked worktree already on a non-default
    branch is used as is; otherwise `<prefix>/<slug>` gets its own worktree. A branch of
    that name is joined, one that differs only by case too (a Mac's disk holds one of the
    two); a prefix the repo has as a branch gives way to feat (git can't hold docs and docs/x)."""
    co = _checkout(session)
    main = git.main_checkout(co)
    default = git.default_branch(main)
    gd, cd = (git._run(co, "rev-parse", "--path-format=absolute", f)[1].strip()  # noqa: SLF001
              for f in ("--git-dir", "--git-common-dir"))
    if gd and gd != cd:   # a linked worktree; a detached HEAD there names no branch
        cur = git._run(co, "symbolic-ref", "-q", "--short", "HEAD")[1].strip()  # noqa: SLF001
        if cur and cur != default:
            return cur, co
    have = git.branches(main)
    branch = f"{'feat' if prefix in have else prefix}/{slug}"
    if branch not in have:
        branch = next((b for b in have if b.lower() == branch.lower()), branch)
    for w in git.worktrees(main):
        if w["branch"] == branch:
            return branch, w["path"]
    wt = git.worktree_path_for(main, branch, free=True)
    os.makedirs(os.path.dirname(wt), exist_ok=True)
    exists = branch in have
    ok, out = git.worktree_add(main, wt, branch, start="" if exists else "HEAD", create=not exists)
    if not ok:
        raise RuntimeError(f"feature worktree failed: {out}")
    git.copy_env(main, wt)
    return branch, wt


def _stash_shas(cwd: str) -> list[str]:
    """Commit ids of every stash entry (the list is shared by all worktrees)."""
    return git._run(cwd, "stash", "list", "--format=%H")[1].split()  # noqa: SLF001


def _ref_of(cwd: str, sha: str) -> str:
    """The stash@{n} that `sha` is at right now; indexes shift whenever anyone
    stashes, so a ref is never kept, only looked up when used."""
    shas = _stash_shas(cwd)
    return f"stash@{{{shas.index(sha)}}}" if sha in shas else ""


def _pop(cwd: str, sha: str) -> tuple[bool, str]:
    ref = _ref_of(cwd, sha)
    if not ref:
        return False, "the stash entry is gone"
    rc, _, err = git._run(cwd, "stash", "pop", ref, timeout=30)  # noqa: SLF001
    return rc == 0, err.strip()


def _hunks(diff: str) -> tuple[str, list[str]]:
    """(header, hunks) of a one-file `git diff -U0`."""
    parts = re.split(r"(?m)^(?=@@ )", diff)
    return parts[0], parts[1:]


def _apply(cwd: str, patch: str, *flags: str) -> tuple[bool, str]:
    p = subprocess.run(["git", "-C", cwd, "apply", "--unidiff-zero", *flags, "-"], input=patch,
                       capture_output=True, text=True, timeout=30)
    return p.returncode == 0, p.stderr.strip()


def _split(src: str, rel: list[str], ours: dict) -> tuple[list[str], dict]:
    """(files to move whole, {file: patch of only this flow's hunks}). A tracked file
    holding only this flow's hunks moves whole; one with someone else's hunks too gets
    a patch; one with none of the flow's stays."""
    whole, patched = [], {}
    for r in rel:
        diff = git._run(src, "-c", "core.quotePath=false", "diff", "-U0", "--no-color", "HEAD", "--", r)[1]  # noqa: SLF001
        if not diff.strip() or "\nBinary files" in diff:
            whole.append(r)   # untracked (a new file is the flow's whole) or nothing to split
            continue
        mine = ours.get(os.path.realpath(os.path.join(src, r)), set())
        head, hunks = _hunks(diff)
        keep = []
        for h in hunks:
            plus = [l[1:] for l in h.splitlines()[1:] if l.startswith("+") and l[1:].strip()]
            keep.append(bool(plus) and all(l in mine for l in plus))
        if all(keep):
            whole.append(r)
        elif not any(keep):
            _log(f"{r} stays out of the carry: none of its changes are this flow's")
        else:
            _log(f"{r}: carrying {sum(keep)} of {len(keep)} changes, the rest aren't this flow's")
            patched[r] = head + "".join(h for h, k in zip(hunks, keep) if k)
    return whole, patched


def _move_hunks(src: str, dst: str, patched: dict) -> None:
    """Apply each patch in dst, then take it out of src; undone in dst if src refuses."""
    for r, patch in patched.items():
        ok, err = _apply(dst, patch)
        if not ok:
            raise FlowBranchError(f"{r}: this flow's part didn't apply in {dst}: {err}")
        ok, err = _apply(src, patch, "-R")
        if not ok:
            _apply(dst, patch, "-R")
            raise FlowBranchError(f"{r}: this flow's part couldn't be taken out of {src}: {err}")


def carry_and_commit(src: str, dst: str, files: list[str], slug: str, message: str = "",
                     ours: "dict | None" = None) -> bool:
    """Move `files` from `src` to `dst` (stash push, then pop) and commit only
    them there. False when there is nothing to move; FlowBranchError when files
    existed but could not be carried or committed (they are put back in `src`).
    Our stash entry is told apart by its commit id, never by its position."""
    if not files:
        return False
    # Pathspecs from each repo's top: a session's cwd can be a subdir, and git reads them from where it runs.
    src, dst = (os.path.realpath(git._run(d, "rev-parse", "--show-toplevel")[1].strip() or d)  # noqa: SLF001
                for d in (src, dst))
    rel = [os.path.relpath(os.path.join(os.path.realpath(os.path.dirname(f)), os.path.basename(f)), src)
           if os.path.isabs(f) else f for f in files]
    patched: dict = {}
    if src != dst and ours is not None:
        rel, patched = _split(src, rel, ours)
        if not rel and not patched:
            return False
    if src != dst and rel:
        before = set(_stash_shas(src))
        rc, _, err = git._run(src, "stash", "push", "-u", "-m", f"mystical flow {slug}", "--", *rel, timeout=30)  # noqa: SLF001
        if rc != 0:
            _log(f"stash push failed: {err.strip()}")
            raise FlowBranchError(f"git stash push failed: {err.strip()}")
        new = [x for x in _stash_shas(src) if x not in before]
        if not new and not patched:   # nothing changed in these files: leave other stashes alone
            return False
    if src != dst and rel and new:
        sha = new[0]
        # paths dst already changes itself are not ours to touch if the pop fails
        mine = {l[3:].strip('"') for l in git._run(dst, "-c", "core.quotePath=false", "status", "--porcelain",  # noqa: SLF001
                                                    "-uall", "--", *rel)[1].splitlines()}
        ok, err = _pop(dst, sha)
        if not ok:
            _log(f"stash pop of {sha[:10]} into {dst} failed: {err}")
            for r in rel:
                if r in mine:
                    continue
                if git._run(dst, "cat-file", "-e", f"HEAD:{r}")[0] == 0:  # noqa: SLF001
                    git._run(dst, "checkout", "HEAD", "--", r)  # noqa: SLF001
                else:
                    git._run(dst, "reset", "-q", "--", r)  # noqa: SLF001
                    try:
                        os.remove(os.path.join(dst, r))
                    except OSError:
                        pass
            ok2, err2 = _pop(src, sha)
            if not ok2:
                _log(f"restore of {sha[:10]} into {src} failed, files stay in the stash: {err2}")
                raise FlowBranchError(f"{err}. They are in git stash entry {sha[:10]}")
            raise FlowBranchError(err or "git stash pop failed")
    _move_hunks(src, dst, patched)
    rel += list(patched)
    rc, _, err = git._run(dst, "add", "--", *rel)  # noqa: SLF001
    if rc != 0:
        _log(f"add failed: {err.strip()}")
        raise FlowBranchError(f"git add failed: {err.strip()}")
    if git._run(dst, "diff", "--cached", "--quiet", "--", *rel)[0] == 0:  # noqa: SLF001
        return False   # already committed there: nothing of the flow's is left to commit
    rc, out, err = git._run(dst, "commit", "-m", message or f"docs: decisions from the {slug} flow", "--", *rel, timeout=30)  # noqa: SLF001
    if rc != 0:
        _log(f"commit failed: {(err or out).strip()}")
        raise FlowBranchError(f"git commit failed: {(err or out).strip()}")
    return True
