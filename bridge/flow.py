"""Typed-session flows: definitions, the stage engine, and the reply contract.

A flow is data (bridge/flows/*.json, overlaid by flow:<stype> settings rows),
not code. The server owns which stage a session is in: it injects only that
stage's contract into each turn, validates the card the turn ends with, and
decides transitions — the model may *request* advancement, gated stages wait
for the user. That is the whole reason this is an engine and not a prompt
pack: a prompt can be talked past, a server-held stage cannot.

Everything is loaded per call rather than frozen at import, so editing a
template is live on the next turn without a bridge restart (engine changes
still need one). A broken JSON file or settings row is skipped, never fatal —
a bad template must not take the bridge down. Stdlib only.
"""

import json
import os
import re
import sys

from bridge import aifeatures, store

FLOWS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flows")
_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,23}$")
_PERM_MODES = ("default", "acceptEdits", "plan", "bypassPermissions")

# What a stage's card field can be. The type is a rendering contract, not a
# storage one: it tells the model what shape to emit and the surfaces which
# widget to draw. A bare string in card_fields is still a text field, so every
# flow written before types existed keeps working untouched.
_SHAPES = {
    "text": "...",
    "draft": "<the text, ready for the user to edit and send>",
    "files": '["path/to/file", ...]',
    "checks": '[{"cmd": "<command>", "ok": true}]',
    "screens": '[{"path": "<image path>", "caption": "..."}]',
    "findings": ('[{"file": "path", "line": 0, "severity": "high|med|low", '
                 '"note": "..."}]'),
    "commands": '[{"cmd": "<command>", "status": "ok|fail|pending"}]',
    "confidence": "0.0-1.0",
    "verdict": '"<one word>"',
    # Below: the widget grammar from the Canvas v3 gallery — one shape per kind
    # of work, so a terminal is never mistaken for a read. Each is the smallest
    # JSON a model emits reliably; anything richer is a shape it gets wrong.
    "diff": ('[{"file": "path", "add": 0, "del": 0, '
             '"hunk": "@@ context\\n- removed\\n+ added"}]'),
    "output": '{"cmd": "<command>", "text": "<what it printed>", "ok": true}',
    "map": ('{"nodes": [{"id": "a", "label": "TELEGRAM", "state": "ok|warn|bad"}], '
            '"edges": [{"from": "a", "to": "b", "label": "34ms"}]}'),
    "chain": ('[{"label": "SYMPTOM", "body": "...", "meta": "how you know", '
              '"tone": "bad|warn|good|flat"}]'),
    "chart": '[{"label": "08-22", "value": 96.4}]',
    "stats": '[{"label": "AVG / DAY", "value": "61.4M"}]',
    "table": '{"cols": ["DAY", "TOK"], "rows": [["08-22", "96.4M"]]}',
    "ideas": '[{"title": "...", "note": "...", "picked": false}]',
    "meters": '[{"label": "CPU", "pct": 12}]',
    "plan": '[{"op": "add|change|drop", "text": "..."}]',
    "sources": ('[{"title": "core.telegram.org", "url": "https://...", '
                '"badge": "OFFICIAL", "stale": false}]'),
    "claims": '[{"text": "...", "cites": [1, 2]}]',
    "intake": ('[{"topic": "AUDIENCE", "ask": "who is this for?", '
               '"options": ["new users", "returning"], "answer": ""}]'),
}
# How the user is meant to engage with a stage, which is what the composer
# reads to lead with taps instead of a blank box. The text box never leaves.
_INPUTS = ("approve", "arm", "evidence", "triage", "annotate", "pick",
           "answer", "refine")


def fields_of(stage: dict) -> "list[dict]":
    """A stage's card_fields as {name, type}. Anything unreadable is dropped and
    an unknown type degrades to text — a stale template must still render."""
    out = []
    for f in stage.get("card_fields", []) or []:
        if isinstance(f, str) and f:
            out.append({"name": f, "type": "text"})
        elif isinstance(f, dict) and isinstance(f.get("name"), str) and f["name"]:
            t = f.get("type") or "text"
            out.append({"name": f["name"], "type": t if t in _SHAPES else "text"})
    return out


