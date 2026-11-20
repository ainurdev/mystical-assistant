"""Flow settings: everything the prompt box's gear (the FLOWS sheet) sets, bridge-wide.

Kept on the bridge, not in a browser, so every browser, the Mac app and the Windows app
read the same values (ADR 0003). One JSON file beside the bridge DB, flow_settings.json,
written atomically like flows.json: a file rather than a table, so it needs no schema
change and a worktree's pinned BRIDGE_DB keeps its settings off the live ones.

Three global switches already had a home and keep it, env fallbacks included: FLOWS is
SKILL PATHS (aifeatures `router`), and AUTO PICKS and SMART ZONE stay aifeatures switches.
Everything else lives here: GUESS, NO KIND, whether a browser's kind presets were carried
over, and per flow its switch, its optional steps, NEXT, TICKETS and AUTO-START (the flows
that build as tickets; stored inverted, as `approve`, the switch it replaced) and its run defaults.

Why seeded rather than defaulted: the switches these replace (AUTO NEXT STEPS, TICKETS,
APPROVE BEFORE BUILD, REVIEW AFTER MERGE) were set by hand on some bridges, so an update
must read as the bridge did before it. A value missing from the file is seeded from its
switch on the first read and written, so it stops following that switch from then on.
A flow's run is the exception: it is stored only once set (the sheet, a reset clears it,
or a browser's presets), so "no saved run" is a state, and the box's built-in kind preset
answers until then. Reset puts a flow back to those seeds.

Readers are the step engine (paths), the ticket scheduler and the dashboard; tickets 04
to 08 of flow-gear wire their own keys in. Stdlib only.
"""

import copy
import json
import os
import re
import sys
import threading

from bridge import aifeatures, config, outputstyles

FLOWS = ("design", "build", "refactor", "fix", "ship", "ask")
# The flows that build as tickets: they have TICKETS and AUTO-START (`approve`, inverted).
TICKET_FLOWS = ("design", "build", "refactor")
# Each flow's steps as the sheet names them, (step, fixed). A fixed step is the one its
# flow exists for and always runs. One chip may stand for several of paths.PATHS'
# stations: DESIGN's and BUILD's build is spec › tickets › build › merge, or build here.
STEPS = {
    "design": (("grill", False), ("design", True), ("build", False), ("review", False), ("retro", False)),
    "build": (("grill", False), ("build", True), ("review", False), ("retro", False), ("audit", False)),
    "refactor": (("improve", True), ("build", True), ("review", False), ("retro", False), ("audit", False)),
    "fix": (("diagnose", True), ("review", False), ("retro", False)),
    "ship": (("ship", True),),
    "ask": (("answer", True),),
}
# The box's built-in kind presets (web lib/kinds.ts KINDS), REFACTOR with BUILD's. mode ""
# is the session's own: a guess must never make a Bypass session ask. trim "" = default.
# style "" is the session's own too (bridge/outputstyles.py).
_OPUS, _SONNET = "claude-opus-5-5", "claude-sonnet-5-5"
BUILT_IN = {
    "design": {"model": _OPUS, "mode": "", "effort": "high", "trim": "", "style": ""},
    "build": {"model": _OPUS, "mode": "bypassPermissions", "effort": "max", "trim": "", "style": ""},
    "refactor": {"model": _OPUS, "mode": "bypassPermissions", "effort": "max", "trim": "", "style": ""},
    "fix": {"model": _OPUS, "mode": "bypassPermissions", "effort": "max", "trim": "", "style": ""},
    "ship": {"model": _OPUS, "mode": "bypassPermissions", "effort": "high", "trim": "", "style": ""},
    "ask": {"model": _SONNET, "mode": "", "effort": "medium", "trim": "", "style": ""},
}
# Global keys kept here, with their choices (the first is the default).
CHOICES = {"guess": ("auto", "hand"), "nokind": ("claude", "typed")}
# Global switches kept where they always were (aifeatures), env fallbacks and all.
SWITCHES = {"on": "router", "autopick": "autopick", "smartzone": "smartzone"}
_RUN = {
    "model": lambda v: bool(re.fullmatch(r"[\w.\-\[\]]{1,80}", v)),
    "mode": lambda v: v == "" or v in config.MINIAPP_PERMISSION_MODES,
    "effort": lambda v: v == "" or v in config.MINIAPP_EFFORTS,
    "trim": lambda v: v in ("", "off", "lite", "full", "ultra"),
    "style": lambda v: v == "" or bool(outputstyles.NAME_RE.fullmatch(v)),
}
_BOOLS = ("on", "next", "tickets", "approve")
# A browser's saved kind preset names its fields as the box does (lib/kinds KindRun).
_BROWSER = {"model": "model", "perm": "mode", "effort": "effort", "ponytail": "trim", "style": "style"}

_lock = threading.Lock()
_cache: dict = {}   # emptied by tests to simulate a reload


