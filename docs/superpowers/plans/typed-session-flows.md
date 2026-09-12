# Typed Session Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions can carry a type (BUILD/FIX/PROBE/OPS/REVIEW/DESIGN) whose server-owned stage engine injects per-stage instructions, validates a `hud-card` reply block, holds gates until user approval, and renders as cards/rails/chips across dashboard, Mini App, and bot — with templates user-editable from settings.

**Architecture:** New `bridge/flow.py` engine + `bridge/flows/*.json` built-ins overlaid by `flow:<stype>` rows in the existing `settings` table; master toggle is a `flows` entry in the existing `aifeatures` registry. Runner injects the current stage's contract via the existing `--append-system-prompt` path and hooks post-turn next to `goals.continue_after_turn`. Events ride the existing journal (persist + SSE in one hop); no server-side event whitelist exists, so new `card`/`stage` events reach frontends automatically — only the TS unions and render switches need arms.

**Tech Stack:** Python stdlib only (backend), React+TS (two independent Vite apps: dashboard + Mini App), SQLite, pytest.

**Spec:** `docs/superpowers/specs/2026-08-24-typed-session-flows-design.md`

## Global Constraints

- Backend is Python stdlib only — no new dependencies anywhere.
- Work in a git worktree with its own scratch DB (bridge-worktree skill): new persisted columns must never touch the live `~/.bridge_state` DB during development.
- Test suite baseline is fully green (1107 tests) — anything red is your change.
- Env-read config must be pinned in `tests/conftest.py` BEFORE any `bridge.*` import, never in a test module preamble (config freezes settings into module constants at import time).
- Deliberate shortcuts get a `ponytail:` comment naming the ceiling.
- NEVER add Claude as co-author on commits — no `Co-Authored-By`, no "Generated with Claude Code".
- Frontend typecheck is `npx tsc -p tsconfig.app.json` (plain `tsc -p .` checks nothing).
- Route matching in both servers is manual string work — order matters; specific suffixes go above `startswith` catch-alls.
- The running bridge is a code snapshot from launch: nothing here is live until a bridge restart (bridge-ship skill). Flow JSON edits, once shipped, ARE live per-turn.

---

### Task 1: Store — stype/stage columns + accessors

**Files:**
- Modify: `bridge/store.py` (schema `:22-42`, migration block in `init()` `:120-168`, `create_session` `:203`, accessors near `set_lifecycle` `:658`, settings helpers near `:572`)
- Test: `tests/test_flow.py` (new)

