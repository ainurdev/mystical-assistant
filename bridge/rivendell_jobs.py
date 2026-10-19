"""What a Rivendell job was about, kept on the session that ran it.

Rivendell's job events, catch-up rows and claims carry what a person knows a job
by: a PR's title and number, a task's name, a paper's edition date, a file, a
meeting. The worker kept one `slug` per job and dropped the rest. So a session read
as its prompt ("You are an experienced software engineer…"), filed under
whatever folder the job ran in, and nothing said what kind of job it was.
`facts()` keeps those facts as the session's `job` (store.set_job). The dashboard
groups, tags and draws by it: the "Rivendell jobs" group, the job plate in place
of the YOU bubble, the job bar in place of the composer, the newspaper.

`title()` names a session the way Rivendell names its job. A title set by hand is
never touched (store.rename marks it manual and the titler leaves it alone). Videos
and meeting notes keep the "Transcribe · <file>" / "Meeting notes · <name>" titles
their runners already give them, because the Telegram pings read those too.

`backfill()` gives the sessions from before this their job, once, by reading the
prompt each one ran: every session a Rivendell job started, and every one in the
folders only Rivendell's runs make (.bridge_uploads/meetings, videos, video-<id>),
which the dashboard files under Rivendell jobs too (lib/jobs isJob). A run that
was indexed as a terminal session (MOVE brought some over from an older machine)
has no stored prompt; its title, the prompt's first 60 characters, still opens
with the template's words, so it is filed by those. Any session with a job lists
under Rivendell jobs, so no folder stays a project just for holding these. Rivendell's templates open with fixed lines. The notices that
also name a kind are pruned after a day, so they can't be used. A prompt that
matches no template (a custom one) still gets a row with no kind. It files under
Rivendell jobs by its origin, untagged, and is never scanned again.

Not built: asking Rivendell for the facts (GET /agent-jobs/mine lists open jobs
only), and links into Rivendell's own pages. The bridge knows the API's address,
not the web app's, so `url` is kept only when Rivendell sends one (a batch does).
"""
import json
import re
import time

# A kind's tag in the dashboard is the PLUGINS queue's word for it (RivendellQueue.tsx).
KINDS = ("review", "impl", "taskdesc", "todolist", "changelog", "news", "deck", "video", "meeting-notes",
         "project-summary")


def _pick(*vals):
    return next((v for v in vals if v not in (None, "")), None)


def facts(kind: str, request_id: str, instance_id: str,
          src: "dict | None" = None, claim: "dict | None" = None) -> dict:
    """The job as stored: its kind, which Rivendell and request it is, and what the
    event or catch-up row (`src`, either shape) and the claim said. A fact neither
    carried is left out, never stored empty."""
    s, c = src or {}, claim or {}
    pr, task, project = s.get("pullRequest") or {}, s.get("task") or {}, s.get("project") or {}
    batch = s.get("batch") or c.get("batch") or {}
    file = s.get("file") or c.get("file") or {}
    meeting = s.get("meeting") or c.get("meeting") or {}
    step = None
    if kind == "todolist":
        step = str(_pick(s.get("kind"), c.get("kind")) or "").lower() or None
    elif kind == "video":
        step = str(_pick(s.get("kind"), c.get("kind")) or "").lower() or None
    elif kind == "meeting-notes":
        step = str(_pick(s.get("source"), c.get("source")) or "").lower() or None
    title = {
        "review": _pick(pr.get("title"), s.get("pullRequestTitle")),
        "impl": _pick(batch.get("name"), task.get("name"), s.get("taskName")),
        "taskdesc": _pick(task.get("name"), s.get("taskName"), c.get("taskName")),
        "todolist": _pick(project.get("name"), s.get("projectName"), c.get("projectName")),
        "changelog": _pick(project.get("name"), s.get("projectName"), c.get("projectName")),
        "project-summary": _pick(project.get("name"), s.get("projectName"), c.get("projectName")),
        "deck": _pick((s.get("site") or {}).get("title"), s.get("siteTitle")),
        "video": _pick(file.get("name"), s.get("fileName")),
        "meeting-notes": _pick(meeting.get("name"), s.get("meetingName")),
    }.get(kind)
    job = {
        "kind": kind, "instance": instance_id, "request": request_id, "step": step, "title": title,
        "repo": _pick(pr.get("repositoryFullName"), (s.get("repository") or {}).get("fullName"),
                      s.get("repositoryFullName"), c.get("repositoryFullName")),
        "number": _pick(pr.get("number"), s.get("pullRequestNumber")),
        "html_url": _pick(pr.get("htmlUrl"), s.get("pullRequestHtmlUrl"), task.get("htmlUrl")),
        "url": _pick(s.get("url"), c.get("url"), batch.get("url")),
        "date": _pick(s.get("editionDate"), c.get("editionDate")),
        "language": c.get("language"),
        # What RUN AGAIN files a fresh job with (rivendell.rerun).
        "pr_id": _pick(pr.get("id"), s.get("pullRequestId")),
        "task_id": _pick(task.get("id"), s.get("taskId")),
        "project_id": _pick(project.get("id"), s.get("projectId")),
    }
    return {k: v for k, v in job.items() if v not in (None, "")}