def enabled() -> bool:
    """Master switch, shared with every other priced feature in the AI tab."""
    return aifeatures.enabled("flows")


# --- definitions ------------------------------------------------------------

def validate_flow(d) -> "list[str]":
    """Human-readable problems with a flow dict; [] means valid. Runs on every
    load, so a hand-edited template can never reach a session half-formed."""
    errs: list[str] = []
    if not isinstance(d, dict):
        return ["flow must be a JSON object"]
    if not isinstance(d.get("stype"), str) or not _ID_RE.match(d.get("stype") or ""):
        errs.append("stype must be lowercase [a-z0-9_-], 1-24 chars")
    if not (d.get("label") or "").strip():
        errs.append("label is required")
    if not isinstance(d.get("form", []), list):
        errs.append("form must be a list of fields")
    else:
        for i, f in enumerate(d.get("form", [])):
            if not isinstance(f, dict) or not f.get("key") or not f.get("label"):
                errs.append(f"form[{i}] needs key and label")
    stages = d.get("stages")
    if not isinstance(stages, list) or not stages:
        errs.append("stages must be a non-empty list")
        return errs
    seen = set()
    for i, s in enumerate(stages):
        if not isinstance(s, dict):
            errs.append(f"stages[{i}] must be an object")
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not _ID_RE.match(sid):
            errs.append(f"stages[{i}].id must be lowercase [a-z0-9_-]")
        elif sid == "done":
            errs.append("'done' is reserved for the finished state")
        elif sid in seen:
            errs.append(f"stages[{i}].id '{sid}' is a duplicate")
        else:
            seen.add(sid)
        if not isinstance(s.get("gate"), bool):
            errs.append(f"stages[{i}].gate must be true or false")
        if not (s.get("instructions") or "").strip():
            errs.append(f"stages[{i}].instructions is required")
        cf = s.get("card_fields", [])
        if not isinstance(cf, list):
            errs.append(f"stages[{i}].card_fields must be a list")
        else:
            for j, fl in enumerate(cf):
                if isinstance(fl, str) and fl:
                    continue
                if not (isinstance(fl, dict) and isinstance(fl.get("name"), str)
                        and fl["name"]):
                    errs.append(f"stages[{i}].card_fields[{j}] must be a name "
                                "or an object with name and type")
                elif fl.get("type", "text") not in _SHAPES:
                    errs.append(f"stages[{i}].card_fields[{j}].type must be one "
                                f"of {tuple(_SHAPES)}")
        inp = s.get("input")
        if inp is not None and inp not in _INPUTS:
            errs.append(f"stages[{i}].input must be one of {_INPUTS}")
        ho = s.get("handoff", [])
        if not isinstance(ho, list) or any(
                not isinstance(t, str) or not _ID_RE.match(t) for t in ho):
            errs.append(f"stages[{i}].handoff must be a list of flow ids")
        pm = s.get("permission_mode")
        if pm is not None and pm not in _PERM_MODES:
            errs.append(f"stages[{i}].permission_mode must be one of {_PERM_MODES}")
    # Branch targets last: every id has to be known by now, and a typo here is
    # a stage the model can name but the engine can never reach.
    for i, s in enumerate(stages):
        if not isinstance(s, dict):
            continue
        nxt = s.get("next_allowed", [])
        if not isinstance(nxt, list):
            errs.append(f"stages[{i}].next_allowed must be a list of stage ids")
            continue
        for t in nxt:
            if t not in seen and t != "done":
                errs.append(f"stages[{i}].next_allowed names unknown stage {t!r}")
    return errs


