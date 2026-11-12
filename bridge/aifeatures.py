"""Which AI-powered extras are on, and where that answer lives.

Everything registered here spends model budget: a call of its own — a title, a
relevance verdict, a repo scout, a commit message — or the prompt tokens and
behaviour a run inherits (ponytail, the project map). Anything that runs on its
own — nobody pressed anything — is a power-user feature rather than a default and
ships OFF; the ones that only fire on a press, or that shaped every run long
before this tab existed, ship ON and are listed anyway so that every model call
in the bridge is visible and stoppable from one place. Either way the switch is
in the dashboard's AI tab instead of an env var only whoever deployed the bridge
can reach. A feature's own UI is hidden while its switch is off.

The skill router (bridge/route.py) is the exception: it picks with rules and spends
no model budget, and is listed so that each piece of it can be turned off on its
own. Those pieces name the router as their `parent`, and ship ON because they do
nothing until it is switched on. REVIEW AFTER MERGE does spend budget (a council
run per merged set) and ships ON all the same, the user's choice on 2026-11-11: its
parent is TICKETS, which ships OFF, so an untouched install still spends nothing.

Precedence is `ladder.default_policy`'s: the persisted setting wins; with none,
the environment setting (config.*) decides; with neither, off. Persisting next to
the DB rather than in it keeps this readable by a bridge whose store is mid-
migration, and one small JSON file is the whole state. Stdlib only.
"""

import json
import os
import threading

from bridge import config

