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
    {"key": "flowtype", "env": "FLOWTYPE_ENABLE", "label": "AUTO TYPE",
     "hint": "reads a new session's first message and starts the matching flow",
     "cost": "1 haiku call per new session",
     "tokens": "~33k tokens",
     "about": "Classifies the first message of a fresh session — build, fix, "
              "probe, ops, review, design, or plain chat — and a match starts "
              "that flow at its first stage: stage rail, hud-cards, structured "
              "replies. The message itself is never rewritten, and the verdict "
              "lands beside the first turn, not in front of it. While this is "
              "on the NEW SESSION type picker and its forms are hidden "
              "everywhere; off, they come back. Chat verdicts leave the "
              "session untyped."},
    {"key": "nextup", "env": "NEXTUP_ENABLE", "label": "NEXT-UP BOARD",
     "hint": "ranked next steps across the repos you touched recently",
     "cost": "1 scout per changed repo, free rung first",
     "tokens": "~150k tokens",
     "about": "Looks at the repos with recent session activity — dirty worktrees, "
              "unpushed commits, open issues, sessions that stopped mid-task — and "
              "ranks what is worth doing next, one item per click to start a "
              "session on it. Only a repo whose git state moved is re-scouted, and "
              "a free provider is tried before Claude quota. Off, the board is "
              "hidden entirely."},
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
    {"key": "tailstate", "env": "TAIL_STATE_AI", "label": "ENDED-ON-A-QUESTION",
     "hint": "flags a turn that finished needing you, instead of calling it done",
     "cost": "1 haiku call per turn ending in a question",
     "tokens": "~36k tokens",
     "about": "A turn that stops mid-run on a question already says WAIT. One "
              "that ENDS on a question — 'apply this fix or just report it?' — "
              "reads DONE, and the ping says finished. Auth failures, usage "
              "limits and 'reply go' closings are caught for free either way; "
              "this decides whether the rest may fall through to a model call "
              "that tells a real gate from a passing offer to do more. Off, only "
              "the free markers count.",
     },
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
              "as the code moves. On, the prompt box gets the MAP chip and "
              "ANALYZE gets the MAP tab. Off, nothing is built, refreshed or "
              "injected, /map answers that the switch is off, and both leave the "
              "dashboard. An existing graphify-out/ is left on disk."},
    {"key": "commitmsg", "env": "COMMIT_MSG_AI", "label": "COMMIT MESSAGES",
     "hint": "writes a commit message from the diff you selected",
     "cost": "1 haiku call per press",
     "tokens": "~32k tokens",
     "about": "The GIT tab's generate button and the header's SHIP button describe "
              "your staged diff. This one only runs when you press something, so "
              "unlike the extras above it ships ON — the switch is here so the "
              "spend is visible and stoppable. Off, the generate button is hidden "
              "and SHIP commits with a plain list of what changed."},
    {"key": "design", "env": "DESIGN_SYNC_ENABLE", "label": "DESIGN SYSTEM",
     "hint": "links a repo to its Claude Design system",
     "cost": "no extra call, a skill per linked repo",
     "about": "A repo linked to a Claude Design project can pull that design "
              "system down into .claude/skills/ — tokens, guidelines and every "
              "component's spec — so a design prompt reaches the real palette "
              "and components instead of improvised CSS. Claude Code's own "
              "skill mechanism decides per prompt whether to load it, so this "
              "costs no call and nothing is added to the system prompt. "
              "Finished work syncs back up, one component at a time, on a "
              "press. Off, the link row and the SYNC action leave the "
              "dashboard; a skill already pulled stays on disk."},
    {"key": "flows", "env": "FLOWS_ENABLE", "label": "TYPED FLOWS",
     "hint": "typed sessions: a form in, stage gates, a card out",
     "cost": "no extra call, a stage contract per turn",
     "tokens": "~1k tokens",
     "about": "A session can start as BUILD, FIX, PROBE, OPS, REVIEW or DESIGN "
              "instead of plain chat: a short form shapes the first prompt, the "
              "server walks the session stage by stage, every reply ends in a "
              "card with tappable next actions, and a gated stage waits for your "
              "approval before the work moves on. Templates are yours to edit in "
              "the FLOWS settings. Off, the type picker and that editor are "
              "hidden and every new session is a plain chat — a session already "
              "mid-flow keeps its stages, so nothing in flight is stranded."},
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