def load_flows() -> "dict[str, dict]":
    """Built-ins from disk, then flow:* settings rows on top (a custom row
    fully replaces the built-in of the same stype). Disabled flows are
    included: catalog() hides them from creation, but a session already
    running one still has to resolve it."""
    flows: dict[str, dict] = {}
    try:
        names = sorted(os.listdir(FLOWS_DIR))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(FLOWS_DIR, name), encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and not validate_flow(d):
            flows[d["stype"]] = d
    for key, raw in store.settings_with_prefix("flow:").items():
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if (isinstance(d, dict) and d.get("stype") == key[len("flow:"):]
                and not validate_flow(d)):
            d["_custom"] = True
            flows[d["stype"]] = d
    return flows


def get_flow(stype: "str | None") -> "dict | None":
    return load_flows().get(stype) if stype else None


def catalog() -> dict:
    """What creation UIs need: the master flag plus each flow's shape. Stage
    instructions are deliberately absent — a picker needs the form and the
    rail, not the prompts."""
    out = []
    for st, f in sorted(load_flows().items()):
        if f.get("disabled"):
            continue
        out.append({
            "stype": st, "label": f.get("label", st.upper()),
            "blurb": f.get("blurb", ""),
            "source": "custom" if f.get("_custom") else "builtin",
            "form": f.get("form", []),
            "stages": [{"id": s["id"], "label": s.get("label", s["id"].upper()),
                        "gate": bool(s.get("gate")), "fields": fields_of(s),
                        "input": s.get("input") or "",
                        # Raw, not filtered against this catalog: a target whose
                        # flow is disabled or gone simply has no button drawn.
                        "handoff": [t for t in s.get("handoff", [])
                                    if isinstance(t, str)]}
                       for s in f["stages"]],
        })
    return {"enabled": enabled(), "flows": out,
            "auto": aifeatures.enabled("flowtype")}


def save_custom(stype: str, d) -> "list[str]":
    """Persist a customized or brand-new template; returns validation errors."""
    errs = validate_flow(d)
    if not errs and d.get("stype") != stype:
        errs.append("stype in the body must match the one being saved")
    if not errs:
        known = set(load_flows()) | {stype}
        for s_ in d.get("stages", []):
            for t in s_.get("handoff", []) or []:
                if t not in known:
                    errs.append(f"stage {s_['id']} hands off to unknown flow {t!r}")
    if errs:
        return errs
    store.set_setting(f"flow:{stype}", json.dumps(
        {k: v for k, v in d.items() if k != "_custom"}))
    return []


def delete_custom(stype: str) -> bool:
    """Drop the override. A built-in of the same name resurfaces underneath."""
    had = store.get_setting(f"flow:{stype}") is not None
    store.set_setting(f"flow:{stype}", None)
    return had


def first_stage(f: dict) -> str:
    return f["stages"][0]["id"]


def compose_first_prompt(f: dict, form: dict) -> str:
    """A typed session's opening prompt: labeled lines from the start form.
    Empty fields are dropped, so an optional field costs nothing."""
    lines = [f"[{f.get('label', f['stype'].upper())}]"]
    for field in f.get("form", []):
        val = str(form.get(field["key"], "") or "").strip()
        if val:
            lines.append(f"{field['label']}: {val}")
    return "\n".join(lines)


# --- the engine -------------------------------------------------------------

_CARD_RE = re.compile(r"```hud-card\s*\n(.*?)```", re.DOTALL)

_CONTRACT = """End EVERY reply with exactly one fenced code block tagged hud-card:

```hud-card
{{"stage": "{sid}", "summary": "<one line: what this turn did>",
 "fields": {{{fields}}},
 "advance": <true only when this stage's work is fully complete>,
 "actions": [{{"label": "<SHORT VERB>", "send": "<the prompt that runs it>"}}]}}
```

"fields" must contain: {names}. "actions" are 0-3 canned next moves the user
can tap. Do not discuss this block in prose; it is parsed, not read."""

# Only stages that declare next_allowed get this line: a stage with one way out
# should not be told it has choices, and the prompt stays stable per stage.
_BRANCH = ('This stage may hand off somewhere other than the next one. Add '
           '"next": "<id>" to the card to go there, choosing from: {ids}. '
           'Omit it to follow the normal order.')