# key   -- stable id used by the API, the UI and enabled()
# env   -- the config setting that decides when nothing is persisted
# cost   -- what one unit of this costs, for the UI to show next to the switch
# tokens -- what that unit burns, in + out, so the switch is a priced decision.
#           Medians measured from real runs, not arithmetic on the prompt: a
#           one-shot costs tens of thousands because every `claude -p` carries
#           the CLI's own system prompt and tool schemas before it reads a word
#           of ours. Re-measure by summing `usage` across the assistant messages
#           of the one-shot transcripts in ~/.claude/projects (they are tagged
#           native.INTERNAL_ONESHOT_TAG). nextup is the one estimate: its scout
#           has never fallen through to Claude here, so it is read off preview,
#           the other tool-using run, scaled down for haiku and a shorter leash.
# about  -- the paragraph under the switch: what it does, and what appears in the
#           dashboard once it is on (each feature's UI is hidden while it is off)
# parent -- optional: the key of the feature this is a sub-switch of. It is shown, and
#           obeyed by whoever reads it (the dashboard, /local/route), only while the
#           parent is on; enabled() answers for the switch itself, parent or not.
FEATURES = (
    {"key": "title", "env": "TITLE_ENABLE", "label": "AUTO TITLES",
     "hint": "names a session from its first exchange",
     "cost": "1 haiku call per new session",
     "tokens": "~33k tokens",
     "about": "Replaces the first-prompt placeholder in the sessions list with a "
              "3-6 word subject, the way the Claude app names a chat. Runs once, "
              "after the very first turn, and never touches a session you renamed "
              "yourself or one that already has more history."},
    {"key": "relevance", "env": "RELEVANCE_CHECK", "label": "NEW-SESSION GUARD",
     "hint": "offers a fresh session when a prompt changes the subject",
     "cost": "1 haiku call per long prompt",
     "tokens": "~36k tokens",
     "about": "Before a long prompt resumes a session that already has history, a "
              "quick check decides whether it continues that work. If it does not, "
              "nothing runs: the prompt is held on a card offering a fresh, "
              "pre-titled session instead, and you can still send it where it was. "
              "Short follow-ups and new sessions never pay for a check, and any "
              "failure lets the prompt through."},
    {"key": "nextup", "env": "NEXTUP_ENABLE", "label": "NEXT-UP BOARD",
     "hint": "four questions about the repo you are in, and a machine-wide board",
     "cost": "1 scout per question per changed repo",
     "tokens": "~150k tokens",
     "about": "Looks at a repo's hard facts — dirty worktree, unpushed commits, "
              "open issues, sessions that stopped mid-task — and answers four "
              "questions about it: what to finish, what is wrong in what changed, "
              "what has not been decided, and where the UI drifts from its own "
              "design system. A new session's empty screen asks them one at a "
              "time, about its own repo only; the WORK tab keeps the ranked board "
              "across every repo you touched this week. Only a repo whose git "
              "state moved is re-scouted. Off, nothing is scouted and the screen "
              "still shows where the repo stands."},
    {"key": "translate", "env": "TRANSLATE_ENABLE", "label": "TRANSLATE",
     "hint": "translates what you select in a chat",
     "cost": "1 haiku call per press",
     "tokens": "~33k tokens",
     "about": "Select words in an agent's message and press Translate. It reads the "
              "sentence around them to pick the meaning, and a repeat is answered from "
              "memory. Nothing runs until you press it. Part of the experimental chats."},
    {"key": "explain", "env": "EXPLAIN_ENABLE", "label": "EXPLAIN THIS",
     "hint": "explains what you select in a chat, right there",
     "cost": "1 haiku call per press",
     "tokens": "~33k tokens",
     "about": "Select words in an agent's message and press Explain. It answers in a "
              "popover from that message alone, and adds nothing to the chat. Nothing "
              "runs until you press it. Part of the experimental chats."},
    {"key": "refine", "env": "REFINE_ENABLE", "label": "REFINE A TASK",
     "hint": "talks a work list task through with you, and suggests a rewrite",
     "cost": "1 sonnet call per message you send",
     "tokens": "~40k tokens",
     "about": "Press Refine on a work list task nobody has started. It can read the project "
              "and nothing else, and the task only changes when you press Use this. Nothing "
              "runs unless you send a message. Part of the experimental chats."},
    {"key": "design_critic", "env": "DESIGN_CRITIC_ENABLE", "label": "DESIGN CRITIC",
     "hint": "an independent review of a design, scored against your references",
     "cost": "1 sonnet call per review",
     "tokens": "~50k tokens",
     "about": "Press Critique in the design view, or an agent asks for one. A separate "
              "model that can only read looks at the page at phone and desktop width and "
              "scores it. Nothing runs unless asked. Part of the experimental chats."},
    {"key": "preview", "env": "PREVIEW_DETECT_AI", "label": "RUN COMMAND",
     "hint": "works out how to start a repo whose dev script isn't obvious",
     "cost": "1 haiku call per repo the heuristic can't read",
     "tokens": "~300k tokens",
     "about": "Opening a project's TERMINAL tab, or analysing it, fills in the "
              "command that starts its dev server. A free heuristic reads the "
              "lockfile and scripts first and answers for most repos; this decides "
              "whether the rest may fall through to a model call. That fall-through "
              "is automatic, not a button. It reads the repo instead of answering "
              "in one shot, which is why it costs ten times what a title does. "
              "Off, an unreadable repo gets a plain 'run dev' guess you can edit."},
    {"key": "learn", "env": "LEARN_ENABLE", "label": "LESSONS",
     "hint": "teaches you what each turn just built, shelved by concept",
     "cost": "1 haiku call per finished turn",
     "tokens": "~40k tokens",
     "about": "After a turn finishes, a short lesson is written about what was "
              "built — the change, the idea behind it, where to look — and saved "
              "in that repo's .mystical/learn/ (git-ignored). The LEARN panel "
              "collects every repo's into one list, grouped by the concept each "
              "teaches, and asks an unread one's own question before showing it. "
              "A single repo can still opt out there. A turn that only answered "
              "a question or read files is skipped. Off, no lesson is written "
              "and the tab is hidden."},
    {"key": "dream", "env": "DREAM_ENABLE", "label": "DREAMING",
     "hint": "each night, distils what a repo taught you into the next session",
     "cost": "1 haiku call per active repo per night",
     "tokens": "~40k tokens",
     "about": "Once a night, every repo you worked in gets its new LESSONS and "
              "its failed turns read back, and the ten most durable lines — what "
              "this codebase keeps teaching, what keeps going wrong — are written "
              "to its .mystical/docs/dream.md. Every later session in that repo "
              "opens carrying them (~400 tokens, once per session, beside the "
              "project map), so the bridge stops starting from zero every "
              "morning. Off, no pass runs and nothing is injected; the file "
              "stays on disk."},
    {"key": "ponytail", "env": "PONYTAIL_ENABLE", "label": "PONYTAIL",
     "hint": "answers as a lazy senior dev — least code that works",
     "cost": "no extra call, a system prompt per run",
     "tokens": "~1.3k tokens",
     "about": "The ponytail plugin's ladder rides every run: reuse what the repo "
              "already has, stdlib and native platform before a dependency, "
              "shortest diff that works. On, the prompt box gets the level "
              "picker with its REVIEW and AUDIT buttons and SESSION gets the "
              "default level. Off, the plugin is told `off` for every run — "
              "leaving it unset would mean its own default, full — and both "
              "controls are hidden."},
    {"key": "graph", "env": "GRAPH_ENABLE", "label": "PROJECT MAP",
     "hint": "a code graph of each repo, summarised into the system prompt",
     "cost": "no extra call, a prompt pack per session",
     "tokens": "~400 tokens",
     "about": "graphify reads a repo into a knowledge graph (tree-sitter, no "
              "model call), which the first turn of every session carries as a "
              "~400-token structure summary — subsystems, hub files — so Claude "
              "starts oriented. The map builds itself after a turn and refreshes "
              "as the code moves. Each repo also has its own switch (SETTINGS ▸ "
              "Projects ▸ Project map), on where a map already exists and off "
              "elsewhere; where both are on, the prompt box gets the MAP chip and "
              "the project window the MAP tab. Off, nothing is built, refreshed or "
              "injected, /map says which switch is off, and both leave the "
              "dashboard. An existing graphify-out/ is left on disk."},
    {"key": "rvtrack", "env": "RIVENDELL_TRACK", "label": "RIVENDELL TASKS",
     "hint": "work in a repo on a Rivendell board finds or files its task",
     "cost": "no extra call; a note per run in a repo on a board, plus a tool call per piece of work",
     "tokens": "~200 tokens a turn",
     "about": "A session in a repo whose Rivendell project has a task board is told, before it "
              "changes code, to look up that board's open tasks. When one covers the work, the "
              "branch name and the PR title carry its key, so Rivendell links the PR to it. When "
              "none does, a card asks you first, and on yes the session files one. "
              "Rivendell's own runs never do this. Off, no note goes out and the two "
              "tools are hidden."},
    {"key": "commitmsg", "env": "COMMIT_MSG_AI", "label": "COMMIT MESSAGES",
     "hint": "writes a commit message from the diff you selected",
     "cost": "1 haiku call per press",
     "tokens": "~32k tokens",
     "about": "The GIT tab's generate button and the header's SHIP button describe "
              "your staged diff. This one only runs when you press something, so "
              "unlike the extras above it ships ON — the switch is here so the "
              "spend is visible and stoppable. Off, the generate button is hidden "
              "and SHIP commits with a plain list of what changed."},
    {"key": "logostyle", "env": "LOGO_STYLE_AI", "label": "STYLE WITH AI",
     "hint": "picks each project's logo, background and colour",
     "cost": "1 sonnet call per press",
     "tokens": "~12k tokens",
     "about": "SETTINGS ▸ Projects' Style with AI shows one model a contact sheet of every "
              "project's logos and favicons and its frontend's, and "
              "each project wears what it picks, with a background and a colour; a mark you "
              "set stays yours, and Undo takes a run back. No tools, hooks or session ride "
              "along, so a press costs a cent or two. It only runs when you press it, so "
              "it ships ON. Off, the button is Pick logos again: its rules, "
              "no model, letters only."},
    {"key": "changelog", "env": "CHANGELOG_ENABLE", "label": "UPDATE NOTES",
     "hint": "sums up what an update brings, before and after you take it",
     "cost": "1 haiku call per waiting update (hourly at most while more lands), "
             "1 per restart whose commits it didn't cover, 1 an hour while a failed one waits",
     "tokens": "~32k tokens",
     "about": "When commits land upstream, UPDATE pops a headline and a few bullets of what "
              "they bring, and its popover leads with them; after the PULL & RESTART the "
              "changelog (the scroll above UPDATE) keeps the same words. The one exception "
              "to this tab's rule: it runs without a press, once when the update appears and "
              "at most hourly while more commits land, and the restart reuses those words "
              "instead of paying again. A restart whose commits it didn't cover (a dev "
              "checkout's own work) still pays one call. A call that fails (a login at its "
              "limit) is asked again hourly for a week, and its row is rewritten in place. "
              "Off, the bullets are read from the commit subjects instead."},
    {"key": "router", "env": "ROUTER_ENABLE", "label": "SKILL PATHS",
     "hint": "gives every prompt a path through Matt Pocock's skills, bundled in Mystical",
     "cost": "~300 tokens in every run's system prompt",
     "tokens": "~300 tokens a run",
     "about": "Matt Pocock's skills ship bundled with Mystical, so every project has them. "
              "Rules (no model call) read a prompt first and draw the skill that fits in "
              "front of it, with one line saying why; when no rule fits, Claude picks the "
              "path itself. The FLOW tab shows where a session is on its path, and the "
              "next steps can start by themselves (AUTO NEXT STEPS). Ignore a suggestion "
              "and the prompt goes as typed; a command AUTO PICKS put in front is sent "
              "with it, unless Esc takes it out, and then that prompt goes with a line "
              "saying no path. Costs about 300 tokens in every run's system prompt. Off, "
              "nothing is drawn or inserted, and the switches under this one are hidden."},
    {"key": "autopick", "env": "ROUTER_AUTO", "label": "AUTO PICKS",
     "parent": "router",
     "hint": "five safe commands go in front without a tap",
     "cost": "no extra call",
     "tokens": "0 (rules only)",
     "about": "/grill-with-docs, /diagnosing-bugs, /research, /prototype and /tdd stay in "
              "this session and leave nothing but local files, so they are cheap to be "
              "wrong about. On a session's first prompt, or right after a flow step ended, "
              "they go in front of your text by themselves, and Esc takes them out "
              "before you send. Every other command is an outlined suggestion that Tab takes. "
              "Off, those five are outlined suggestions too."},
    {"key": "nextstep", "env": "ROUTER_NEXT", "label": "AUTO NEXT STEPS",
     "parent": "router",
     "hint": "a step starts by itself when the last one ends",
     "cost": "a normal turn per step",
     "tokens": "a normal run per step",
     "about": "On, when a step of a path ends by calling StepDone, the next step starts by "
              "itself as a queued turn in the same session. Off, the empty prompt box "
              "offers the next step as a ghost suggestion and Tab takes it, as before. A "
              "turn that failed or is still running starts or offers nothing."},
    {"key": "ticketruns", "env": "TICKET_RUNS", "label": "TICKETS",
     "parent": "router",
     "hint": "approved tickets build as sessions, 3 at once, merged at the end",
     "cost": "one session per ticket",
     "tokens": "a normal run per ticket",
     "about": "Once you approve the tickets /to-tickets wrote, each one builds in a session "
              "of its own, in its own worktree on a branch off the feature branch, at most 3 "
              "at once, and a ticket waits until the ones blocking it are done. When the last "
              "one is done, one session merges them all onto the feature branch. Off, the "
              "path stops once the ticket files are written."},
    {"key": "ticketapprove", "env": "TICKET_APPROVE", "label": "APPROVE BEFORE BUILD",
     "parent": "ticketruns",
     "hint": "tickets wait for your tap before any session starts",
     "cost": "no extra call",
     "tokens": "0",
     "about": "Off, BUILD starts as soon as /to-tickets has written the tickets (the skill is "
              "meant to ask you first, but can skip it). On, the set shows its breakdown in "
              "the TICKETS tab and waits for Approve & build before any branch, worktree or "
              "session is made."},
    {"key": "mergereview", "env": "MERGE_REVIEW", "label": "REVIEW AFTER MERGE",
     "parent": "ticketruns",
     "hint": "the council reads the merged work before RETRO",
     "cost": "one council run per merged set",
     "tokens": "the merged diff per reviewer and round, and the fix turns",
     "about": "On, once the merge session has merged every ticket, the council reads the "
              "merged branch there, with its own settings (bar, rounds, reviewers), and the "
              "merge session fixes what it finds. FLOW shows this as REVIEW. When the "
              "council passes, RETRO starts. When it stops without passing, "
              "RETRO does not start and you get Council needs you: go on from the merge "
              "session's COUNCIL tab, or press Skip on REVIEW in FLOW to take the work as it "
              "stands. If a push would send nothing, or you merged the tickets by hand, the "
              "step is passed over. Off, RETRO follows MERGE."},
    {"key": "smartzone", "env": "ROUTER_ZONE", "label": "SMART ZONE",
     "parent": "router",
     "hint": "marks 150k tokens and offers /compact first past it",
     "cost": "no extra call",
     "tokens": "0 (rules only)",
     "about": "Matt's rule: past about 150k tokens of context, /compact at a phase "
              "boundary, never in the middle of one. The context meter gets a mark at 150k "
              "that warms once you cross it, and when a flow step ends past the mark, the "
              "next step is preceded by /compact, told to keep the decisions so far. A step "
              "that opens a fresh session skips it, since that starts clean. Off, no mark "
              "and no /compact offer."},
    {"key": "grillcards", "env": "GRILL_CARDS", "label": "GRILL AS CARDS",
     "hint": "a grilling skill asks each round as one card",
     "cost": "no extra call, one line in every run's system prompt",
     "tokens": "~40 tokens a run",
     "about": "The bridge's prompt asks for one decision at a time, which fights a grilling "
              "skill's rounds of questions. On, every run carries one more constant line: "
              "when grill-with-docs, grill-me or grilling runs, ask each round as one "
              "AskUserQuestion card, up to 4 questions, the recommended answer first, "
              "worded so yes takes it. That is taps instead of typing, which suits a "
              "phone. It shapes any grilling run, typed or routed, so it stands apart from "
              "SKILL PATHS. Off, the line is left out and a skill asks its rounds its own "
              "way."},
)