def _file() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "flow_settings.json")


def _seed(flow: str) -> dict:
    """What a flow reads before anyone set it: the switches it replaces."""
    s = {"on": True, "next": aifeatures.enabled("nextstep"),
         "steps": {st: True for st, fixed in STEPS[flow] if not fixed}}
    if flow in TICKET_FLOWS:
        s["tickets"] = aifeatures.enabled("ticketruns")
        s["approve"] = aifeatures.enabled("ticketapprove")
        s["steps"]["review"] = aifeatures.enabled("mergereview")
    return s


def _load_locked() -> dict:
    if _cache:
        return _cache
    try:
        with open(_file(), encoding="utf-8") as f:
            raw = json.load(f)
        raw = raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        raw = {}
    saved = raw.get("flows") if isinstance(raw.get("flows"), dict) else {}
    _cache.update({k: raw[k] if raw.get(k) in c else c[0] for k, c in CHOICES.items()})
    _cache["presets"] = bool(raw.get("presets"))
    _cache["flows"] = {}
    for fl in FLOWS:
        own = saved.get(fl) if isinstance(saved.get(fl), dict) else {}
        seed = _seed(fl)
        f = {k: bool(own[k]) if k in own else v for k, v in seed.items() if k != "steps"}
        steps = own.get("steps") if isinstance(own.get("steps"), dict) else {}
        f["steps"] = {st: bool(steps[st]) if st in steps else v for st, v in seed["steps"].items()}
        if isinstance(own.get("run"), dict):
            f["run"] = {k: str(own["run"].get(k, BUILT_IN[fl][k])) for k in _RUN}
        _cache["flows"][fl] = f
    if _cache != raw:
        _save_locked()   # seeded once: from now on a value no longer follows its old switch
    return _cache


def _save_locked() -> None:
    try:
        os.makedirs(os.path.dirname(_file()), exist_ok=True)
        tmp = _file() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_cache, f, indent=2)
        os.replace(tmp, _file())
    except OSError as e:
        print(f"[flowsettings] persist failed: {e}", file=sys.stderr)   # the in-memory value still holds


def _flow(flow: str) -> dict:
    """A copy: change() on another thread edits the cached one in place."""
    with _lock:
        return copy.deepcopy(_load_locked()["flows"][flow])


# --- the questions -------------------------------------------------------------

def flows_on() -> bool:
    return aifeatures.enabled("router")


def guess() -> str:
    """"auto": the box guesses a flow as you type; "hand": only a tap or Tab picks one."""
    with _lock:
        return _load_locked()["guess"]


def nokind() -> str:
    """"claude": Claude picks a flow for a prompt sent with none; "typed": it picks nothing."""
    with _lock:
        return _load_locked()["nokind"]


def flow_on(flow: str) -> bool:
    return flow in FLOWS and _flow(flow)["on"]


def steps(flow: str) -> dict:
    """Each step of the flow: on or off (a fixed step is always on)."""
    f = _flow(flow)
    return {st: fixed or f["steps"][st] for st, fixed in STEPS[flow]}


def next_auto(flow: str) -> bool:
    """NEXT: whether the flow's steps start by themselves."""
    return _flow(flow)["next"]


def tickets(flow: str) -> bool:
    """TICKETS: whether approved tickets build as sessions (flows that build as tickets only)."""
    return bool(_flow(flow).get("tickets"))


def approve(flow: str) -> bool:
    """Whether the tickets wait for your tap: the FLOWS sheet's AUTO-START, off."""
    return bool(_flow(flow).get("approve"))


def run(flow: str) -> dict:
    """The flow's run defaults: model, mode, effort, trim and style. A run saved before
    styles existed reads its style as the session's own."""
    return {**BUILT_IN[flow], **(_flow(flow).get("run") or {})}


def presets_taken() -> bool:
    """Whether a browser's kind presets have been carried over (once per bridge)."""
    with _lock:
        return _load_locked()["presets"]


def state() -> dict:
    """Every setting, and each flow's steps as they stand, for GET /local/flows. While
    PONYTAIL is off a step that is the ponytail plugin's won't run: marked True when it
    is in every form of its flow (AUDIT, FIX's REVIEW), "here" when only in the here
    build's (DESIGN's and BUILD's REVIEW: after tickets merge it is the council's)."""
    from bridge import paths   # local import: paths reads these settings
    pony_off = not aifeatures.enabled("ponytail")

    def pony(fl: str, st: str) -> "bool | str":
        p = [(s.skill or "").startswith("ponytail-")
             for f in (fl, fl + "-here") for s in paths.PATHS.get(f, ()) if s.station == st]
        return bool(p) and all(p) or ("here" if any(p) else False)
    with _lock:
        c = _load_locked()
        out = {k: c[k] for k in CHOICES}
        out["presets"] = c["presets"]
        flows = [{"id": fl, **{k: v for k, v in f.items() if k not in ("steps", "run")},
                  "run": {**BUILT_IN[fl], **(f.get("run") or {})}, "run_saved": "run" in f,
                  "steps": [{"step": st, "fixed": fixed, "on": fixed or f["steps"][st],
                             "ponytail_off": pony_off and pony(fl, st)} for st, fixed in STEPS[fl]]}
                 for fl, f in c["flows"].items()]
    return {**out, **{k: aifeatures.enabled(sw) for k, sw in SWITCHES.items()}, "flows": flows}