def stage_by_id(f: dict, stage_id: "str | None") -> "dict | None":
    return next((s for s in f.get("stages", []) if s["id"] == stage_id), None)


def next_stage(f: dict, stage_id: "str | None") -> "str | None":
    """The stage after this one, 'done' past the last, None when there is no
    next (already done, or a stage this flow no longer has)."""
    ids = [s["id"] for s in f.get("stages", [])]
    if stage_id not in ids:
        return None
    i = ids.index(stage_id)
    return ids[i + 1] if i + 1 < len(ids) else "done"


def resolve_stage_action(f: dict, current: "str | None", action: str,
                         stage: "str | None") -> "str | None":
    """Where an action lands, or None when it is not a legal move. Kept here so
    both servers' handlers stay four lines and agree on the arithmetic."""
    ids = [s["id"] for s in f.get("stages", [])]
    if action == "advance":
        return next_stage(f, current)
    if action == "back":
        if current == "done":
            return ids[-1] if ids else None
        if current in ids and ids.index(current) > 0:
            return ids[ids.index(current) - 1]
        return None
    if action == "set":
        return stage if stage in ids or stage == "done" else None
    return None


def stage_permission(f: dict, stage_id: "str | None") -> "str | None":
    s = stage_by_id(f, stage_id)
    return s.get("permission_mode") if s else None


def compose_section(f: dict, stage_id: "str | None") -> str:
    """The flow block appended to a turn's system prompt: the stage map, the
    CURRENT stage's instructions, and the card contract. Only the current
    stage ships, which is what keeps a 40-turn session from drifting. Stable
    per (flow, stage), so the prompt cache is only invalidated on a move."""
    label = f.get("label", f["stype"].upper())
    rail = " -> ".join(s.get("label", s["id"].upper()) for s in f["stages"])
    s = stage_by_id(f, stage_id)
    if s is None:
        return (f"[flow] This {label} session's flow is complete ({rail}). "
                "The hud-card block is now optional.")
    ff = fields_of(s)
    fields = ", ".join(f'"{x["name"]}": {_SHAPES[x["type"]]}' for x in ff)
    names = ", ".join(x["name"] for x in ff) or "(none required)"
    gate = ('This stage is GATED: you may set "advance": true to request the '
            "move, but the user approves it — never assume approval or work "
            "past the gate."
            if s.get("gate") else
            'Setting "advance": true moves the flow on by itself.')
    nxt = [t for t in s.get("next_allowed", [])]
    branch = _BRANCH.format(ids=", ".join(nxt)) if nxt else ""
    return "\n\n".join([p for p in [
        f"[flow] This is a typed {label} session. Stages: {rail}. "
        f"Current stage: {s.get('label', s['id'].upper())}.",
        s["instructions"].strip(),
        _CONTRACT.format(sid=s["id"], fields=fields, names=names),
        gate,
        branch,
    ] if p])


def _balanced(text: str, start: int) -> "str | None":
    """The {...} beginning at `start`, brace-counted so nested objects survive.
    String-aware, or a brace inside a summary would end the object early."""
    depth, instr, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if instr:
            instr, esc = (instr and not (c == '"' and not esc)), (c == "\\" and not esc)
            continue
        if c == '"':
            instr, esc = True, False
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _loads(raw: "str | None") -> "dict | None":
    """json.loads, then one repair pass. A model that fenced the card but put
    prose beside it, or left a trailing comma, has done the work — re-running
    the turn to fix punctuation costs more than parsing around it."""
    if not raw:
        return None
    for attempt in (raw, None):
        if attempt is None:                       # repair: isolate + de-comma
            i = raw.find("{")
            attempt = _balanced(raw, i) if i >= 0 else None
            if attempt is None:
                return None
            attempt = re.sub(r",(\s*[}\]])", r"\1", attempt)
        try:
            d = json.loads(attempt)
        except ValueError:
            continue
        if isinstance(d, dict):
            return d
    return None