_KEYS = {f["key"] for f in FEATURES}
_lock = threading.Lock()
_cache: "dict | None" = None


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "ai_features.json")


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            with open(_path()) as f:
                raw = json.load(f)
            _cache = {k: bool(v) for k, v in (raw or {}).items() if k in _KEYS}
        except (OSError, ValueError, AttributeError):
            _cache = {}
    return _cache


def enabled(key: str) -> bool:
    """Is this feature on? Persisted setting first, then the env setting, then off."""
    with _lock:
        saved = _load().get(key)
    if saved is not None:
        return saved
    spec = next((f for f in FEATURES if f["key"] == key), None)
    return bool(getattr(config, spec["env"], False)) if spec else False


def set_enabled(key: str, on: "bool | None") -> None:
    """Switch a feature; None clears the override back to the env setting."""
    if key not in _KEYS:
        raise ValueError(f"unknown feature {key!r}")
    global _cache
    with _lock:
        cur = dict(_load())
        if on is None:
            cur.pop(key, None)
        else:
            cur[key] = bool(on)
        _cache = cur
        try:
            os.makedirs(os.path.dirname(_path()), exist_ok=True)
            with open(_path(), "w") as f:
                json.dump(cur, f)
        except OSError:
            pass  # in-memory setting still holds for this process


def state() -> list[dict]:
    """Every feature with its current answer, for the settings UI."""
    return [{**f, "enabled": enabled(f["key"])} for f in FEATURES]