def _day(date: str) -> str:
    """"2026-10-18" -> "Sun 18 Oct"; anything unreadable comes back as it was."""
    try:
        return time.strftime("%a %d %b", time.strptime(date, "%Y-%m-%d"))
    except (TypeError, ValueError):
        return date


def title(job: dict) -> "str | None":
    """The session's name for its job, or None to leave the title to its runner
    (video, meeting notes) or to the titler (a fact Rivendell didn't send)."""
    kind, name = job.get("kind"), job.get("title")
    if kind == "news":
        return f"Newspaper · {_day(job['date'])}" if job.get("date") else "Newspaper"
    if kind == "review":
        return name or (f"Review · {job['repo']} #{job['number']}" if job.get("repo") and job.get("number") else None)
    if not name or kind in ("video", "meeting-notes"):
        return None
    if kind == "todolist":
        return f"{name} · {'recommendations' if job.get('step') == 'recommendations' else 'todolist'}"
    if kind in ("changelog", "deck"):
        return f"{name} · {kind}"
    if kind == "project-summary":
        return f"{name} · summary"
    return name


def headline(text: "str | None") -> "str | None":
    """A newspaper answer's lead headline, the session's title once it lands. The
    answer is the paper's JSON, sometimes in a ```json fence; None if it isn't."""
    raw = text or ""
    i, j = raw.find("{"), raw.rfind("}")
    try:
        paper = json.loads(raw[i:j + 1]) if 0 <= i < j else None
    except ValueError:
        return None
    lead = paper.get("lead") if isinstance(paper, dict) else None
    h = lead.get("headline") if isinstance(lead, dict) else None
    return h.strip() if isinstance(h, str) and h.strip() else None


# The fixed opening of each Rivendell prompt template (backend/src/**/*prompt.template.ts).
# The summary's comes first: its prompt's head can quote a commit title that holds another template's words.
_MARKS = (
    ("project-summary", "You are writing a short summary of what happened in the project"),
    ("review", "performing a code review"),
    ("impl", "implementing a task"),
    ("impl", "implementing a batch of related tasks"),
    ("taskdesc", "writing the description for one task"),
    ("todolist", "keeping the working todolist"),
    ("todolist", "task board honest"),            # the RECOMMENDATIONS step
    ("changelog", "writing the changelog"),
    ("news", "editor of a small daily newspaper"),
    ("meeting-notes", "writing the notes of a meeting"),
    ("video", "transcript of a recording"),
)


# What a session titled by its prompt's first 60 characters shows of each
# template: enough to know a Rivendell run that was indexed as a terminal session
# (an older machine's, brought over by MOVE), whose prompt the bridge never stored.
_TITLE_MARKS = (
    ("news", "You are the editor of a small daily newspaper"),
    ("todolist", "You are an experienced technical project manager"),
    ("review", "You are an experienced software engineer perform"),
    ("impl", "You are an experienced software engineer implement"),
    ("taskdesc", "You are an experienced tech lead writing the descr"),
    ("changelog", "You are a release manager writing the changelog"),
    ("meeting-notes", "You are writing the notes of a meeting"),
    ("project-summary", "You are writing a short summary of what happened"),
    ("video", "You are given the transcript of a recording"),
)