def parse_card(text: "str | None") -> "dict | None":
    """The LAST hud-card block in a reply, as a dict; None if absent or
    unparseable. Last wins because a turn that shows an example mid-reply
    still ends with the real one. A malformed-but-recognisable card is
    repaired rather than nudged for — see _loads."""
    hits = _CARD_RE.findall(text) if text else []
    if hits:
        return _loads(hits[-1])
    # No fence at all: the commonest miss is the JSON alone, on its own line.
    # Only accept one that looks like a card, never a stray object in prose.
    for m in re.finditer(r"^\s*\{", text or "", re.M):
        d = _loads(_balanced(text, m.start() + text[m.start():].index("{")))
        if d and "stage" in d and "summary" in d:
            return d
    return None


def validate_card(f: dict, stage_id: str, card) -> "list[str]":
    # ponytail: a required-keys check, not JSON Schema — upgrade only if flows
    # ever need typed or nested field constraints.
    errs: list[str] = []
    if not isinstance(card, dict):
        return ["card must be a JSON object"]
    if card.get("stage") != stage_id:
        errs.append(f"card stage {card.get('stage')!r} is not the current {stage_id!r}")
    if not str(card.get("summary") or "").strip():
        errs.append("summary is required")
    fields = card.get("fields")
    if not isinstance(fields, dict):
        errs.append("fields must be an object")
        fields = {}
    st = stage_by_id(f, stage_id) or {}
    for x in fields_of(st):
        if x["name"] not in fields:
            errs.append(f"fields.{x['name']} is required in stage {stage_id}")
    # "next" is only ever offered to a stage that declares targets, so a value
    # off that list is a real miss. A stage with no branch ignores the key.
    nxt, allowed = card.get("next"), st.get("next_allowed", [])
    if nxt is not None and allowed and nxt not in allowed:
        errs.append(f"next {nxt!r} is not one of {', '.join(allowed)}")
    return errs


def apply_stage(session_id: str, to_stage: str, by: str, turn_id: str = "") -> None:
    """Move the session's stage and journal it. Mirrors runner._journal_one:
    append to the store for history, publish for the live stream."""
    from bridge import pubsub
    sess = store.get_session(session_id) or {}
    turn_id = turn_id or store.latest_turn_id(session_id) or ""
    ev = {"type": "stage", "from": sess.get("stage"), "to": to_stage, "by": by}
    store.set_session_stage(session_id, to_stage)
    seq = store.append_event(session_id, turn_id, ev)
    pubsub.publish(f"session:{session_id}", {**ev, "seq": seq, "turn_id": turn_id})


def retype(session_id: str, stype: "str | None") -> bool:
    """Change (or clear) a session's type, starting the new flow at stage one.
    The classifier reads one message and can be wrong; this is the way out.
    False when the stype names no flow. Clearing is CHAT: no type, no stage."""
    from bridge import pubsub
    f = get_flow(stype) if stype else None
    if stype and not f:
        return False
    sess = store.get_session(session_id) or {}
    to = first_stage(f) if f else None
    ev = {"type": "retype", "from": sess.get("stype"), "to": stype,
          "stage": to, "by": "user"}
    store.set_session_stype(session_id, stype)
    store.set_session_stage(session_id, to)
    turn_id = store.latest_turn_id(session_id) or ""
    seq = store.append_event(session_id, turn_id, ev)
    pubsub.publish(f"session:{session_id}", {**ev, "seq": seq, "turn_id": turn_id})
    return True


# --- what the runner calls --------------------------------------------------

def section_for(session: "dict | None") -> str:
    """The flow block for a session's current stage; "" for a plain chat."""
    f = get_flow((session or {}).get("stype"))
    return compose_section(f, session.get("stage")) if f else ""