**Interfaces:**
- Produces: `create_session(..., stype=None, stage=None)`; `set_session_stage(session_id, stage)`; `set_turn_stage(turn_id, stage)`; `turn_prompt(turn_id) -> str | None`; `settings_with_prefix(prefix) -> dict[str, str]`. Sessions/turn rows carry `stype`/`stage` automatically (`get_session` is `SELECT *`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_flow.py` (env pinning mirrors `tests/test_bridge.py:15-26` — conftest already pins, but the module must stay import-safe when run directly):

```python
"""Typed-session flow engine: store columns, definitions, engine, transitions."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import store   # noqa: E402

store.init()


def test_create_session_carries_stype_and_stage():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    assert s["stype"] == "fix" and s["stage"] == "reproduce"
    plain = store.create_session(555, "/p")
    assert plain["stype"] is None and plain["stage"] is None


def test_set_session_stage_roundtrip():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    store.set_session_stage(s["id"], "rootcause")
    assert store.get_session(s["id"])["stage"] == "rootcause"


def test_turn_stage_stamp_and_prompt():
    s = store.create_session(555, "/p", stype="fix", stage="fix")
    store.start_turn(s["id"], "t1", "do the thing", [])
    store.set_turn_stage("t1", "fix")
    assert store.turn_prompt("t1") == "do the thing"
    row = store.transcript(s["id"])["turns"][0]
    assert row["stage"] == "fix"


def test_settings_with_prefix():
    store.set_setting("flow:zap", "{}")
    store.set_setting("other", "x")
    got = store.settings_with_prefix("flow:")
    assert got == {"flow:zap": "{}"}
    store.set_setting("flow:zap", None)
    assert store.settings_with_prefix("flow:") == {}
```

Note: if `store.transcript(...)["turns"]` rows turn out not to include every column, assert via `store._connect()` directly like `test_lists_exclude_sessions_idle_past_window` does (`tests/test_bridge.py:37-40`) — the deliverable is the stamped column, not the transcript shape.

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_flow.py -q`
Expected: FAIL — `create_session() got an unexpected keyword argument 'stype'`.

- [ ] **Step 3: Implement**

In `bridge/store.py`:

1. `_SCHEMA` sessions block (after `autocompact TEXT` at `:41`): add
```sql
  stype             TEXT,
  stage             TEXT
```
and in the turns block (after `tok_cache_r INTEGER` `:62`): add `stage TEXT` — mind trailing commas.

2. Migration in `init()` — append after the `work_cwd` stanza (`:166-167`), same idempotent style:
```python
        # Typed-session flow: which flow this session runs (NULL = plain chat)
        # and which of its stages the next turn composes at ('done' = finished).
        for col in ("stype", "stage"):
            if col not in scols:
                c.execute(f"ALTER TABLE sessions ADD COLUMN {col} TEXT")
        # Which stage a turn ran under, stamped post-turn (NULL = untyped/legacy).
        if "stage" not in cols:
            c.execute("ALTER TABLE turns ADD COLUMN stage TEXT")
```

3. `create_session` (`:203`) — add keyword params `stype: str | None = None, stage: str | None = None`, extend the INSERT columns/values:
```python
def create_session(chat_id: int, project: str, *, session_id: str | None = None,
                   origin: str | None = None, cwd: str | None = None,
                   permission_mode: str | None = None,
                   stype: str | None = None, stage: str | None = None) -> dict:
    sid = session_id or uuid.uuid4().hex
    now = time.time()
    with closing(_connect()) as c:
        c.execute(
            "INSERT INTO sessions(id,chat_id,project,claude_session_id,title,"
            "created,updated,archived,origin,cwd,permission_mode,stype,stage) "
            "VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?)",
            (sid, chat_id, project, None, None, now, now, origin, cwd,
             permission_mode, stype, stage))
    return get_session(sid)
```

4. Accessors, placed next to `set_lifecycle` (`:658`):
```python
def set_session_stage(session_id: str, stage: "str | None") -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET stage=? WHERE id=?", (stage, session_id))


def set_turn_stage(turn_id: str, stage: "str | None") -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE turns SET stage=? WHERE id=?", (stage, turn_id))


def turn_prompt(turn_id: str) -> "str | None":
    with closing(_connect()) as c:
        row = c.execute("SELECT prompt FROM turns WHERE id=?", (turn_id,)).fetchone()
    return row["prompt"] if row else None
```

5. Settings helper next to `get_setting` (`:572`):
```python
def settings_with_prefix(prefix: str) -> "dict[str, str]":
    """Every settings row whose key starts with prefix (used for flow:* overlays)."""
    with closing(_connect()) as c:
        rows = c.execute("SELECT key, value FROM settings WHERE key LIKE ?",
                         (prefix + "%",)).fetchall()
    return {r["key"]: r["value"] for r in rows}
```
(Confirm `set_setting(key, None)` deletes the row — read `set_setting` at `:578`; if it stores NULL instead of deleting, make None delete, matching how the flow-delete endpoint will use it.)

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_flow.py tests/test_bridge.py -q`
Expected: new tests PASS, existing suite untouched.

- [ ] **Step 5: Commit**

```bash
git add bridge/store.py tests/test_flow.py
git commit -m "feat(store): sessions carry a flow type and stage; turns stamp theirs"
```

---

### Task 2: Flow definitions, loader, validator, feature toggle

**Files:**
- Create: `bridge/flow.py`, `bridge/flows/{build,fix,probe,ops,review,design}.json`
- Modify: `bridge/config.py` (near `TITLE_ENABLE` `:139`), `bridge/aifeatures.py` (`FEATURES` tuple `:39`)
- Test: `tests/test_flow.py`

**Interfaces:**
- Consumes: `store.settings_with_prefix`, `store.get_setting/set_setting` (Task 1), `aifeatures.enabled(key)`.
- Produces: `flow.enabled() -> bool`; `flow.load_flows() -> dict[str, dict]` (merged, includes disabled); `flow.get_flow(stype) -> dict | None`; `flow.catalog() -> dict` (`{"enabled": bool, "flows": [shape…]}`); `flow.validate_flow(d) -> list[str]`; `flow.save_custom(stype, d) -> list[str]`; `flow.delete_custom(stype) -> bool`; `flow.first_stage(flow) -> str`; `flow.compose_first_prompt(flow, form) -> str`.

- [ ] **Step 1: Write the six flow JSONs**

`bridge/flows/fix.json`:
```json
{
  "stype": "fix",
  "label": "FIX",
  "blurb": "Hunt and kill a bug.",
  "form": [
    {"key": "what",  "label": "WHAT BROKE",  "required": true,  "multiline": true},
    {"key": "seen",  "label": "WHERE SEEN",  "required": false, "multiline": false},
    {"key": "repro", "label": "REPRO STEPS", "required": false, "multiline": true}
  ],
  "stages": [
    {"id": "reproduce", "label": "REPRODUCE", "gate": false,
     "instructions": "Reproduce the reported failure before touching anything. Find the smallest command, request, or test that shows it. If you cannot reproduce, say so with the evidence you gathered and do not advance.",
     "card_fields": ["reproduced", "evidence"]},
    {"id": "rootcause", "label": "ROOT-CAUSE", "gate": true,
     "instructions": "Trace the failure to its cause. Grep every caller of the function you suspect; the fix belongs where all callers route through, not on the one path the report names. State the cause and the fix you propose. Do not edit code in this stage.",
     "card_fields": ["cause", "fix_plan"]},
    {"id": "fix", "label": "FIX", "gate": false, "permission_mode": "acceptEdits",
     "instructions": "Apply the approved fix. Smallest diff that kills the root cause. List every file you changed.",
     "card_fields": ["changed"]},
    {"id": "verify", "label": "VERIFY", "gate": false,
     "instructions": "Prove the fix: rerun the reproduction, run the relevant tests. Report the exact commands and their results. Only claim pass on output you saw.",
     "card_fields": ["checks", "pass"]}
  ]
}
```

`bridge/flows/build.json`:
```json
{
  "stype": "build",
  "label": "BUILD",
  "blurb": "Ship a feature.",
  "form": [
    {"key": "what", "label": "WHAT", "required": true, "multiline": true},
    {"key": "why", "label": "WHY", "required": false, "multiline": false},
    {"key": "done", "label": "DONE WHEN", "required": false, "multiline": true}
  ],
  "stages": [
    {"id": "plan", "label": "PLAN", "gate": true,
     "instructions": "Read the code this touches and produce a short plan: approach, files, risks, how it will be verified. Do not write code in this stage.",
     "card_fields": ["approach", "files", "risks"]},
    {"id": "implement", "label": "IMPLEMENT", "gate": false, "permission_mode": "acceptEdits",
     "instructions": "Execute the approved plan. Match the surrounding code's style. List every file changed as you go.",
     "card_fields": ["changed"]},
    {"id": "verify", "label": "VERIFY", "gate": false,
     "instructions": "Run the tests and any 'done when' checks from the brief. Report exact commands and results; never claim pass without output.",
     "card_fields": ["checks", "pass"]},
    {"id": "ship", "label": "SHIP", "gate": true,
     "instructions": "Summarize what shipped and what the user should look at. Commit if the repo's conventions call for it; state the commit sha.",
     "card_fields": ["shipped"]}
  ]
}
```

`bridge/flows/probe.json`:
```json
{
  "stype": "probe",
  "label": "PROBE",
  "blurb": "Answer a question about the code or system.",
  "form": [
    {"key": "question", "label": "QUESTION", "required": true, "multiline": true},
    {"key": "depth", "label": "DEPTH (quick/deep)", "required": false, "multiline": false}
  ],
  "stages": [
    {"id": "dig", "label": "DIG", "gate": false,
     "instructions": "Investigate. Read the code, run read-only commands, follow the evidence. Avoid mutating anything. Note findings as you go; advance when you can answer.",
     "card_fields": ["findings"]},
    {"id": "report", "label": "REPORT", "gate": false,
     "instructions": "Answer the question directly, then the evidence (file:line, command output). End with a recommendation and how confident you are.",
     "card_fields": ["answer", "recommendation", "confidence"]}
  ]
}
```

`bridge/flows/ops.json`:
```json
{
  "stype": "ops",
  "label": "OPS",
  "blurb": "Run a chore: restart, deploy, config, cleanup.",
  "form": [
    {"key": "task", "label": "TASK", "required": true, "multiline": true}
  ],
  "stages": [
    {"id": "state", "label": "STATE", "gate": true,
     "instructions": "State exactly what will be executed and what it affects — commands, targets, blast radius, rollback. Execute nothing in this stage.",
     "card_fields": ["will_do", "blast_radius"]},
    {"id": "execute", "label": "EXECUTE", "gate": false,
     "instructions": "Run exactly what was approved, nothing more. Capture the output of each command.",
     "card_fields": ["ran"]},
    {"id": "confirm", "label": "CONFIRM", "gate": false,
     "instructions": "Verify the world is in the intended state (service up, config live, files gone). Show the checks and their output.",
     "card_fields": ["checks", "ok"]}
  ]
}
```

`bridge/flows/review.json`:
```json
{
  "stype": "review",
  "label": "REVIEW",
  "blurb": "Review a branch, PR, or path.",
  "form": [
    {"key": "target", "label": "TARGET (branch/PR/path)", "required": true, "multiline": false},
    {"key": "depth", "label": "DEPTH (quick/thorough)", "required": false, "multiline": false}
  ],
  "stages": [
    {"id": "sweep", "label": "SWEEP", "gate": false,
     "instructions": "Read the target's diff or code fully before judging. Collect candidate findings with file:line anchors; verify each against the actual code before keeping it.",
     "card_fields": ["findings"]},
    {"id": "report", "label": "REPORT", "gate": false,
     "instructions": "Report surviving findings ranked by severity: file, line, what breaks, and the concrete failure scenario. Zero findings is a valid result — say so plainly.",
     "card_fields": ["findings", "verdict"]}
  ]
}
```

`bridge/flows/design.json`:
```json
{
  "stype": "design",
  "label": "DESIGN",
  "blurb": "Design before code, then build the approved design.",
  "form": [
    {"key": "brief", "label": "BRIEF", "required": true, "multiline": true}
  ],
  "stages": [
    {"id": "draft", "label": "DRAFT", "gate": true,
     "instructions": "Invoke the /design-first skill with the brief and follow it: brand-system mockups, screenshots into the transcript, push to the linked design project. Stop for approval — that approval is this stage's gate.",
     "card_fields": ["screens"]},
    {"id": "implement", "label": "IMPLEMENT", "gate": false, "permission_mode": "acceptEdits",
     "instructions": "Implement the approved design in the repo. List every file changed.",
     "card_fields": ["changed"]},
    {"id": "verify", "label": "VERIFY", "gate": false,
     "instructions": "Screenshot the built UI (bridge-eyes) and compare against the approved draft. Run the frontend typecheck and build. Report results with evidence.",
     "card_fields": ["checks", "pass"]}
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/test_flow.py`:

```python
from bridge import flow   # noqa: E402


def test_builtins_load_and_validate():
    flows = flow.load_flows()
    assert set(flows) >= {"build", "fix", "probe", "ops", "review", "design"}
    for f in flows.values():
        assert flow.validate_flow(f) == []


def test_settings_overlay_wins_and_delete_restores():
    fix = dict(flow.load_flows()["fix"])
    fix["blurb"] = "custom"
    assert flow.save_custom("fix", fix) == []
    assert flow.load_flows()["fix"]["blurb"] == "custom"
    assert flow.get_flow("fix")["blurb"] == "custom"
    assert flow.delete_custom("fix") is True
    assert flow.load_flows()["fix"]["blurb"] != "custom"


def test_new_custom_type_and_disable():
    zap = {"stype": "zap", "label": "ZAP", "blurb": "b", "form": [],
           "stages": [{"id": "go", "label": "GO", "gate": False,
                       "instructions": "x", "card_fields": []}]}
    assert flow.save_custom("zap", zap) == []
    assert "zap" in {f["stype"] for f in flow.catalog()["flows"]}
    zap["disabled"] = True
    flow.save_custom("zap", zap)
    assert "zap" not in {f["stype"] for f in flow.catalog()["flows"]}
    assert flow.get_flow("zap") is not None      # in-flight sessions keep it
    flow.delete_custom("zap")


def test_validate_flow_errors():
    bad = {"stype": "x!", "label": "", "form": "nope",
           "stages": [{"id": "a", "label": "A", "gate": "yes",
                       "instructions": "", "card_fields": []},
                      {"id": "a", "label": "B", "gate": False,
                       "instructions": "x", "card_fields": []}]}
    errs = flow.validate_flow(bad)
    joined = " ".join(errs)
    assert "stype" in joined and "form" in joined
    assert "duplicate" in joined and "gate" in joined


def test_catalog_shape_has_no_instructions():
    cat = flow.catalog()
    assert isinstance(cat["enabled"], bool)
    f = next(x for x in cat["flows"] if x["stype"] == "fix")
    assert f["form"][0]["key"] == "what"
    assert [s["id"] for s in f["stages"]][0] == "reproduce"
    assert "instructions" not in f["stages"][0]


def test_compose_first_prompt():
    f = flow.get_flow("fix")
    p = flow.compose_first_prompt(f, {"what": "boom", "repro": "run x"})
    assert p.startswith("[FIX]")
    assert "WHAT BROKE: boom" in p and "REPRO STEPS: run x" in p
    assert "WHERE SEEN" not in p        # empty fields are omitted
```

Run: `python3 -m pytest tests/test_flow.py -q` — expected: FAIL, `bridge.flow` doesn't exist.

- [ ] **Step 3: Implement `bridge/flow.py` (definitions half)**

```python
"""Typed-session flows: definitions, the stage engine, and the reply contract.

A flow is data (bridge/flows/*.json, overlaid by flow:<stype> settings rows),
not code: the server owns which stage a session is in, injects only that
stage's contract into each turn, and decides transitions — the model requests
advancement, gates wait for the user. Everything is loaded per call rather
than frozen at import, so a template edit is live on the next turn without a
bridge restart. Stdlib only.
"""

import json
import os
import re

from bridge import aifeatures, store

FLOWS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flows")
_STYPE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,23}$")
_PERM_MODES = ("default", "acceptEdits", "plan", "bypassPermissions")


def enabled() -> bool:
    return aifeatures.enabled("flows")


def validate_flow(d) -> "list[str]":
    """Human-readable problems with a flow dict; [] means valid."""
    errs: list[str] = []
    if not isinstance(d, dict):
        return ["flow must be a JSON object"]
    st = d.get("stype")
    if not isinstance(st, str) or not _STYPE_RE.match(st):
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
        if not isinstance(sid, str) or not _STYPE_RE.match(sid):
            errs.append(f"stages[{i}].id must be lowercase [a-z0-9_-]")
        elif sid in seen:
            errs.append(f"stages[{i}].id '{sid}' is a duplicate")
        else:
            seen.add(sid)
        if sid == "done":
            errs.append("'done' is reserved for the finished state")
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
    fully replaces the built-in of the same stype). Includes disabled flows —
    creation UIs filter via catalog(); in-flight sessions still resolve."""
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
            continue                      # a broken file never takes the bridge down
        if isinstance(d, dict) and not validate_flow(d):
            flows[d["stype"]] = d
    for key, raw in store.settings_with_prefix("flow:").items():
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get("stype") == key[len("flow:"):] \
                and not validate_flow(d):
            d["_custom"] = True
            flows[d["stype"]] = d
    return flows


def get_flow(stype: "str | None") -> "dict | None":
    if not stype:
        return None
    return load_flows().get(stype)


def catalog() -> dict:
    """What creation and settings UIs need: master flag + per-flow shape
    (no stage instructions — UIs need form and rail, not prompts)."""
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
    errs = validate_flow(d)
    if not errs and d.get("stype") != stype:
        errs.append("stype in the body must match the URL")
    if errs:
        return errs
    clean = {k: v for k, v in d.items() if k != "_custom"}
    store.set_setting(f"flow:{stype}", json.dumps(clean))
    return []


def delete_custom(stype: str) -> bool:
    had = store.get_setting(f"flow:{stype}") is not None
    store.set_setting(f"flow:{stype}", None)
    return had


def first_stage(f: dict) -> str:
    return f["stages"][0]["id"]


def compose_first_prompt(f: dict, form: dict) -> str:
    """The typed session's opening prompt: labeled lines from the start form.
    Shared by dispatch (bot); the web surfaces build the same shape client-side."""
    lines = [f"[{f.get('label', f['stype'].upper())}]"]
    for field in f.get("form", []):
        val = str(form.get(field["key"], "") or "").strip()
        if val:
            lines.append(f"{field['label']}: {val}")
    return "\n".join(lines)
```

- [ ] **Step 4: Register the feature toggle**

`bridge/config.py`, next to `TITLE_ENABLE` (`:139`), same idiom, default ON (fires only when a type is picked):
```python
FLOWS_ENABLE = os.environ.get("FLOWS_ENABLE", "1").lower() \
    not in ("0", "false", "no", "")
```

`bridge/aifeatures.py` — append to `FEATURES` (`:39`, after the last entry, matching dict shape exactly):
```python
    {"key": "flows", "env": "FLOWS_ENABLE", "label": "TYPED FLOWS",
     "hint": "typed sessions: forms in, stage gates, reply cards out",
     "cost": "prompt tokens on every turn of a typed session",
     "tokens": "~1k tokens per turn",
     "about": "Start a session as BUILD, FIX, PROBE, OPS, REVIEW or DESIGN "
              "instead of plain chat: a short form shapes the first prompt, the "
              "server walks the session through that type's stages, replies end "
              "in a structured card with tappable next actions, and gated stages "
              "wait for your approval. Off, the type picker and FLOWS settings "
              "are hidden; sessions already mid-flow keep their engine so work "
              "is never stranded."},
```
Check `aifeatures.enabled` (`:170`) resolves `env` via `getattr(config, ...)` — if it reads the config attribute by name, `FLOWS_ENABLE` above is all it needs.

Also pin the env in `tests/conftest.py` alongside the other pins (`FLOWS_ENABLE` → `"1"`), since config freezes it at import.

- [ ] **Step 5: Run tests, commit**

Run: `python3 -m pytest tests/test_flow.py tests/test_bridge.py -q` — expected PASS.

```bash
git add bridge/flow.py bridge/flows bridge/config.py bridge/aifeatures.py tests/test_flow.py tests/conftest.py
git commit -m "feat(flow): six flow definitions, settings overlay, TYPED FLOWS feature switch"
```

---

### Task 3: Engine — compose section, card parse/validate, transitions

**Files:**
- Modify: `bridge/flow.py`
- Test: `tests/test_flow.py`

**Interfaces:**
- Consumes: Task 2's loaders; `store.set_session_stage`, `store.append_event`, `pubsub.publish`.
- Produces: `flow.compose_section(f, stage_id) -> str`; `flow.parse_card(text) -> dict | None`; `flow.validate_card(f, stage_id, card) -> list[str]`; `flow.stage_by_id(f, stage_id) -> dict | None`; `flow.next_stage(f, stage_id) -> str | None`; `flow.stage_permission(f, stage_id) -> str | None`; `flow.apply_stage(session_id, to_stage, by, turn_id="") -> None` (writes + emits + publishes the `stage` event).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_flow.py`:

```python
CARD = """Did the work.

```hud-card
{"stage": "fix", "summary": "patched", "fields": {"changed": ["a.py"]},
 "advance": true, "actions": [{"label": "TEST", "send": "run tests"}]}
```"""


def test_parse_card_last_block_wins():
    two = CARD + "\n\n```hud-card\n{\"stage\": \"verify\", \"summary\": \"s\", \"fields\": {}}\n```"
    assert flow.parse_card(two)["stage"] == "verify"
    assert flow.parse_card("no card here") is None
    assert flow.parse_card("```hud-card\nnot json\n```") is None


def test_validate_card_required_fields():
    f = flow.get_flow("fix")
    card = flow.parse_card(CARD)
    assert flow.validate_card(f, "fix", card) == []
    assert flow.validate_card(f, "verify", card)          # wrong stage
    bare = {"stage": "fix", "summary": "s", "fields": {}}
    assert any("changed" in e for e in flow.validate_card(f, "fix", bare))


def test_compose_section_has_only_current_stage():
    f = flow.get_flow("fix")
    s = flow.compose_section(f, "rootcause")
    assert "ROOT-CAUSE" in s and "hud-card" in s
    assert "Trace the failure" in s                        # current instructions
    assert "Apply the approved fix" not in s               # other stages' are not
    assert "approve" in s.lower()                          # gate rule present
    assert flow.compose_section(f, "done").count("\n") <= 2  # light note only


def test_next_stage_and_permission():
    f = flow.get_flow("fix")
    assert flow.next_stage(f, "reproduce") == "rootcause"
    assert flow.next_stage(f, "verify") == "done"
    assert flow.next_stage(f, "done") is None
    assert flow.stage_permission(f, "fix") == "acceptEdits"
    assert flow.stage_permission(f, "reproduce") is None


def test_apply_stage_writes_and_journals():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    store.start_turn(s["id"], "tf1", "x", [])
    flow.apply_stage(s["id"], "rootcause", "user", turn_id="tf1")
    assert store.get_session(s["id"])["stage"] == "rootcause"
    evs = store.transcript(s["id"])["events"]
    st = [e for e in evs if e["type"] == "stage"]
    assert st, "stage transition must be journaled"
    last = st[-1]
    payload = json.loads(last["payload"]) if isinstance(last.get("payload"), str) else last
    assert payload["from"] == "reproduce" and payload["to"] == "rootcause" \
        and payload["by"] == "user"
```

Before implementing, read how `store.transcript` re-emits event rows (`store.py:1013-1037`) — if it JSON-decodes `payload` into the event dict, drop the `json.loads` branch above so the test asserts the real shape directly.

Run: `python3 -m pytest tests/test_flow.py -q` — expected FAIL on missing functions.

- [ ] **Step 2: Implement the engine half of `bridge/flow.py`**

```python
_CARD_RE = re.compile(r"```hud-card\s*\n(.*?)```", re.DOTALL)

_CONTRACT = """End EVERY reply with exactly one fenced code block tagged hud-card:

```hud-card
{{"stage": "{sid}", "summary": "<one line: what this turn did>",
 "fields": {{{fields}}},
 "advance": <true only when this stage's work is fully complete>,
 "actions": [{{"label": "<SHORT VERB>", "send": "<prompt to run it>"}}]}}
```

"fields" must contain: {names}. "actions" are 0-3 canned next moves the user
can tap. Do not mention this block in prose; it is parsed, not read."""


def stage_by_id(f: dict, stage_id: "str | None") -> "dict | None":
    for s in f.get("stages", []):
        if s["id"] == stage_id:
            return s
    return None


def next_stage(f: dict, stage_id: "str | None") -> "str | None":
    ids = [s["id"] for s in f.get("stages", [])]
    if stage_id == "done" or stage_id not in ids:
        return None
    i = ids.index(stage_id)
    return ids[i + 1] if i + 1 < len(ids) else "done"


def stage_permission(f: dict, stage_id: "str | None") -> "str | None":
    s = stage_by_id(f, stage_id)
    return s.get("permission_mode") if s else None


def compose_section(f: dict, stage_id: "str | None") -> str:
    """The flow block appended to the system prompt: stage map, the CURRENT
    stage's instructions, and the card contract. Stable per (flow, stage), so
    the prompt cache is only invalidated on a transition."""
    label = f.get("label", f["stype"].upper())
    rail = " -> ".join(s.get("label", s["id"].upper()) for s in f["stages"])
    if stage_id == "done" or stage_by_id(f, stage_id) is None:
        return (f"[flow] This {label} session's flow is complete ({rail}). "
                f"The hud-card block is now optional.")
    s = stage_by_id(f, stage_id)
    fields = ", ".join(f'"{n}": ...' for n in s.get("card_fields", []))
    names = ", ".join(s.get("card_fields", [])) or "(none required)"
    gate = ("This stage is GATED: you may set \"advance\": true to request it, "
            "but the user must approve before the flow moves on — never assume "
            "approval or act past the gate."
            if s.get("gate") else
            "When you set \"advance\": true the flow moves on automatically.")
    return "\n\n".join([
        f"[flow] This is a typed {label} session. Stages: {rail}. "
        f"Current stage: {s.get('label', s['id'].upper())}.",
        s["instructions"].strip(),
        _CONTRACT.format(sid=s["id"], fields=fields, names=names),
        gate,
    ])


def parse_card(text: "str | None") -> "dict | None":
    """The LAST hud-card fenced block in the reply, as a dict; None if absent
    or unparseable."""
    if not text:
        return None
    hits = _CARD_RE.findall(text)
    if not hits:
        return None
    try:
        d = json.loads(hits[-1])
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def validate_card(f: dict, stage_id: str, card) -> "list[str]":
    # ponytail: required-keys check, not JSON Schema — upgrade if flows ever
    # need typed/nested field constraints.
    errs: list[str] = []
    if not isinstance(card, dict):
        return ["card must be a JSON object"]
    if card.get("stage") != stage_id:
        errs.append(f"card stage '{card.get('stage')}' != current '{stage_id}'")
    if not (card.get("summary") or "").strip():
        errs.append("summary is required")
    fields = card.get("fields")
    if not isinstance(fields, dict):
        errs.append("fields must be an object")
        fields = {}
    s = stage_by_id(f, stage_id) or {}
    for name in s.get("card_fields", []):
        if name not in fields:
            errs.append(f"fields.{name} is required in stage {stage_id}")
    return errs


def apply_stage(session_id: str, to_stage: str, by: str, turn_id: str = "") -> None:
    """Move the session's server-owned stage and journal the transition.
    Mirrors runner._journal_one: append to the store, then publish."""
    from bridge import pubsub                     # local import, matches house style
    sess = store.get_session(session_id) or {}
    ev = {"type": "stage", "from": sess.get("stage"), "to": to_stage, "by": by}
    store.set_session_stage(session_id, to_stage)
    seq = store.append_event(session_id, turn_id, ev)
    pubsub.publish(f"session:{session_id}", {**ev, "seq": seq, "turn_id": turn_id})
```
(Check `pubsub.publish` payloads elsewhere include `turn_id` — `runner._journal_one` at `runner.py:44-46` publishes `{**ev, "seq": seq}` where `ev` lacks turn_id; the SSE consumer types expect `StoreEvent = RunEvent & {seq, turn_id}`. Look at how `store.transcript` re-emits rows and match: the published dict must carry whatever the SSE path normally carries. Adjust to be exactly consistent.)

- [ ] **Step 3: Run tests, commit**

Run: `python3 -m pytest tests/test_flow.py -q` — expected PASS.

```bash
git add bridge/flow.py tests/test_flow.py
git commit -m "feat(flow): stage engine — per-stage contract, hud-card parsing, server-owned transitions"
```

---

### Task 4: Runner integration — inject, stamp, transition, nudge

**Files:**
- Modify: `bridge/runner.py` (`_compose_system_prompt` `:100`, `_base_cmd` `:278` + call site `:346`, `_finalize_run_context` `:1826-1847`, `_run_streaming` `:1608` — session loads near `:1628`, post-turn hook next to `goals.continue_after_turn` at `:1768`)
- Modify: `bridge/flow.py` (add `after_turn`)
- Test: `tests/test_flow.py`

**Interfaces:**
- Consumes: `flow.compose_section/parse_card/validate_card/next_stage/stage_permission/apply_stage`, `store.set_turn_stage/turn_prompt`, `queue_manager.enqueue` (signature as used at `bridge/goals.py:84-88`).
- Produces: turns in typed sessions carry the flow section in their system prompt and an effective per-stage permission mode; finished turns emit `card` events, stamp `turns.stage`, auto-advance ungated stages, and enqueue at most one nudge when the card is missing/invalid.

- [ ] **Step 1: Write the failing tests (engine-level, stub job)**

Append to `tests/test_flow.py`:

```python
class _StubJob:
    """Duck-typed stand-in for runner.Job: after_turn only reads these."""
    def __init__(self, sid, turn_id, result, status="done", chat_id=555):
        self.store_session_id = sid
        self.id = turn_id
        self.result = result
        self.texts = [result] if result else []
        self.status = status
        self.interrupted = False
        self.chat_id = chat_id
        self.added = []

    def add(self, ev):
        self.added.append(ev)


def _typed(stage="fix"):
    s = store.create_session(555, "/p", stype="fix", stage=stage)
    store.start_turn(s["id"], "jt-" + s["id"][:6], "work", [])
    return s


def test_after_turn_valid_card_emits_and_stamps():
    s = _typed()
    j = _StubJob(s["id"], "jt-" + s["id"][:6], CARD)
    flow.after_turn(j)
    assert any(e["type"] == "card" for e in j.added)
    assert store.get_session(s["id"])["stage"] == "verify"   # advance:true, no gate


def test_after_turn_gated_stage_does_not_advance():
    s = store.create_session(555, "/p", stype="fix", stage="rootcause")
    store.start_turn(s["id"], "tg1", "work", [])
    body = ("```hud-card\n" + json.dumps(
        {"stage": "rootcause", "summary": "found it",
         "fields": {"cause": "c", "fix_plan": "p"}, "advance": True}) + "\n```")
    flow.after_turn(_StubJob(s["id"], "tg1", body))
    assert store.get_session(s["id"])["stage"] == "rootcause"   # gate held


def test_after_turn_missing_card_nudges_once(monkeypatch):
    calls = []
    from bridge import queue_manager
    monkeypatch.setattr(queue_manager, "enqueue",
                        lambda *a, **k: calls.append(k) or True)
    s = _typed()
    flow.after_turn(_StubJob(s["id"], "jt-" + s["id"][:6], "prose only, no card"))
    assert len(calls) == 1
    assert calls[0]["surface"] == "flow"
    # a nudge turn that ALSO fails must not nudge again
    store.start_turn(s["id"], "tn2", flow._NUDGE_PREFIX + " end with the block", [])
    flow.after_turn(_StubJob(s["id"], "tn2", "still prose"))
    assert len(calls) == 1


def test_after_turn_untyped_session_is_a_noop():
    s = store.create_session(555, "/p")
    store.start_turn(s["id"], "tu1", "x", [])
    j = _StubJob(s["id"], "tu1", CARD)
    flow.after_turn(j)
    assert j.added == []
```

Run: `python3 -m pytest tests/test_flow.py -q` — FAIL, `after_turn` missing.

- [ ] **Step 2: Implement `flow.after_turn`**

Append to `bridge/flow.py` (mirror `goals.continue_after_turn`'s defensive shape, `bridge/goals.py:67-92`):

```python
_NUDGE_PREFIX = "⟲ flow:"
_NUDGE = (_NUDGE_PREFIX + " your last reply had no valid hud-card block "
          "({why}). End every reply with the hud-card block for stage "
          "{stage} — restate this turn's result inside it. Do not redo the work.")


def after_turn(job, model=None, effort=None) -> None:
    """Called once per finished turn (next to goals.continue_after_turn).
    Parses the reply's hud-card, journals it, stamps the turn, advances
    ungated stages, and nudges at most once when the card is missing.
    Best-effort: a flow must never break a run."""
    import sys
    try:
        sid = getattr(job, "store_session_id", None)
        if not sid or job.status != "done" or getattr(job, "interrupted", False):
            return
        sess = store.get_session(sid) or {}
        f = get_flow(sess.get("stype"))
        stage = sess.get("stage")
        if not f or not stage or stage == "done":
            return
        text = job.result or (job.texts[-1] if job.texts else "")
        card = parse_card(text)
        errs = validate_card(f, stage, card) if card else ["no hud-card block"]
        if card and not errs:
            job.add({"type": "card", "card": card, "stage": stage})
            store.set_turn_stage(job.id, stage)
            s = stage_by_id(f, stage)
            if card.get("advance") is True and not s.get("gate"):
                apply_stage(sid, next_stage(f, stage), "auto", turn_id=job.id)
            return
        # Invalid or missing: journal the miss, then one nudge max — a nudge
        # turn that itself fails just stays prose.
        job.add({"type": "card_missing", "errors": errs[:4]})
        prompt = store.turn_prompt(job.id) or ""
        if prompt.startswith(_NUDGE_PREFIX):
            return
        from bridge import queue_manager
        text = _NUDGE.format(why="; ".join(errs[:2]), stage=stage)
        queue_manager.enqueue(
            sid, text=text, prompt=text, images=[], model=model,
            effort=effort, permission_mode=sess.get("permission_mode"),
            width=None, sel=[], surface="flow", chat_id=job.chat_id,
            project=sess.get("project") or "")
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[flow] after_turn failed: {e}", file=sys.stderr)
```
(Move `import sys` to the module top with the other imports.)

- [ ] **Step 3: Run engine tests**

Run: `python3 -m pytest tests/test_flow.py -q` — expected PASS.

- [ ] **Step 4: Wire the runner (three seams)**

1. **System prompt** — `runner.py:100`:
```python
def _compose_system_prompt(graph: str = "", flow_section: str = "") -> str:
```
add `flow_section.strip()` as a fourth member of the existing `parts` list (after `graph`). At `_base_cmd` (`:278`), add a `flow_section: str = ""` keyword param and change `:346` to
```python
    cmd += ["--append-system-prompt", _compose_system_prompt(graph, flow_section)]
```

2. **Compose + permission at run time** — in `_finalize_run_context` (`:1826`), after `permission_mode` is resolved (`:1847` region):
```python
    flow_section = ""
    if session.get("stype"):
        from bridge import flow as _flow
        f = _flow.get_flow(session.get("stype"))
        if f:
            flow_section = _flow.compose_section(f, session.get("stage"))
            permission_mode = (_flow.stage_permission(f, session.get("stage"))
                               or permission_mode)
```
Thread `flow_section` to where `_base_cmd` is called from `_run_streaming` (follow how `permission_mode` travels: `_finalize_run_context` return → `start_streaming_job` → `_run_streaming` → `_base_cmd`; extend the same tuple/params, keeping every existing call site compiling — grep `_finalize_run_context(` and `_base_cmd(` for all callers, including the blocking `run_blocking`/`handle_task` path at `:405-461`, and pass `flow_section=""` where the session has no type).

3. **Post-turn hook** — `runner.py:1768` reads:
```python
            resumed = goals.continue_after_turn(job, model, effort) or resumed
```
add directly after it:
```python
            flow.after_turn(job, model, effort)
```
with `from bridge import flow` in runner's imports (top of file, alphabetical with the others; if that creates an import cycle at module load — flow imports store+aifeatures only, so it shouldn't — fall back to a local import inside the function, as `goals.py:77` does for queue_manager).

- [ ] **Step 5: Full suite + commit**

Run: `python3 -m pytest tests/ -q`
Expected: everything green (runner import-time changes are the risk; fix any breakage before committing).

```bash
git add bridge/runner.py bridge/flow.py tests/test_flow.py
git commit -m "feat(runner): typed sessions inject their stage contract and settle their card each turn"
```

---

### Task 5: API — catalog, create-with-type, stage endpoint, flow management

**Files:**
- Modify: `bridge/miniapp/server.py` (`_session_brief` `:111-132`, `do_GET` dispatch `:259-307`, `do_POST` dispatch `:312-336`, `_api_sessions_create` `:507-519`, method block near `_api_session_policy` `:543`)
- Modify: `bridge/dashboard/server.py` (`_get_api` `:311`, `_post_api` `:660`, create `:703-715`, next to the `/lifecycle` stanza `:919-929`)
- Test: `tests/test_flow.py`

**Interfaces:**
- Consumes: `flow.catalog/load_flows/get_flow/first_stage/save_custom/delete_custom/next_stage/stage_by_id/apply_stage/enabled`.
- Produces (HTTP):
  - `GET /api/flows` (Mini App) and `GET /local/flows` (dashboard) → `flow.catalog()`; the dashboard variant additionally returns `"full": {stype: <merged flow json>}` for the settings editor.
  - `POST /api/sessions` / `POST /local/sessions` accept optional `"stype"`; unknown/disabled stype → 400 `{"error": "unknown flow type"}`; a typed create also seeds `stage=first_stage`.
  - `POST {prefix}/sessions/{id}/stage` body `{"action": "advance"|"back"|"set", "stage"?}` → `{"ok": true, "stage": <new>}`; invalid action/stage → 400; untyped session → 400.
  - Dashboard only: `POST /local/flows/{stype}` (upsert; body = flow JSON; 400 with `{"errors": [...]}`), `POST /local/flows/{stype}/delete`.
  - `_session_brief` gains `"stype"` and `"stage"` — both surfaces, list + create + detail, in one edit.

- [ ] **Step 1: Write the failing tests**

House style tests the functions, not HTTP (see `tests/test_bridge.py:22-26` importing straight from `bridge.miniapp.server`). Append to `tests/test_flow.py`:

```python
from bridge.miniapp.server import _session_brief   # noqa: E402


def test_session_brief_carries_stype_and_stage():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    b = _session_brief(s)
    assert b["stype"] == "fix" and b["stage"] == "reproduce"
    p = _session_brief(store.create_session(555, "/p"))
    assert p["stype"] is None and p["stage"] is None


def test_stage_action_resolution():
    f = flow.get_flow("fix")
    assert flow.resolve_stage_action(f, "reproduce", "advance", None) == "rootcause"
    assert flow.resolve_stage_action(f, "rootcause", "back", None) == "reproduce"
    assert flow.resolve_stage_action(f, "reproduce", "set", "verify") == "verify"
    assert flow.resolve_stage_action(f, "verify", "advance", None) == "done"
    assert flow.resolve_stage_action(f, "done", "advance", None) is None
    assert flow.resolve_stage_action(f, "reproduce", "set", "nope") is None
```

`resolve_stage_action` is new — put the action arithmetic in `flow.py` so both servers' handlers stay four-line stanzas:

```python
def resolve_stage_action(f: dict, current: "str | None", action: str,
                         stage: "str | None") -> "str | None":
    """The stage an action lands on, or None when the action is invalid."""
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
```

Run: `python3 -m pytest tests/test_flow.py -q` — FAIL on `_session_brief` fields and `resolve_stage_action`.

- [ ] **Step 2: Implement**

1. `flow.resolve_stage_action` as above.

2. `_session_brief` (`miniapp/server.py:111-132`) — add to the returned dict:
```python
            "stype": s.get("stype"), "stage": s.get("stage"),
```

3. Mini App — `do_GET` (`:259`), above the `/api/sessions/` `startswith` stanza:
```python
                if path == "/api/flows":
                    return self._json(flow.catalog())
```
`do_POST` (`:312`), next to the `_api_session_policy` dispatch (`:334-336`):
```python
                if path.startswith("/api/sessions/") and path.endswith("/stage"):
                    return self._api_session_stage(
                        chat_id, path[len("/api/sessions/"):-len("/stage")], body)
```
New method beside `_api_session_policy` (`:543`):
```python
    def _api_session_stage(self, chat_id: int, sid: str, body: dict):
        s = store.get_session(sid)
        if not s or s["chat_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        f = flow.get_flow(s.get("stype"))
        if not f:
            return self._json({"error": "not a typed session"}, 400)
        to = flow.resolve_stage_action(f, s.get("stage"),
                                       body.get("action") or "",
                                       body.get("stage"))
        if to is None:
            return self._json({"error": "invalid stage action"}, 400)
        flow.apply_stage(sid, to, "user")
        return self._json({"ok": True, "stage": to})
```
`_api_sessions_create` (`:507-519`) — before `store.create_session`, resolve the type:
```python
        stype = (body.get("stype") or "").strip() or None
        stage = None
        if stype:
            f = flow.get_flow(stype)
            if not f or f.get("disabled") or not flow.enabled():
                return self._json({"error": "unknown flow type"}, 400)
            stage = flow.first_stage(f)
```
and pass `stype=stype, stage=stage` to `store.create_session`. Add `flow` to the module's `from bridge import ...` line.

4. Dashboard — `_get_api` (`:311`):
```python
        if path == "/local/flows":
            cat = flow.catalog()
            cat["full"] = {st: {k: v for k, v in f.items() if k != "_custom"}
                           for st, f in flow.load_flows().items()}
            cat["all"] = [{"stype": st, "label": f.get("label", st.upper()),
                           "source": "custom" if f.get("_custom") else "builtin",
                           "disabled": bool(f.get("disabled"))}
                          for st, f in sorted(flow.load_flows().items())]
            return self._json(cat)
```
(One `load_flows()` call reused for both — assign it to a local.)
`_post_api` (`:660`), next to the `/lifecycle` stanza (`:919`):
```python
        if path.startswith("/local/sessions/") and path.endswith("/stage"):
            sid = path[len("/local/sessions/"):-len("/stage")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            f = flow.get_flow(s.get("stype"))
            if not f:
                return self._json({"error": "not a typed session"}, 400)
            to = flow.resolve_stage_action(f, s.get("stage"),
                                           body.get("action") or "",
                                           body.get("stage"))
            if to is None:
                return self._json({"error": "invalid stage action"}, 400)
            flow.apply_stage(sid, to, "user")
            return self._json({"ok": True, "stage": to})
        if path.startswith("/local/flows/") and path.endswith("/delete"):
            st = path[len("/local/flows/"):-len("/delete")]
            return self._json({"ok": flow.delete_custom(st)})
        if path.startswith("/local/flows/"):
            st = path[len("/local/flows/"):]
            errs = flow.save_custom(st, body)
            if errs:
                return self._json({"errors": errs}, 400)
            return self._json({"ok": True})
```
**Order matters**: the `/delete` stanza must sit above the bare `/local/flows/` one, and both above any broader `/local/` catch-alls. Dashboard create (`:703-715`): apply the same stype/stage resolution as the Mini App create. Import `flow` alongside the other `from bridge import` lines.

- [ ] **Step 3: Run, commit**

Run: `python3 -m pytest tests/ -q` — expected green.

```bash
git add bridge/miniapp/server.py bridge/dashboard/server.py bridge/flow.py tests/test_flow.py
git commit -m "feat(api): flow catalog, typed session create, stage actions, template management"
```

---

### Task 6: Dashboard UI — picker/form, cards, stage rail, list chips, settings editor

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts` (`SessionBrief` `:27-45`, `RunEvent` union `:80-119`, api object `:903`, `createSession` `:928-932`)
- Modify: `bridge/dashboard/web/src/components/RunStream.tsx` (switch `:1280-1514`, `asksNext` skip list `:1253-1261`, result body `:1625` region)
- Create: `bridge/dashboard/web/src/components/FlowCard.tsx`, `bridge/dashboard/web/src/components/StageRail.tsx`, `bridge/dashboard/web/src/lib/hudcard.ts`
- Modify: `bridge/dashboard/web/src/components/hud/SessionsPanel.tsx` (NEW SESSION form `:516+`, row chips `:141-177`, filter strip `:733-772`), `bridge/dashboard/web/src/App.tsx` (session start fns `:1224-1292`, Transcript mount — grep `<Transcript`), `bridge/dashboard/web/src/components/Composer.tsx` (`design()` `:468-474`, buttons `:823-839`), `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`, `bridge/dashboard/web/src/chat.ts` (only if pending semantics need it — they don't; skip), `bridge/dashboard/web/src/lib/chatmd.ts` (strip hud-card from export)

**Interfaces:**
- Consumes: `GET /local/flows`, `POST /local/sessions` (+stype), `POST /local/sessions/{id}/stage`, `POST /local/flows/{stype}`, `POST /local/flows/{stype}/delete`; `card`/`stage`/`card_missing` events.
- Produces: TS types `FlowShape`, `FlowCatalog`; `api.flows()`, `api.saveFlow(stype, body)`, `api.deleteFlow(stype)`, `api.setStage(sid, action, stage?)`; `createSession(project, cwd?, title?, stype?)`; `stripHudCard(text)`.

- [ ] **Step 1: Types + client**

In `api.ts`: extend `SessionBrief` with `stype: string | null; stage: string | null;`. Add to the `RunEvent` union:
```ts
  | { type: "card"; card: HudCard; stage: string }
  | { type: "stage"; from: string | null; to: string; by: "auto" | "user" }
  | { type: "card_missing"; errors?: string[] }
```
with
```ts
export interface HudCardAction { label: string; send: string; }
export interface HudCard {
  stage: string; summary: string;
  fields: Record<string, unknown>;
  advance?: boolean; actions?: HudCardAction[];
}
export interface FlowField { key: string; label: string; required?: boolean; multiline?: boolean; }
export interface FlowStageShape { id: string; label: string; gate: boolean; }
export interface FlowShape {
  stype: string; label: string; blurb: string;
  source: "builtin" | "custom";
  form: FlowField[]; stages: FlowStageShape[];
}
export interface FlowCatalog {
  enabled: boolean; flows: FlowShape[];
  full?: Record<string, unknown>;
  all?: { stype: string; label: string; source: string; disabled: boolean }[];
}
```
Client fns on the `api` object (house pattern, `:903`):
```ts
  flows: () => req<FlowCatalog>("/local/flows"),
  saveFlow: (stype: string, body: unknown) =>
    req<{ ok: boolean }>(`/local/flows/${encodeURIComponent(stype)}`, { method: "POST", body }),
  deleteFlow: (stype: string) =>
    req<{ ok: boolean }>(`/local/flows/${encodeURIComponent(stype)}/delete`, { method: "POST", body: {} }),
  setStage: (sid: string, action: "advance" | "back" | "set", stage?: string) =>
    req<{ ok: boolean; stage: string }>(`/local/sessions/${encodeURIComponent(sid)}/stage`,
      { method: "POST", body: { action, stage } }),
```
and extend `createSession` (`:928`) with an optional `stype?: string` folded into the body.

`lib/hudcard.ts`:
```ts
const HUD_CARD_RE = /```hud-card\s*\n[\s\S]*?```\s*$/;
/** Assistant text with a trailing hud-card block removed — the parsed `card`
 * event is the rendered truth; the raw fence never reaches the transcript. */
export function stripHudCard(text: string): string {
  return text.replace(HUD_CARD_RE, "").trimEnd();
}
```

- [ ] **Step 2: Render — FlowCard, stage divider, stripping**

`components/FlowCard.tsx` — presentational, styled like QuestionCard (mirror its container/props conventions, `QuestionCard.tsx:9-25`):
```ts
import type { HudCard } from "../api";

export function FlowCard({ card, gated, isCurrent, onAction, onApprove }: {
  card: HudCard;
  gated: boolean;            // this stage holds a gate
  isCurrent: boolean;        // session.stage still equals card.stage
  onAction: (send: string) => void;
  onApprove: () => void;     // POST stage advance
}) { /* renders: summary line; fields as label/value rows (arrays join as
       chips); action buttons -> onAction(a.send); when gated && card.advance
       && isCurrent, an APPROVE ADVANCE button -> onApprove() */ }
```
Implement the body with the CRT-HUD tokens used by QuestionCard (corner-bracket panel, `--t9` labels). Keep it dumb: no fetching, no state beyond a "sent" flag per action button.

`RunStream.tsx`:
- switch (`:1280`): add
```ts
      case "card":
        return <FlowCard key={i} card={event.card} gated={…} isCurrent={…}
                 onAction={(send) => onSend?.(send)} onApprove={…} />;
      case "stage":
        return <div key={i} className="stage-divider">STAGE {event.from ?? "·"} → {event.to}</div>;
      case "card_missing":
        return null;
```
RunStream doesn't currently know the session or have send/setStage — thread three new optional props from Transcript.tsx → App (`session: SessionBrief`-ish `stype/stage`, `onSend`, `onStageAdvance`), following exactly how `onRespond` travels (`RunStream.tsx:1493` → `Transcript.tsx:114-117` → `App.tsx:1182-1189`). `gated` = look up the stage in a `FlowShape` fetched once in App via `api.flows()` and passed down; `isCurrent` = `session.stage === event.stage`.
- `asksNext()` skip list (`:1253-1261`): add `"card"`, `"stage"`, `"card_missing"` so the RESULT//ASK box survives.
- Text/result stripping: where `event.text` renders (`:1283` case) and where the result body is derived (`:1625` `askBack(result)` region), wrap with `stripHudCard(...)`. Also apply in `lib/chatmd.ts`'s text/result arms so exports stay clean.

- [ ] **Step 3: Start typed — SessionsPanel form + App wiring**

`SessionsPanel.tsx` NEW SESSION form (`:516+`): under the project field, a chip row of types from a new `flows?: FlowShape[]` prop (`CHAT` first = no type). Picking a type reveals its `form` fields (text inputs / textareas from `FlowField.multiline`, required-marking per field). Submit calls a widened `onNewSession(rel, typed?: { stype: string; prompt: string })` where `prompt` is built like the backend's `compose_first_prompt`:
```ts
function composeFirstPrompt(f: FlowShape, values: Record<string, string>): string {
  const lines = [`[${f.label}]`];
  for (const field of f.form) {
    const v = (values[field.key] ?? "").trim();
    if (v) lines.push(`${field.label}: ${v}`);
  }
  return lines.join("\n");
}
```
`App.tsx`: extend `newSession` (`:1265-1272`) / add `typedSession(project, stype, prompt)` modeled on `startIn` (`:1224-1240`): `api.createSession(project, undefined, undefined, stype)` → open → `send(prompt)`. Fetch `api.flows()` once on mount (state `flowCatalog`), pass `flows` to SessionsPanel and the shape map to Transcript/RunStream, and hide the picker entirely when `!flowCatalog?.enabled`.

- [ ] **Step 4: StageRail + list chips + DESIGN button fold**

`components/StageRail.tsx`:
```ts
export function StageRail({ stages, current, onSet }: {
  stages: FlowStageShape[]; current: string | null;
  onSet: (stage: string) => void;      // api.setStage(sid, "set", stage)
}) { /* one row: each stage label a small chip; done/past dim, current lit
       (accent + glow), future hollow; gate stages carry a ◆; click = onSet
       with a confirm when jumping backward */ }
```
Mount beside the `<Transcript` call site in App.tsx (grep it), only when the active session has `stype`; `current` refreshes from `stage` SSE events and from `api.setStage` responses.

`SessionsPanel.tsx` rows (`:141-177`): add a stype chip (label from the catalog, fall back to `stype.toUpperCase()`), styled like the existing tag chips. Filter strip (`:733-772`): mirror the tag-filter pattern with `allTypes` derived from `sessions.flatMap(s => s.stype ?? [])` plus a `CHAT` bucket for untyped; single-select `typeFilter` state applied where `tagFilter` is applied (`:374-376`).

`Composer.tsx`: delete `design()` (`:468-474`) and its two buttons (`:823-825`, `:837-839`) — DESIGN is now a session type (its DRAFT stage invokes /design-first). Remove imports/props your deletion orphans; leave `steer()` untouched.

- [ ] **Step 5: SettingsModal FLOWS section**

In `SettingsModal.tsx`, add a FLOWS section following the shape of the AI-features section (the `api.setAiFeature` block at `:1437` — note the master toggle itself already appears there automatically via the `FEATURES` registry; do NOT build a second toggle):
- List from `api.flows().all` (label, BUILTIN/CUSTOM badge, DISABLED state).
- EDIT opens a `<textarea>` (monospace, ~20 rows) seeded from `full[stype]` pretty-printed; SAVE → `api.saveFlow(stype, JSON.parse(text))`, catching both JSON.parse errors and the server's `{errors: [...]}` 400 into an inline error list; the fetch helper throws `Error(message)` — surface it verbatim.
- NEW TYPE seeds the textarea with a minimal scaffold (stype/label/blurb/1 form field/2 stages).
- For a CUSTOM flow, DELETE → `api.deleteFlow` (with the built-in resurfacing note when the name collides); for a BUILTIN, the affordance is DISABLE, which saves the JSON with `"disabled": true`.
- The whole section hides when the `flows` feature is off (same conditional the other feature-gated sections use).

- [ ] **Step 6: Typecheck, build, screenshot, commit**

```bash
cd bridge/dashboard/web && npx tsc -p tsconfig.app.json && npm run build
```
Expected: clean. The `RunEvent` union addition will surface every non-exhaustive switch — fix each (`chatmd.ts`, any `e.type ===` chains flagged).

Verify visually via the bridge-eyes skill (worktree scratch server + headless shot): NEW SESSION picker with a FIX form, a transcript with a FlowCard + stage divider, the rail, the FLOWS settings section. Fix what looks wrong before committing.

```bash
git add bridge/dashboard/web/src
git commit -m "feat(dashboard): typed session start, flow cards, stage rail, type chips, FLOWS settings"
```

---

### Task 7: Mini App UI — mirror, compact

**Files:**
- Modify: `bridge/miniapp/web/src/lib/api.ts` (`SessionBrief` `:53`, `RunEvent` `:124-158`, `createSession` `:568`, api object `:503`), `bridge/miniapp/web/src/components/RunStream.tsx` (switch `:885-1046`), `bridge/miniapp/web/src/lib/chat.tsx` (new-chat `:637`, auto-create `:427`), `bridge/miniapp/web/src/routes/chats.tsx` (tab chips `:133-146`, rows `:153+`), `bridge/miniapp/web/src/routes/run.tsx` (RunStream mount `:383`)
- Create: `bridge/miniapp/web/src/components/FlowCard.tsx`, `bridge/miniapp/web/src/lib/hudcard.ts`

**Interfaces:**
- Consumes: `GET /api/flows`, `POST /api/sessions` (+stype), `POST /api/sessions/{id}/stage`.
- Produces: Mini App parity for typed start, card rendering, stage chip, list type chips. No flow management here (dashboard-only per spec).

- [ ] **Step 1: Types + client (hand-kept duplicate — do not import across apps)**

Mirror Task 6's `HudCard`/`FlowShape`/`FlowCatalog` types and the `card`/`stage`/`card_missing` union arms into `lib/api.ts` (`:124-158`). Add `stype`/`stage` to its `SessionBrief` (`:53`). Client fns in its own idiom (positional args, `/api/*` paths, `request<T>`): `flows()`, `setStage(sid, action, stage?)`; extend `createSession(project, title?, cwd?, stype?)` — **note this app's arg order differs from the dashboard's; keep its existing order and append**.

- [ ] **Step 2: Render + start + chips**

- `components/FlowCard.tsx`: copy the dashboard component, adjust imports (`../lib/api`) and the amber accent, exactly as `QuestionCard.tsx` was copied (its header comment says so — keep that convention and note the sibling in a comment).
- `lib/hudcard.ts`: copy of the dashboard's.
- `RunStream.tsx` switch (`:885`): `card` → FlowCard (wire `onAction` through the `useChat()` send; `onApprove` → `api.setStage(sid, "advance")` via a prop from `routes/run.tsx:383-388`, same as `onRespond`); `stage` → the one-line divider; `card_missing` → null. Strip hud-card blocks in its text/result arms.
- Typed start: in `lib/chat.tsx`'s explicit new-chat path (`:637`), when the catalog is enabled and the user picked a type (a compact select + form fields sheet rendered where the new-chat UI lives), create with stype and send the composed first prompt (duplicate `composeFirstPrompt`). The auto-create path (`:427`) stays untyped — CHAT.
- `routes/chats.tsx`: type chips in the tab strip (`:133-146`) filtering by `stype` (plus CHAT for null); a small stype chip per row. A compact `STAGE` chip (current stage label) in the run header where the session title renders — grep the header in `routes/run.tsx`.

- [ ] **Step 3: Typecheck, build, screenshot, commit**

```bash
cd bridge/miniapp/web && npx tsc -p tsconfig.app.json && npm run build
```
Screenshot via the Mini App headless recipe (screenshot-miniapp-headless memory / bridge-eyes): typed new-chat sheet, a FlowCard in a run, chips in CHATS.

```bash
git add bridge/miniapp/web/src
git commit -m "feat(miniapp): typed start, flow cards, stage chip, type filters"
```

---

### Task 8: Bot — /new type keyboard, plain-text cards, APPROVE button

**Files:**
- Modify: `bridge/dispatch.py` (`/new` `:165-169`, text handler `:210-215`, the callback-query handler — grep `callback` in dispatch.py), `bridge/fmt.py` (result rendering — grep how `handle_task`'s reply text is formatted before send)
- Test: `tests/test_flow.py`

**Interfaces:**
- Consumes: `flow.catalog/get_flow/first_stage/compose_first_prompt/resolve_stage_action/apply_stage/parse_card/stage_by_id`, `store.create_session`.
- Produces: `/new` offers type buttons (`flow|<stype>` callback data); a typed pick parks `{chat_id: stype}` in a module dict; the next text message becomes the primary form field and starts the session; outgoing turn text renders the card as sections with an `APPROVE ▸` inline button (`flowadv|<sid>`) when a gated advance is requested.

- [ ] **Step 1: Failing tests for the pure parts**

```python
def test_bot_form_fill_primary_field():
    f = flow.get_flow("fix")
    p = flow.compose_first_prompt(f, {"what": "it crashes on save"})
    assert p == "[FIX]\nWHAT BROKE: it crashes on save"


def test_card_plaintext_rendering():
    from bridge import fmt
    card = {"stage": "fix", "summary": "patched a.py",
            "fields": {"changed": ["a.py", "b.py"]}, "advance": True}
    txt = fmt.render_card(card)
    assert "patched a.py" in txt and "a.py" in txt
    assert "hud-card" not in txt
```

Run: FAIL on `fmt.render_card`.

- [ ] **Step 2: Implement**

`bridge/fmt.py` (match its existing plain-text style — read the module docstring first):
```python
def render_card(card: dict) -> str:
    """A hud-card as Telegram-safe plain sections."""
    lines = [f"▸ {card.get('summary', '').strip()}"]
    for name, val in (card.get("fields") or {}).items():
        if isinstance(val, list):
            val = ", ".join(str(v) for v in val)
        lines.append(f"{name.upper()}: {val}")
    return "\n".join(lines)
```

`bridge/dispatch.py`:
- `/new` (`:165-169`): when `flow.enabled()`, attach an inline keyboard — one row `CHAT` + one button per `flow.catalog()["flows"]` entry, callback data `flow|<stype>` (read how existing inline keyboards/callbacks are built in this file and copy that helper).
- Callback handler: `flow|<stype>` → store `_pending_flow[chat_id] = stype` (module-level dict; `# ponytail: in-memory pending-type map, lost on restart — a DB column if that ever matters`), reply "Send the brief for <LABEL>". `flowadv|<sid>` → `f = flow.get_flow(...)`; `to = flow.resolve_stage_action(f, s.get("stage"), "advance", None)`; `flow.apply_stage(sid, to, "user")`; answer the callback with the new stage label.
- Text handler (`:210-215`): if `_pending_flow.pop(chat_id, None)` returns a stype, create the session (`store.create_session(chat_id, state.project_key(chat_id), origin="telegram", stype=stype, stage=flow.first_stage(f))`), compose the prompt via `flow.compose_first_prompt(f, {primary_key: text})` where `primary_key` is the first form field's key, and hand THAT to the normal run path instead of the raw text.
- Outgoing result: where `handle_task`'s final text is sent to Telegram, strip the hud-card block (`flow._CARD_RE.sub("", text)` — or add `flow.strip_card(text)` if reaching for the private regex offends), append `fmt.render_card(card)` when a card parsed, and attach the `APPROVE ▸` button when `card.get("advance")` and the current stage is gated.

- [ ] **Step 3: Full suite, commit**

Run: `python3 -m pytest tests/ -q` — green.

```bash
git add bridge/dispatch.py bridge/fmt.py tests/test_flow.py
git commit -m "feat(bot): /new type keyboard, plain-text cards, approve button"
```

---

### Task 9: Ship

- [ ] Full suite green: `python3 -m pytest tests/ -q`.
- [ ] Both frontends: `npx tsc -p tsconfig.app.json && npm run build` in each web dir.
- [ ] Merge the worktree branch to master per the finishing-a-development-branch skill.
- [ ] Land via the **bridge-ship** skill (rebuild dists, restart the bridge FROM OUTSIDE a bridge session or via setsid, verify live: `GET /local/flows` returns the catalog, a FIX session shows the rail).
- [ ] The live DB migrates itself on first `store.init()` — additive columns only; verify existing sessions list unchanged (they read as CHAT).
