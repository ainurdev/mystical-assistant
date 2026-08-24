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
        if not isinstance(s.get("card_fields", []), list):
            errs.append(f"stages[{i}].card_fields must be a list")
        pm = s.get("permission_mode")
        if pm is not None and pm not in _PERM_MODES:
            errs.append(f"stages[{i}].permission_mode must be one of {_PERM_MODES}")
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
                        "gate": bool(s.get("gate"))} for s in f["stages"]],
        })
    return {"enabled": enabled(), "flows": out}


def save_custom(stype: str, d) -> "list[str]":
    """Persist a customized or brand-new template; returns validation errors."""
    errs = validate_flow(d)
    if not errs and d.get("stype") != stype:
        errs.append("stype in the body must match the one being saved")
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
    fields = ", ".join(f'"{n}": ...' for n in s.get("card_fields", []))
    names = ", ".join(s.get("card_fields", [])) or "(none required)"
    gate = ('This stage is GATED: you may set "advance": true to request the '
            "move, but the user approves it — never assume approval or work "
            "past the gate."
            if s.get("gate") else
            'Setting "advance": true moves the flow on by itself.')
    return "\n\n".join([
        f"[flow] This is a typed {label} session. Stages: {rail}. "
        f"Current stage: {s.get('label', s['id'].upper())}.",
        s["instructions"].strip(),
        _CONTRACT.format(sid=s["id"], fields=fields, names=names),
        gate,
    ])


def parse_card(text: "str | None") -> "dict | None":
    """The LAST hud-card block in a reply, as a dict; None if absent or
    unparseable. Last wins because a turn that shows an example mid-reply
    still ends with the real one."""
    hits = _CARD_RE.findall(text) if text else []
    if not hits:
        return None
    try:
        d = json.loads(hits[-1])
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


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
    for name in (stage_by_id(f, stage_id) or {}).get("card_fields", []):
        if name not in fields:
            errs.append(f"fields.{name} is required in stage {stage_id}")
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
        stage = sess.get("stage")
        if not f or not stage or not stage_by_id(f, stage):
            return
        text = job.result or (job.texts[-1] if job.texts else "")
        card = parse_card(text)
        errs = validate_card(f, stage, card) if card else ["no hud-card block"]
        if not errs:
            job.add({"type": "card", "card": card, "stage": stage,
                     "gated": bool(stage_by_id(f, stage).get("gate"))})
            store.set_turn_stage(job.id, stage)
            if card.get("advance") is True and not stage_by_id(f, stage).get("gate"):
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
        if isinstance(val, list):
            val = ", ".join(str(v) for v in val)
        lines.append(f"{name.upper()}: {val}")
    return "\n".join(lines)