def _line(pat: str, text: str) -> "str | None":
    m = re.search(pat, text, re.M)
    return m.group(1).strip() if m else None


def classify(prompt: "str | None") -> "dict | None":
    """A job's kind and facts read back from the prompt it ran (backfill), or None.
    Only the head is matched, where every template states what it is."""
    p = prompt or ""
    head = p[:400]
    kind = next((k for k, mark in _MARKS if mark in head), None)
    if kind is None and head.startswith("Task:") and "\nRepository:" in head:
        kind = "impl"                     # the older template, and WORK ON IT's
    if kind is None:
        return None
    job: dict = {"kind": kind}
    if kind == "review":
        job["title"] = _line(r"^Pull request: (.+)$", p)
        url = _line(r"^Pull request URL: (\S+)", p)
        m = re.search(r"github\.com/([^/\s]+/[^/\s]+)/pull/(\d+)", url or "")
        if m:
            job.update(html_url=url, repo=m.group(1), number=int(m.group(2)))
    elif kind in ("impl", "taskdesc"):
        job["title"] = _line(r"^Batch: (.+?)(?: \(\d+ tasks?\))?$", p) or _line(r"^Task: (.+)$", p)
        if kind == "impl":
            job["repo"] = _line(r"^Repository: (\S+)", p)
    elif kind == "todolist":
        job["step"] = "recommendations" if "task board honest" in head else "todolist"
        job["title"] = _line(r"^Project: (.+?)(?: \(Rivendell project id [^)]*\))?$", p)
    elif kind == "changelog":
        job["title"] = _line(r"changelog for one release of (.+?)\.", head)
    elif kind == "news":
        job["date"] = _line(r"^Edition: (\d{4}-\d{2}-\d{2})", p)
    elif kind == "meeting-notes":
        job["title"] = _line(r"^Meeting: (.+)$", p)
    elif kind == "project-summary":
        job["title"] = _line(r'in the project "(.+?)"\.', head)
    elif kind == "video":
        job["title"] = _line(r"^File: (.+?) \(", p)
        job["step"] = "transcribe" if "the screens of it" in head else None
    return {k: v for k, v in job.items() if v not in (None, "")}


def _runner_title(job: dict) -> "str | None":
    """The title a video's or a meeting's runner gives its session (rivendell.py
    _run_video, _run_meeting_notes), for an older one whose title is still its
    prompt's first line."""
    if job.get("kind") == "video" and job.get("title"):
        return f"{'Ask' if job.get('step') == 'ask' else 'Transcribe'} · {job['title']}"
    if job.get("kind") == "meeting-notes" and job.get("title"):
        return f"Meeting notes · {job['title']}"
    return None


def backfill() -> int:
    """File a job on every Rivendell session that has none: the ones that ran
    before sessions kept it. A titler-made title gives way to the job's own (a
    newspaper's lead headline when its answer is there); one set by hand stays.
    Returns how many it filed. Each session gets a job, even an unreadable one
    (no kind), so a boot scans each one once."""
    from bridge import store                     # local import: keeps the pure parts importable
    n = 0
    for row in store.rivendell_without_job():
        inst, _, req = (row.get("ref") or "").partition(":")
        # The title's opening knows the kind when no prompt was stored (a terminal-indexed run).
        kind = next((k for k, mark in _TITLE_MARKS if (row.get("title") or "").startswith(mark)), None)
        job = {**(classify(row.get("prompt")) or ({"kind": kind} if kind else {})),
               **({"instance": inst, "request": req} if req else {})}
        if not row.get("rivendell"):
            # Only its title says it was a Rivendell run: file it only when it does.
            if kind is None:
                continue
            store.set_job(row["id"], {"kind": kind})   # its title is all it has: kept
            n += 1
            continue
        store.set_job(row["id"], job)
        name = headline(row.get("result")) if job.get("kind") == "news" else None
        name = name or title(job) or _runner_title(job)
        if name and row.get("title_source") != "manual":
            store.rename(row["id"], name)
        n += 1
    return n