def permission_for(session: "dict | None", fallback: "str | None") -> "str | None":
    """The stage's permission mode when it sets one, else the session's own.
    This is what gives a gate teeth: OPS states before it executes, FIX only
    accepts edits once its diagnosis has been approved."""
    f = get_flow((session or {}).get("stype"))
    return (stage_permission(f, session.get("stage")) or fallback) if f else fallback


_NUDGE_PREFIX = "⟲ flow:"
_NUDGE = (_NUDGE_PREFIX + " your last reply carried no usable hud-card block "
          "({why}). End the reply with the hud-card block for stage {stage}, "
          "restating what that turn already did. Do not redo the work.")


def after_turn(job, model=None, effort=None) -> None:
    """Called once per finished turn, next to goals.continue_after_turn.

    Parses the reply's card, journals it, stamps the turn with the stage it ran
    under, and advances ungated stages the model asked to leave. A missing or
    malformed card costs one nudge turn — never the work: a second failure just
    renders as prose. Best-effort throughout; a flow must not break a run."""
    try:
        sid = getattr(job, "store_session_id", None)
        if not sid or job.status != "done" or getattr(job, "interrupted", False):
            return
        sess = store.get_session(sid) or {}
        f = get_flow(sess.get("stype"))
        # The stage the turn was COMPOSED under, not where the session sits
        # now: an auto-classify verdict (bridge/flowtype.py) or a manual stage
        # move can land mid-turn, and a turn that never saw a stage's contract
        # must not be nudged for missing its card.
        stage = getattr(job, "flow_stage", None)
        if not f or not stage or not stage_by_id(f, stage):
            return
        text = job.result or (job.texts[-1] if job.texts else "")
        card = parse_card(text)
        errs = validate_card(f, stage, card) if card else ["no hud-card block"]
        if not errs:
            job.add({"type": "card", "card": card, "stage": stage,
                     "gated": bool(stage_by_id(f, stage).get("gate"))})
            store.set_turn_stage(job.id, stage)
            st = stage_by_id(f, stage)
            if st.get("gate"):
                return                       # gated: only the user moves this
            nxt = card.get("next")
            if nxt in st.get("next_allowed", []):
                apply_stage(sid, nxt, "auto", turn_id=job.id)
            elif card.get("advance") is True:
                apply_stage(sid, next_stage(f, stage), "auto", turn_id=job.id)
            return
        job.add({"type": "card_missing", "errors": errs[:4]})
        if (store.turn_prompt(job.id) or "").startswith(_NUDGE_PREFIX):
            return                      # the nudge itself missed: let it be prose
        from bridge import queue_manager   # local import: runner<->* cycle
        text = _NUDGE.format(why="; ".join(errs[:2]), stage=stage)
        queue_manager.enqueue(
            sid, text=text, prompt=text, images=[], model=model, effort=effort,
            permission_mode=sess.get("permission_mode"), width=None, sel=[],
            surface="flow", chat_id=job.chat_id, project=sess.get("project") or "")
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[flow] after_turn failed: {e}", file=sys.stderr)


# --- plain text, for the surface without cards ------------------------------

def strip_card(text: "str | None") -> str:
    """The reply without its hud-card block. The bot has nowhere to render a
    card, so it gets the prose and a rendering of the card underneath."""
    return _CARD_RE.sub("", text or "").strip()


def render_card(card: dict) -> str:
    """A card as Telegram-safe sections: the summary, then a line per field."""
    lines = [f"▸ {str(card.get('summary') or '').strip()}"]
    for name, val in (card.get("fields") or {}).items():
        lines.append(f"{name.upper()}: {_flat(val)}")
    return "\n".join(lines)


def _flat(v) -> str:
    """A card value as one line. Typed fields arrive as lists of objects, so a
    row prints its own values rather than its JSON — the bot has no widgets."""
    if isinstance(v, bool):
        return "✓" if v else "✗"
    if isinstance(v, list):
        return ", ".join(_flat(x) for x in v)
    if isinstance(v, dict):
        return " ".join(_flat(x) for x in v.values() if x not in (None, ""))
    return str(v)
