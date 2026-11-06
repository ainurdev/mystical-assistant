"""What each kind of agent can do, in one table.

The bridge grew up on Claude, so "can this session do X" was answered by asking
whether it was Claude: `startswith("acp:")` in the runner, `claude_only_refusal`
in the routes, `agent !== "claude"` in the composers. With the EXPERIMENTAL
switch on, those read this table, and the UI gets the same answers in the session
brief (`caps`), so a surface never guesses.

Every value here is something measured or read, not hoped for:

  steer  "native": a stream-json user message folds in at the next tool boundary.
         "soft": ACP v1 has no mid-turn message. Kimi Code 2.4.1 answers a second
         session/prompt with -32600 turn.agent_busy (tried 2026-11-06). So the
         bridge waits for the running tool, sends session/cancel and prompts the
         same session on the same connection (acp.soft_steer). The same test
         showed the context survives: the agent knew what it had been told and
         which commands had finished.
  ask    "native": AskUserQuestion. "gateway": the ask_user tool (bridge/gateway.py).
         Kimi Code times an MCP call out at 60 s (tried 2026-11-06), so on an
         agent a card can't block a tool call: the turn pauses with the same
         cancel, and the answer is the next prompt on that connection.
  block  Whether an MCP tool call may wait on a person. Claude's may; an agent's
         may not (above).
  system_prompt  Whether the bridge's instructions can go outside the conversation.

A preset nobody has measured gets the conservative row (AGENT): what ACP v1
promises and no more.

Stdlib only; nothing here may raise into a turn.
"""

from bridge import experimental

CLAUDE = "claude"

_CLAUDE = {"steer": "native", "ask": "native", "block": True, "system_prompt": True,
           "subagents": "detailed", "usage": True, "compact": True, "tools_switch": True,
           "goals": True, "duplicate": True, "skills_prefix": "/"}
AGENT = {"steer": "soft", "ask": "gateway", "block": False, "system_prompt": False,
         "subagents": "opaque", "usage": False, "compact": False, "tools_switch": False,
         "goals": True, "duplicate": False, "skills_prefix": "/"}
_OVERRIDES = {"kimi": {"skills_prefix": "/skill:"}}

# Tokens of history a provider's new session can take. Kimi's and the others'
# real windows aren't reported at session/new, so a known model name decides and
# anything else gets the common floor. Only the switch dialog reads this.
WINDOW_DEFAULT = 200_000
_WINDOWS = (("k3-256k", 256_000), ("1m", 1_000_000), ("opus", 200_000), ("sonnet", 200_000))
# Leave room for the work itself: history may fill this share of the window.
WINDOW_SHARE = 0.7


def caps(agent: "str | None") -> dict:
    """The capability row for an agent id ("claude" or a preset id)."""
    if not agent or agent == CLAUDE:
        return dict(_CLAUDE)
    return {**AGENT, **_OVERRIDES.get(agent, {})}


def window(model: "str | None") -> int:
    m = (model or "").lower()
    return next((n for key, n in _WINDOWS if key in m), WINDOW_DEFAULT)


def history_budget(model: "str | None") -> int:
    """Tokens of chat history the switch may send a new session directly."""
    return int(window(model) * WINDOW_SHARE)


def brief(agent: "str | None") -> "dict | None":
    """The session brief's `caps`: None while the switch is off, so a client
    keeps its old rules and nothing about the payload's meaning changes."""
    return caps(agent) if experimental.enabled() else None
