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