# --- changes -------------------------------------------------------------------

def change(body: dict) -> None:
    """One change from POST /local/flows. ValueError says what was wrong with it.
      {"key": <global>, "value": v}                    FLOWS, AUTO PICKS, SMART ZONE, GUESS, NO KIND
      {"flow": f, "key": <flow key>, "value": v}       on, next, tickets, approve, model, mode, effort, trim, style
      {"flow": f, "key": "run", "value": {model, mode, effort, trim, style}}  all of them, or none
      {"flow": f, "key": "step", "step": s, "value": b}  an optional step on or off
      {"reset": f}                                     back to its seeds, its run unset
      {"presets": {<kind>: {model, perm, effort, ponytail, style}}}  a browser's, taken once"""
    if not isinstance(body, dict):
        raise ValueError("the body must be an object")
    if "presets" in body:
        return _take_presets(body["presets"])
    if "reset" in body:
        fl = body["reset"]
        if fl not in FLOWS:
            raise ValueError(f"unknown flow {fl!r}")
        with _lock:
            _load_locked()["flows"][fl] = _seed(fl)
            _save_locked()
        return
    key, value = body.get("key"), body.get("value")
    if "flow" not in body:
        if key in SWITCHES:
            if not isinstance(value, bool):
                raise ValueError(f"{key} takes true or false")
            return aifeatures.set_enabled(SWITCHES[key], value)
        if key not in CHOICES:
            raise ValueError(f"unknown setting {key!r}")
        if value not in CHOICES[key]:
            raise ValueError(f"{key} takes one of {', '.join(CHOICES[key])}")
        with _lock:
            _load_locked()[key] = value
            _save_locked()
        return
    fl = body["flow"]
    if fl not in FLOWS:
        raise ValueError(f"unknown flow {fl!r}")
    with _lock:
        f = _load_locked()["flows"][fl]
        if key == "step":
            st = body.get("step")
            fixed = dict(STEPS[fl]).get(st)
            if fixed is None:
                raise ValueError(f"{fl.upper()} has no step {st!r}")
            if fixed:
                raise ValueError(f"{st} always runs in {fl.upper()}")
            if not isinstance(value, bool):
                raise ValueError("a step takes true or false")
            f["steps"][st] = value
        elif key in _BOOLS:
            if key in ("tickets", "approve") and fl not in TICKET_FLOWS:
                raise ValueError(f"{fl.upper()} doesn't build as tickets")
            if not isinstance(value, bool):
                raise ValueError(f"{key} takes true or false")
            f[key] = value
        elif key in _RUN or key == "run":   # "run": PRESET's Save as, checked whole before any lands
            new = value if key == "run" else {key: value}
            if not isinstance(new, dict) or not new:
                raise ValueError("run takes an object of model, mode, effort, trim and style")
            for k, v in new.items():
                if k not in _RUN:
                    raise ValueError(f"unknown run setting {k!r}")
                if not isinstance(v, str) or not _RUN[k](v):
                    raise ValueError(f"{v!r} isn't a {k}")
            f["run"] = {**(f.get("run") or BUILT_IN[fl]), **new}
        else:
            raise ValueError(f"unknown flow setting {key!r}")
        _save_locked()


def _take_presets(presets) -> None:
    """A browser's saved kind presets, once per bridge, and only for flows with no saved
    run: a second browser's, or one sent after the sheet set a run, changes nothing."""
    if not isinstance(presets, dict):
        raise ValueError("presets must be an object")
    runs = {}
    for fl, p in presets.items():
        if fl not in FLOWS:
            continue   # a kind this bridge doesn't know: nothing to carry
        if not isinstance(p, dict):
            raise ValueError(f"{fl}'s preset must be an object")
        r = {}
        for k, v in p.items():
            if k in _BROWSER:
                if not isinstance(v, str) or not _RUN[_BROWSER[k]](v):
                    raise ValueError(f"{fl}'s {k} {v!r} isn't valid")
                r[_BROWSER[k]] = v
        runs[fl] = r
    if "build" in runs:
        runs.setdefault("refactor", runs["build"])   # the box had no REFACTOR: it starts as BUILD's
    with _lock:
        c = _load_locked()
        if c["presets"]:
            return
        for fl, r in runs.items():
            if r and "run" not in c["flows"][fl]:
                c["flows"][fl]["run"] = {**BUILT_IN[fl], **r}
        c["presets"] = True
        _save_locked()
