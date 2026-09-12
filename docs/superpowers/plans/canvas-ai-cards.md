# Canvas AI Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CANVAS gutter grows a second kind of card — derived cards, each one deterministic facts plus an optional one-shot model call, cached on a watermark — and ships five of them: the lesson already written by `learn.py`, the files a running turn is touching, a drift check, a graphify impact readout, and a design-variant gallery that renders `design-first`'s mockups side by side with on-press critique.

**Architecture:** One new backend module `bridge/cards.py` holds a registry of card definitions (`watermark`/`facts`/`prompt`) plus a render function whose cache is a single JSON file beside the DB, exactly as `bridge/nextup.py` caches. Model calls go through `runner.run_blocking(chat_id, prompt, cwd=…, timeout=45, model="haiku", skip_pack=True)` prefixed with `native.INTERNAL_ONESHOT_TAG`, the pattern `bridge/titler.py` established. Two endpoints in `bridge/dashboard/server.py` serve and force-refresh cards; the frontend renders them in the existing pin gutter (`Canvas.tsx`, shipped 2026-08-25) through the existing `PinCard` frame, with `canvasPins` entries namespaced `panel:` / `card:`.

**Tech Stack:** Python stdlib only (backend), React + TypeScript + Vite (dashboard), SQLite, pytest, `*.check.ts` files run by `node`.

**Spec:** `docs/superpowers/specs/2026-08-25-canvas-ai-cards-design.md`

## Global Constraints

- Backend is Python stdlib only — no new dependencies anywhere.
- Work in a git worktree with its own scratch DB (**bridge-worktree** skill). This feature adds no DB schema, but its cache file sits beside `config.BRIDGE_DB` and must not be written next to the live `~/.bridge_state` DB during development.
- The test suite is fully green (1223 at 2026-08-25). Run `python3 -m pytest tests/ -q` before Task 1 and record the number; anything red afterwards is your change.
- Env-read config must be pinned in `tests/conftest.py` **before** any `bridge.*` import, never in a test module preamble — `bridge.config` freezes settings into module constants at import time.
- Frontend typecheck is `./node_modules/.bin/tsc -p tsconfig.app.json` from `bridge/dashboard/web` (plain `tsc -p .` checks nothing).
- Route matching in `bridge/dashboard/server.py` is a manual if-chain — order matters; specific paths go above `startswith` catch-alls.
- Deliberate shortcuts get a `ponytail:` comment naming the ceiling and the upgrade path.
- Module docstrings carry the *why not* as much as the what — write one for every new module.
- NEVER add Claude as co-author on commits — no `Co-Authored-By`, no "Generated with Claude Code".
- The running bridge is a code snapshot from launch: nothing here is live until a bridge restart (**bridge-ship** skill).
- A model call that fails must leave the previous answer standing. Nothing in `cards.py` may raise into a caller.

---

### Task 1: The card primitive — registry, watermark cache, render

**Files:**
- Create: `bridge/cards.py`
- Test: `tests/test_cards.py` (new)

**Interfaces:**
- Produces:
  - `CARDS: tuple[dict, ...]` — each `{"key": str, "title": str, "scope": "session"|"project", "shape": "lines"|"gallery", "feature": str|None, "watermark": fn(ctx)->str, "facts": fn(ctx)->dict, "prompt": str|None}`
  - `card(key) -> dict | None`
  - `render(key, ctx, force=False) -> dict` returning `{"key", "title", "shape", "body", "generated", "stale"}`
  - `context(session=None, project=None) -> dict` building `{"session", "cwd", "chat_id", "project"}`
  - `_cache_path() -> str`, `_load() -> dict`, `_save(dict) -> None`
- Consumes: `bridge.config.BRIDGE_DB`, `bridge.runner.run_blocking`, `bridge.native.INTERNAL_ONESHOT_TAG`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_cards.py`:

```python
"""Derived canvas cards: watermark caching, model-call guards, registry shape."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import cards  # noqa: E402


def _reg(monkeypatch, **over):
    """A one-card registry, so a test never depends on a real card's facts."""
    spec = {"key": "t", "title": "T", "scope": "session", "shape": "lines",
            "feature": None, "watermark": lambda ctx: "w1",
            "facts": lambda ctx: {"n": 1}, "prompt": None}
    spec.update(over)
    monkeypatch.setattr(cards, "CARDS", (spec,))
    return spec


def test_facts_are_the_body_when_there_is_no_prompt(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    _reg(monkeypatch)
    out = cards.render("t", {"id": "s1"})
    assert out["body"] == {"n": 1} and out["stale"] is False


def test_same_watermark_is_served_from_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    calls = []
    _reg(monkeypatch, prompt="say {facts}")
    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: calls.append(1) or "first")
    a = cards.render("t", {"id": "s1"})
    b = cards.render("t", {"id": "s1"})
    assert a["body"] == b["body"] == "first"
    assert len(calls) == 1, "a second render at the same watermark must not spend"


def test_moved_watermark_recomputes(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    marks = iter(["w1", "w2"])
    _reg(monkeypatch, prompt="p", watermark=lambda ctx: next(marks))
    answers = iter(["one", "two"])
    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: next(answers))
    assert cards.render("t", {"id": "s1"})["body"] == "one"
    assert cards.render("t", {"id": "s1"})["body"] == "two"


def test_force_ignores_the_watermark(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    _reg(monkeypatch, prompt="p")
    answers = iter(["one", "two"])
    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: next(answers))
    cards.render("t", {"id": "s1"})
    assert cards.render("t", {"id": "s1"}, force=True)["body"] == "two"


def test_a_failed_call_leaves_the_last_answer_standing(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    marks = iter(["w1", "w2"])
    _reg(monkeypatch, prompt="p", watermark=lambda ctx: next(marks))

    def boom(*a, **k):
        raise RuntimeError("model down")

    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: "good")
    cards.render("t", {"id": "s1"})
    monkeypatch.setattr(cards, "_one_shot", boom)
    out = cards.render("t", {"id": "s1"})
    assert out["body"] == "good" and out["stale"] is True


def test_facts_raising_yields_an_error_body_not_an_exception(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))

    def boom(ctx):
        raise OSError("no repo")

    _reg(monkeypatch, facts=boom)
    out = cards.render("t", {"id": "s1"})
    assert out["body"] is None and out["stale"] is True


def test_a_corrupt_cache_file_does_not_take_the_card_down(tmp_path, monkeypatch):
    p = tmp_path / "cards.json"
    p.write_text("{not json")
    monkeypatch.setattr(cards, "_cache_path", lambda: str(p))
    _reg(monkeypatch)
    assert cards.render("t", {"id": "s1"})["body"] == {"n": 1}


def test_unknown_key_returns_none():
    assert cards.card("nope") is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m pytest tests/test_cards.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'bridge.cards'`

- [ ] **Step 3: Write `bridge/cards.py`**

```python
"""Derived cards for the CANVAS gutter: facts, one optional model call, a cache.

A transcript is a queue, so anything a model produces is buried by the next
message. The board's gutter is where output that must *stand* goes — and the
cheapest way to fill it is not five features but one: a card is deterministic
facts, an optional one-shot that turns them into a few lines, and a watermark
naming the cheapest thing that changes when the answer would.

Same watermark -> served from cache -> costs nothing. That is `nextup.py`'s
posture (a repo whose state has not moved is free) applied per card, and it is
what makes a card safe to refetch on every turn end.

Nothing here raises. A card whose facts blow up renders empty; a card whose
model call fails keeps the last answer and marks it stale — a blank card is a
worse answer than an old one, and an exception into a turn's lifecycle is
worse than both (the scar `titler.py` carries).

The cache is one JSON file beside the DB, not a table: this is derived data,
and derived data must never become a migration.

ponytail: cards are computed on request, never pushed. If a card ever needs to
be fresh before it is asked for, hook it where `learn.kick` hangs, not here.
"""

import json
import os
import sys
import threading
import time

from bridge import config, native, runner

_MAX_FACTS = 6000  # what a one-shot may be handed, in characters
_lock = threading.Lock()


def _cache_path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "cards.json")


def _load() -> dict:
    try:
        with open(_cache_path()) as f:
            return json.load(f) or {}
    except (OSError, ValueError):
        return {}


def _save(state: dict) -> None:
    try:
        with open(_cache_path(), "w") as f:
            json.dump(state, f)
    except OSError:
        pass


def _one_shot(chat_id: int, prompt: str, cwd: "str | None") -> str:
    """One cheap call, tagged so its JSONL never surfaces as a phantom session.
    Mirrors titler._ask: errors are data, so they are logged, not raised."""
    text, _sid, _cost, is_error = runner.run_blocking(
        chat_id, f"{native.INTERNAL_ONESHOT_TAG}\n{prompt}", cwd=cwd or None,
        timeout=45, model="haiku", skip_pack=True)
    if is_error:
        print(f"[cards] one-shot error: {str(text)[:200]}", file=sys.stderr)
        return ""
    return (text or "").strip()


def card(key: str) -> "dict | None":
    return next((c for c in CARDS if c["key"] == key), None)


def render(key: str, ctx: dict, force: bool = False) -> dict:
    spec = card(key)
    if spec is None:
        return {"key": key, "title": key.upper(), "shape": "lines",
                "body": None, "generated": 0, "stale": True}
    out = {"key": key, "title": spec["title"], "shape": spec["shape"],
           "body": None, "generated": 0, "stale": False}
    slot = f"{ctx.get('id') or ''}:{key}"
    with _lock:
        state = _load()
    prev = state.get(slot) or {}
    try:
        mark = spec["watermark"](ctx)
    except Exception:  # noqa: BLE001 — a watermark is a convenience, not a contract
        mark = ""
    if not force and mark and prev.get("mark") == mark:
        return {**out, "body": prev.get("body"), "generated": prev.get("at", 0)}
    try:
        facts = spec["facts"](ctx)
    except Exception as e:  # noqa: BLE001
        print(f"[cards] {key} facts failed: {e}", file=sys.stderr)
        return {**out, "body": prev.get("body"), "generated": prev.get("at", 0),
                "stale": True}
    if not spec["prompt"]:
        body = facts
    else:
        try:
            body = _one_shot(ctx.get("chat_id") or 0,
                             spec["prompt"].format(
                                 facts=json.dumps(facts, indent=1)[:_MAX_FACTS]),
                             ctx.get("cwd"))
        except Exception as e:  # noqa: BLE001
            print(f"[cards] {key} call failed: {e}", file=sys.stderr)
            return {**out, "body": prev.get("body"), "generated": prev.get("at", 0),
                    "stale": True}
        if not body:
            return {**out, "body": prev.get("body"), "generated": prev.get("at", 0),
                    "stale": True}
    at = time.time()
    with _lock:
        state = _load()
        state[slot] = {"mark": mark, "body": body, "at": at}
        _save(state)
    return {**out, "body": body, "generated": at}


def context(session: "dict | None" = None, project: "str | None" = None) -> dict:
    """What every card's facts/watermark reads. `id` is the cache slot: the
    session for session cards, the project for project ones."""
    cwd = (session or {}).get("cwd") or (
        os.path.normpath(os.path.join(config.BASE_PATH, (project or "/").lstrip("/")))
        if project else config.BASE_PATH)
    return {"id": (session or {}).get("id") or project or "",
            "session": session, "project": project, "cwd": cwd,
            "chat_id": (session or {}).get("chat_id") or 0}


CARDS: tuple = ()   # filled by the card modules below (Tasks 4, 6, 7, 8)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_cards.py -q`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add bridge/cards.py tests/test_cards.py
git commit -m "feat(cards): a derived card is facts, one call, and a watermark"
```

---

### Task 2: Endpoints and switches

**Files:**
- Modify: `bridge/dashboard/server.py` (GET chain near `/local/files/read` `:465`; POST chain near `/local/queue/` `:704`)
- Modify: `bridge/aifeatures.py` (`FEATURES` tuple `:39`)
- Modify: `bridge/config.py` (env settings, beside the other `*_ENABLE` constants)
- Modify: `tests/conftest.py` (pin the new env settings)
- Test: `tests/test_cards.py` (append)

**Interfaces:**
- Consumes: `cards.render`, `cards.context`, `cards.CARDS`, `store.get_session`, `aifeatures.enabled`.
- Produces:
  - `GET /local/cards?session=<id>` and `GET /local/cards?project=<rel>` → `{"cards": [ {key,title,shape,body,generated,stale} ]}`
  - `POST /local/cards/<key>/refresh` body `{"session": id}` or `{"project": rel}` → the single rendered card
  - `aifeatures` keys `card_drift`, `card_impact`, `card_design` (env `CARD_DRIFT_ENABLE`, `CARD_IMPACT_ENABLE`, `CARD_DESIGN_JUDGE`, all default False)
  - `cards.visible(ctx) -> list[dict]` — the cards whose `feature` is None or enabled

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cards.py`:

```python
def test_visible_hides_a_card_whose_feature_is_off(monkeypatch):
    from bridge import aifeatures
    monkeypatch.setattr(cards, "CARDS", (
        {"key": "free", "title": "F", "scope": "session", "shape": "lines",
         "feature": None, "watermark": lambda c: "", "facts": lambda c: {}, "prompt": None},
        {"key": "paid", "title": "P", "scope": "session", "shape": "lines",
         "feature": "card_drift", "watermark": lambda c: "", "facts": lambda c: {},
         "prompt": "p"},
    ))
    monkeypatch.setattr(aifeatures, "enabled", lambda k: False)
    assert [c["key"] for c in cards.visible({"session": {"id": "s"}})] == ["free"]
    monkeypatch.setattr(aifeatures, "enabled", lambda k: True)
    assert [c["key"] for c in cards.visible({"session": {"id": "s"}})] == ["free", "paid"]


def test_project_cards_are_hidden_from_a_session_scope(monkeypatch):
    monkeypatch.setattr(cards, "CARDS", (
        {"key": "proj", "title": "P", "scope": "project", "shape": "lines",
         "feature": None, "watermark": lambda c: "", "facts": lambda c: {}, "prompt": None},
    ))
    assert cards.visible({"session": {"id": "s"}, "project": None}) == []
    assert len(cards.visible({"session": None, "project": "/p"})) == 1


def test_every_registered_feature_key_exists_in_aifeatures():
    from bridge import aifeatures
    keys = {f["key"] for f in aifeatures.FEATURES}
    for c in cards.CARDS:
        assert c["feature"] is None or c["feature"] in keys, c["key"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m pytest tests/test_cards.py -q`
Expected: FAIL — `AttributeError: module 'bridge.cards' has no attribute 'visible'`

- [ ] **Step 3: Implement `visible`, the switches and the routes**

In `bridge/cards.py`, after `context`:

```python
def visible(ctx: dict) -> list:
    """The cards that belong to this scope and whose switch is on. A feature
    that is off has no card at all — the same posture the NEXT tab takes."""
    from bridge import aifeatures   # local import: aifeatures reads config late
    want = "session" if ctx.get("session") else "project"
    return [c for c in CARDS
            if c["scope"] == want and (c["feature"] is None or aifeatures.enabled(c["feature"]))]
```

In `bridge/config.py`, beside the other feature flags:

```python
CARD_DRIFT_ENABLE = _bool("CARD_DRIFT_ENABLE", False)
CARD_IMPACT_ENABLE = _bool("CARD_IMPACT_ENABLE", False)
CARD_DESIGN_JUDGE = _bool("CARD_DESIGN_JUDGE", False)
```

(Match the surrounding helper's name — if the file uses `_flag` or `os.environ.get(...) == "1"`, copy that form verbatim rather than introducing `_bool`.)

In `bridge/aifeatures.py`, append to `FEATURES`:

```python
    {"key": "card_drift", "env": "CARD_DRIFT_ENABLE", "label": "DRIFT CARD",
     "hint": "says what a session is doing now, versus what you asked",
     "cost": "1 haiku call every 5th turn",
     "tokens": "~33k tokens",
     "about": "Stands a card in the CANVAS gutter comparing the session's first "
              "prompt against its recent turns. Catches the run that wandered "
              "thirty turns ago and reads plausibly at every single turn."},
    {"key": "card_impact", "env": "CARD_IMPACT_ENABLE", "label": "IMPACT CARD",
     "hint": "names the subsystems a turn's edits touch",
     "cost": "1 haiku call per turn that edits files",
     "tokens": "~33k tokens",
     "about": "Reads the turn's changed files and their graphify neighbours, and "
              "writes four lines of blast radius into the CANVAS gutter. Needs a "
              "built project map (MAP tab)."},
    {"key": "card_design", "env": "CARD_DESIGN_JUDGE", "label": "DESIGN JUDGE",
     "hint": "critiques a design draft on request",
     "cost": "1 haiku call per variant, on press",
     "tokens": "~33k tokens per variant",
     "about": "The CANVAS design gallery renders design-first's drafts side by "
              "side for free; this switch adds a JUDGE button per variant that "
              "scores hierarchy, contrast and state coverage against the repo's "
              "design system."},
```

In `tests/conftest.py`, beside the existing pins (**above the first bridge import**):

```python
os.environ.setdefault("CARD_DRIFT_ENABLE", "0")
os.environ.setdefault("CARD_IMPACT_ENABLE", "0")
os.environ.setdefault("CARD_DESIGN_JUDGE", "0")
```

In `bridge/dashboard/server.py`, in the GET chain (above any `startswith("/local/")` catch-all):

```python
        if path == "/local/cards":
            sid = (qs.get("session", [""])[0] or "").strip()
            proj = (qs.get("project", [""])[0] or "").strip()
            sess = store.get_session(sid) if sid else None
            if sid and sess is None:
                return self._json({"error": "unknown session"}, 404)
            ctx = cards.context(sess, proj or None)
            return self._json({"cards": [cards.render(c["key"], ctx)
                                         for c in cards.visible(ctx)]})
```

and in the POST chain:

```python
        if path.startswith("/local/cards/") and path.endswith("/refresh"):
            key = path[len("/local/cards/"):-len("/refresh")]
            body = self._body()          # match the neighbouring handlers' reader
            sess = store.get_session(body.get("session") or "") if body.get("session") else None
            ctx = cards.context(sess, body.get("project"))
            if cards.card(key) is None:
                return self._json({"error": "unknown card"}, 404)
            return self._json(cards.render(key, ctx, force=True))
```

Add `cards` to the module's `from bridge import …` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_cards.py -q && python3 -m pytest tests/ -q`
Expected: `tests/test_cards.py` all pass; the full suite matches the baseline you recorded.

- [ ] **Step 5: Commit**

```bash
git add bridge/cards.py bridge/config.py bridge/aifeatures.py bridge/dashboard/server.py tests/
git commit -m "feat(cards): serve derived cards, gated by their own switches"
```

---

### Task 3: The gutter takes derived cards

**Files:**
- Modify: `bridge/dashboard/web/src/lib/theme.ts` (`canvasPins` sanitiser in `loadSettings`)
- Create: `bridge/dashboard/web/src/lib/cards.ts`
- Create: `bridge/dashboard/web/src/lib/cards.check.ts`
- Modify: `bridge/dashboard/web/src/api.ts` (beside `lessons` `:1529`)
- Modify: `bridge/dashboard/web/src/components/hud/Canvas.tsx` (`PinPicker`, new `DerivedCard`)
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx` (pins list `:437`)

**Interfaces:**
- Consumes: `GET /local/cards`, `POST /local/cards/<key>/refresh` (Task 2).
- Produces:
  - `api.cards(sessionId)` → `{cards: CanvasCard[]}`; `api.refreshCard(key, sessionId)` → `CanvasCard`
  - `lib/cards.ts`: `type CanvasCard = {key,title,shape,body,generated,stale}`; `pinKind(id) -> {kind:"panel"|"card", id:string}`; `useCards(sessionId, turnCount)` → `{cards, refresh}`
  - `Canvas.tsx`: `DerivedCard({card, onRefresh})`
  - `PinPicker` gains a `cards` prop and lists card chips under the panel chips.

- [ ] **Step 1: Write the failing check**

Create `bridge/dashboard/web/src/lib/cards.check.ts`:

```ts
// Run: node bridge/dashboard/web/src/lib/cards.check.ts
import { pinKind, staleLabel } from "./cards.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(pinKind("panel:files").kind === "panel", "a namespaced panel id reads as a panel");
ok(pinKind("card:drift").id === "drift", "a card id drops its namespace");
// The gutter shipped before cards existed, so stored pins have no namespace.
ok(pinKind("files").kind === "panel" && pinKind("files").id === "files",
   "a bare stored id migrates to a panel");
ok(staleLabel(0) === "never", "a card that never ran says so");
ok(staleLabel(Date.now() / 1000 - 90).endsWith("m ago"), "a fresh card reads in minutes");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node bridge/dashboard/web/src/lib/cards.check.ts`
Expected: FAIL — `Cannot find module './cards.ts'`

- [ ] **Step 3: Write `lib/cards.ts`, the api calls and the widgets**

`bridge/dashboard/web/src/lib/cards.ts`:

```ts
/* Derived CANVAS cards — the client half of bridge/cards.py.
 *
 * The gutter holds two kinds of thing now, so a stored pin carries its kind:
 * `panel:files` is a sidebar panel, `card:drift` is a derived card. Pins
 * stored before cards existed have no prefix and load as panels.
 *
 * Cards refetch on turn end rather than on a timer: the body only changes when
 * its watermark moves, so a poll would spend requests to be told nothing. */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export interface CanvasCard {
  key: string;
  title: string;
  shape: "lines" | "gallery";
  body: unknown;
  generated: number;
  stale: boolean;
}

export function pinKind(stored: string): { kind: "panel" | "card"; id: string } {
  const i = stored.indexOf(":");
  if (i < 0) return { kind: "panel", id: stored };
  const head = stored.slice(0, i);
  return head === "card"
    ? { kind: "card", id: stored.slice(i + 1) }
    : { kind: "panel", id: stored.slice(i + 1) };
}

export function staleLabel(generated: number): string {
  if (!generated) return "never";
  const mins = Math.max(0, Math.round(Date.now() / 1000 - generated) / 60);
  if (mins < 60) return `${Math.round(mins)}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function useCards(sessionId: string | null, turnCount: number) {
  const [cards, setCards] = useState<CanvasCard[]>([]);
  useEffect(() => {
    if (!sessionId) { setCards([]); return; }
    let live = true;
    api.cards(sessionId).then((r) => { if (live) setCards(r.cards); }).catch(() => {});
    return () => { live = false; };
  }, [sessionId, turnCount]);
  const refresh = useCallback(async (key: string) => {
    if (!sessionId) return;
    try {
      const c = await api.refreshCard(key, sessionId);
      setCards((prev) => prev.map((x) => (x.key === key ? c : x)));
    } catch { /* the card keeps its last body */ }
  }, [sessionId]);
  return { cards, refresh };
}
```

In `api.ts`, beside `lessons`:

```ts
  cards: (session: string) =>
    req<{ cards: CanvasCard[] }>(`/local/cards?session=${encodeURIComponent(session)}`),
  refreshCard: (key: string, session: string) =>
    req<CanvasCard>(`/local/cards/${encodeURIComponent(key)}/refresh`, {
      method: "POST", body: JSON.stringify({ session }),
    }),
```

(Import `CanvasCard` from `./lib/cards` or re-declare it in `api.ts` next to the other payload types, whichever the file's existing convention is — types live in `api.ts` for most payloads.)

In `Canvas.tsx`, beside `PanelPin`:

```tsx
/** A derived card: a title, a few lines the bridge computed, and when. The
 *  REFRESH ◇ is the only thing here that can cost money, so it is a press. */
export function DerivedCard({ card, onRefresh }: {
  card: CanvasCard; onRefresh: () => void;
}) {
  const lines = typeof card.body === "string" ? card.body
    : card.body == null ? "" : JSON.stringify(card.body, null, 1);
  return (
    <PinCard
      title={card.title}
      note={`${card.stale ? "stale · " : ""}${staleLabel(card.generated)}`}
      right={
        <button type="button" onClick={onRefresh} title="recompute this card"
          className="hover:text-[var(--txb)]"
          style={{ appearance: "none", border: 0, background: "transparent",
                   color: "var(--txd)", cursor: "pointer", fontFamily: "inherit",
                   fontSize: "var(--t9)", letterSpacing: 1 }}>◇ REFRESH</button>
      }
    >
      <div style={{ padding: "10px 12px", fontSize: "var(--t10)", lineHeight: 1.7,
                    color: "var(--tx)", whiteSpace: "pre-wrap" }}>
        {lines || <span style={{ color: "var(--txf)" }}>nothing yet</span>}
      </div>
    </PinCard>
  );
}
```

In `Terminal.tsx`, replace the pin list built in Task 0 (`pinnedPanels`) with one that reads both kinds:

```tsx
  const { cards, refresh } = useCards(sessionId, turns.length);
  const pinnedItems = (pinned ?? []).map(pinKind);
  const pinnedPanels = pinnedItems.filter((p) => p.kind === "panel")
    .map((p) => panels?.find((t) => t.id === p.id)).filter((t): t is PanelTab => !!t);
  const pinnedCards = pinnedItems.filter((p) => p.kind === "card")
    .map((p) => cards.find((c) => c.key === p.id)).filter((c): c is CanvasCard => !!c);
```

and render `pinnedCards.map((c) => <DerivedCard key={c.key} card={c} onRefresh={() => void refresh(c.key)} />)` after the panels. `PinPicker` takes `cards` and renders one chip per available card under the panel chips, toggling `card:<key>`.

In `theme.ts`, the `canvasPins` sanitiser keeps unknown strings (`pinKind` handles the migration on read) — no change needed beyond the comment naming why bare ids are legal.

- [ ] **Step 4: Run the check and the typecheck**

Run:
```bash
node bridge/dashboard/web/src/lib/cards.check.ts
cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json
```
Expected: five `ok -` lines; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "ui(canvas): the gutter holds derived cards beside pinned panels"
```

---

### Task 4: `card:lesson` — the free one

**Files:**
- Modify: `bridge/cards.py` (`CARDS`)
- Test: `tests/test_cards.py` (append)

**Interfaces:**
- Consumes: `learn.lessons(cwd) -> list[dict]` with keys `file`, `title`, `concept`, `topic`, `at`.
- Produces: a `CARDS` entry `{"key": "lesson", …, "feature": None, "prompt": None}` whose body is `{"title", "concept", "file", "at"}` or `{}`.

- [ ] **Step 1: Write the failing test**

```python
def test_lesson_card_shows_the_newest_lesson(tmp_path, monkeypatch):
    from bridge import learn
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    monkeypatch.setattr(learn, "lessons", lambda cwd: [
        {"file": "b.md", "title": "Newest", "concept": "why", "topic": "t", "at": 200},
        {"file": "a.md", "title": "Older", "concept": "x", "topic": "t", "at": 100},
    ])
    out = cards.render("lesson", {"id": "s1", "cwd": "/tmp/repo"})
    assert out["body"]["title"] == "Newest" and out["body"]["file"] == "b.md"


def test_lesson_card_is_empty_without_lessons(tmp_path, monkeypatch):
    from bridge import learn
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    monkeypatch.setattr(learn, "lessons", lambda cwd: [])
    assert cards.render("lesson", {"id": "s1", "cwd": "/tmp/repo"})["body"] == {}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m pytest tests/test_cards.py -k lesson -q`
Expected: FAIL — the body is `None` because no `lesson` card is registered.

- [ ] **Step 3: Register the card**

In `bridge/cards.py`:

```python
def _lesson_facts(ctx: dict) -> dict:
    """learn.py already wrote this after the turn that built something. The card
    costs nothing: the whole feature is putting it where it will be read."""
    from bridge import learn   # local import: learn imports browser, which is heavy
    ls = learn.lessons(ctx.get("cwd") or "")
    return {k: ls[0][k] for k in ("title", "concept", "file", "at")} if ls else {}


CARDS = (
    {"key": "lesson", "title": "LESSON", "scope": "session", "shape": "lines",
     "feature": None,
     "watermark": lambda ctx: str((_lesson_facts(ctx) or {}).get("at", "")),
     "facts": _lesson_facts, "prompt": None},
)
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_cards.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/cards.py tests/test_cards.py
git commit -m "feat(cards): the lesson learn.py already wrote, where it gets read"
```

---

### Task 5: `card:live-files` — no backend at all

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/Canvas.tsx` (`LiveFilesCard`)
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx` (offer it in the picker)
- Create: `bridge/dashboard/web/src/lib/livefiles.check.ts`

**Interfaces:**
- Consumes: `byFile(edits: EditEv[]) -> FileEdit[]` from `lib/toolfold.ts`; the live run events the transcript already holds (`liveTurns`).
- Produces: `LiveFilesCard({ edits })` in `Canvas.tsx`; the picker chip id `card:live-files`, resolved client-side rather than from `/local/cards`.

- [ ] **Step 1: Write the failing check**

Create `bridge/dashboard/web/src/lib/livefiles.check.ts`:

```ts
// Run: node bridge/dashboard/web/src/lib/livefiles.check.ts
import { byFile } from "./toolfold.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const edits = [
  { path: "a.ts", patch: ["+1"], ms: 10, error: false },
  { path: "a.ts", patch: ["+2"], ms: 5, error: false },
  { path: "b.ts", patch: [], ms: 1, error: true },
] as Parameters<typeof byFile>[0];

const out = byFile(edits);
ok(out.length === 2, "two files, three edits");
ok(out.find((f) => f.path === "a.ts")!.count === 2, "repeat edits fold into one row");
ok(out.find((f) => f.path === "b.ts")!.error, "a failed edit keeps its error mark");
```

- [ ] **Step 2: Run it to verify it fails or passes**

Run: `node bridge/dashboard/web/src/lib/livefiles.check.ts`
Expected: three `ok -` lines. (`byFile` already exists — this check pins the contract the card depends on. If the field names differ, fix the check to match `toolfold.ts`, not the other way round.)

- [ ] **Step 3: Write the card**

In `Canvas.tsx`:

```tsx
/** What the running turn is touching, as state rather than as a stream. The
 *  transcript shows events in order; this shows the set of files now, which is
 *  the question "what is it doing" actually asks. No model, no endpoint. */
export function LiveFilesCard({ edits }: { edits: FileEdit[] }) {
  return (
    <PinCard title="LIVE FILES" note={edits.length ? `${edits.length} touched this turn` : undefined}>
      <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
        {edits.length === 0 && <span style={{ color: "var(--txf)", fontSize: "var(--t10)" }}>nothing yet</span>}
        {edits.map((f) => (
          <div key={f.path} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--t10)" }}>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden",
                           textOverflow: "ellipsis", direction: "rtl", textAlign: "left",
                           color: f.error ? "var(--red)" : "var(--tx)" }}>{f.path}</span>
            <span style={{ color: "var(--txf)", fontVariantNumeric: "tabular-nums" }}>×{f.count}</span>
          </div>
        ))}
      </div>
    </PinCard>
  );
}
```

In `Terminal.tsx`, derive `edits` from the live turn's events with the same `byFile` call `RunStream` uses, and render `LiveFilesCard` when `card:live-files` is pinned. The picker lists it alongside the server's cards, marked as free.

- [ ] **Step 4: Verify**

Run:
```bash
node bridge/dashboard/web/src/lib/livefiles.check.ts
cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json
```
Expected: three `ok -` lines; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "ui(canvas): the files a turn is touching, as state not stream"
```

---

### Task 6: `card:drift`

**Files:**
- Modify: `bridge/cards.py` (`CARDS`)
- Test: `tests/test_cards.py` (append)

**Interfaces:**
- Consumes: `store.recent_prompts(session_id, limit) -> list[str]` (**newest first**), `store.turn_metrics(session_id) -> list[dict]`.
- Produces: a `CARDS` entry `{"key": "drift", "feature": "card_drift", "prompt": _DRIFT}`; watermark `str(turn_count // 5)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_drift_watermark_moves_every_fifth_turn(monkeypatch):
    from bridge import store
    monkeypatch.setattr(store, "turn_metrics", lambda sid: [{}] * 7)
    spec = cards.card("drift")
    assert spec["watermark"]({"session": {"id": "s"}}) == "1"
    monkeypatch.setattr(store, "turn_metrics", lambda sid: [{}] * 10)
    assert spec["watermark"]({"session": {"id": "s"}}) == "2"


def test_drift_facts_carry_the_first_prompt_and_the_recent_ones(monkeypatch):
    from bridge import store
    monkeypatch.setattr(store, "recent_prompts",
                        lambda sid, n: ["newest", "middle", "first"])
    f = cards.card("drift")["facts"]({"session": {"id": "s", "stage": "build"}})
    assert f["asked"] == "first", "the oldest prompt in the window is the ask"
    assert f["recent"][0] == "newest" and f["stage"] == "build"
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_cards.py -k drift -q`
Expected: FAIL — `TypeError: 'NoneType' object is not subscriptable` (no `drift` card).

- [ ] **Step 3: Register the card**

```python
_DRIFT = (
    "You are given a coding session's opening request and its recent prompts.\n"
    "Answer in at most two short lines: what is this session doing NOW, versus "
    "what was asked? If they match, answer exactly ALIGNED and nothing else.\n"
    "No preamble, no markdown.\n\n{facts}"
)


def _drift_facts(ctx: dict) -> dict:
    from bridge import store
    sid = (ctx.get("session") or {}).get("id") or ""
    ps = store.recent_prompts(sid, 12)          # newest first
    return {"asked": (ps[-1] if ps else "")[:800],
            "recent": [p[:300] for p in ps[:5]],
            "stage": (ctx.get("session") or {}).get("stage") or ""}


def _drift_mark(ctx: dict) -> str:
    from bridge import store
    sid = (ctx.get("session") or {}).get("id") or ""
    # ponytail: every fifth turn, not every turn. Halve the spend by moving to
    # // 10 — the tradeoff is noticing a wandering run five turns later.
    return str(len(store.turn_metrics(sid)) // 5)
```

and the entry:

```python
    {"key": "drift", "title": "DRIFT", "scope": "session", "shape": "lines",
     "feature": "card_drift", "watermark": _drift_mark,
     "facts": _drift_facts, "prompt": _DRIFT},
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_cards.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/cards.py tests/test_cards.py
git commit -m "feat(cards): drift — what the session is doing vs what was asked"
```

---

### Task 7: `card:impact`

**Files:**
- Modify: `bridge/cards.py` (`CARDS`)
- Test: `tests/test_cards.py` (append)

**Interfaces:**
- Consumes: `git.status(cwd) -> {"files": [{"path","status","add","del",…}], …}`; `graphmap.has_graph(cwd) -> bool`; `graphmap.explain(cwd, query) -> str`.
- Produces: a `CARDS` entry `{"key": "impact", "feature": "card_impact", "prompt": _IMPACT}`; watermark = sorted changed paths joined.

- [ ] **Step 1: Write the failing tests**

```python
def test_impact_watermark_is_the_changed_set(monkeypatch):
    from bridge import git
    monkeypatch.setattr(git, "status", lambda cwd: {"files": [
        {"path": "b.py"}, {"path": "a.py"}]})
    mark = cards.card("impact")["watermark"]({"cwd": "/repo"})
    assert mark == "a.py|b.py", "order must not change the watermark"


def test_impact_without_a_graph_says_so_and_never_calls(tmp_path, monkeypatch):
    from bridge import git, graphmap
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    monkeypatch.setattr(git, "status", lambda cwd: {"files": [{"path": "a.py"}]})
    monkeypatch.setattr(graphmap, "has_graph", lambda cwd: False)
    called = []
    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: called.append(1) or "x")
    out = cards.render("impact", {"id": "s", "cwd": "/repo"})
    assert out["body"] == {"no_graph": True} and not called
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_cards.py -k impact -q`
Expected: FAIL — no `impact` card.

- [ ] **Step 3: Register the card**

```python
_IMPACT = (
    "You are given the files a coding turn changed and what the project's "
    "knowledge graph says about them.\n"
    "Write at most four lines: which subsystems this touches, and what else "
    "calls them. No preamble, no markdown, no restating the file list.\n\n{facts}"
)


def _impact_facts(ctx: dict) -> dict:
    from bridge import git, graphmap
    cwd = ctx.get("cwd") or ""
    paths = sorted(f["path"] for f in (git.status(cwd).get("files") or []))[:12]
    if not paths:
        return {}
    if not graphmap.has_graph(cwd):
        # The MAP tab builds it; a card must not shell out to a minutes-long
        # graphify build on a read.
        return {"no_graph": True}
    return {"changed": paths,
            "graph": graphmap.explain(cwd, f"what depends on {', '.join(paths[:6])}")[:3000]}
```

The watermark is the changed set, so a turn that edits nothing recomputes nothing:

```python
def _impact_mark(ctx: dict) -> str:
    from bridge import git
    files = git.status(ctx.get("cwd") or "").get("files") or []
    return "|".join(sorted(f["path"] for f in files))
```

and the entry:

```python
    {"key": "impact", "title": "IMPACT", "scope": "session", "shape": "lines",
     "feature": "card_impact", "watermark": _impact_mark,
     "facts": _impact_facts, "prompt": _IMPACT},
```

A bare marker must not reach the model, so in `render` (Task 1) replace the line
`if not spec["prompt"]:` with:

```python
    if not spec["prompt"] or not facts or set(facts) <= {"no_graph"}:
        body = facts
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_cards.py -q && python3 -m pytest tests/ -q`
Expected: all pass; full suite at baseline.

- [ ] **Step 5: Commit**

```bash
git add bridge/cards.py tests/test_cards.py
git commit -m "feat(cards): impact — the blast radius of what this turn edited"
```

---

### Task 8: The design gallery

**Files:**
- Create: `bridge/designdrafts.py`
- Modify: `bridge/dashboard/server.py` (GET routes)
- Modify: `bridge/dashboard/web/src/api.ts`
- Modify: `bridge/dashboard/web/src/components/hud/Canvas.tsx` (`DesignGallery`)
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx`
- Test: `tests/test_designdrafts.py` (new)

**Interfaces:**
- Produces:
  - `designdrafts.slugs(cwd) -> list[dict]` — `[{"slug", "files": [name…], "spec": str, "at": float}]`, newest first
  - `designdrafts.read(cwd, slug, name) -> str | None` — one draft file's text, name matched against what is on disk (the `learn.read` posture)
  - `GET /local/design/drafts?project=&branch=` → `{"drafts": […]}`
  - `GET /local/design/draft?project=&branch=&slug=&file=` → `{"html": str}`
  - `api.designDrafts(project, branch)`, `api.designDraft(project, branch, slug, file)`
  - `DesignGallery({ drafts, onOpen })` in `Canvas.tsx`

Drafts live in `.mystical/design-drafts/<slug>/`, written by the **design-first** skill: one self-contained HTML per screen (inline CSS, no external fetches) plus `SPEC.md`. Self-contained is what lets the card render them with `srcdoc` instead of a file server.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_designdrafts.py`:

```python
"""Design drafts on the board: listing and reading .mystical/design-drafts/."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import designdrafts  # noqa: E402


def _draft(tmp_path, slug, name, body="<html>hi</html>"):
    d = tmp_path / ".mystical" / "design-drafts" / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(body)
    return d


def test_slugs_lists_html_and_the_spec(tmp_path):
    d = _draft(tmp_path, "composer", "a.html")
    (d / "SPEC.md").write_text("intent")
    out = designdrafts.slugs(str(tmp_path))
    assert out[0]["slug"] == "composer" and out[0]["files"] == ["a.html"]
    assert out[0]["spec"] == "intent"


def test_read_only_returns_a_file_that_is_listed(tmp_path):
    _draft(tmp_path, "composer", "a.html", "<b>x</b>")
    assert designdrafts.read(str(tmp_path), "composer", "a.html") == "<b>x</b>"
    assert designdrafts.read(str(tmp_path), "composer", "../../../etc/passwd") is None
    assert designdrafts.read(str(tmp_path), "../..", "a.html") is None


def test_no_drafts_directory_is_an_empty_list_not_an_error(tmp_path):
    assert designdrafts.slugs(str(tmp_path)) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_designdrafts.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'bridge.designdrafts'`

- [ ] **Step 3: Write the module and the routes**

```python
"""What `/design-first` left in .mystical/design-drafts/, listed for the board.

The skill writes one self-contained HTML per screen — inline CSS, no external
fetches, because claude.ai renders them as preview cards. That constraint is
why the CANVAS gallery needs no file server: the dashboard reads the text and
hands it to an iframe's srcdoc.

Read-only and name-matched: a requested file must be one this module listed, the
posture learn.read takes, so a slug or filename off the wire can never walk out
of the drafts directory.
"""

import os

_DIR = os.path.join(".mystical", "design-drafts")


def _root(cwd: str) -> str:
    return os.path.join(cwd, _DIR)


def slugs(cwd: str) -> list:
    root = _root(cwd)
    try:
        names = [n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))]
    except OSError:
        return []
    out = []
    for n in names:
        d = os.path.join(root, n)
        try:
            files = sorted(f for f in os.listdir(d) if f.endswith(".html"))
            at = os.path.getmtime(d)
        except OSError:
            continue
        spec = ""
        try:
            with open(os.path.join(d, "SPEC.md")) as f:
                spec = f.read(4000)
        except OSError:
            pass
        out.append({"slug": n, "files": files, "spec": spec, "at": at})
    out.sort(key=lambda s: s["at"], reverse=True)
    return out


def read(cwd: str, slug: str, name: str) -> "str | None":
    entry = next((s for s in slugs(cwd) if s["slug"] == slug), None)
    if entry is None or name not in entry["files"]:
        return None
    try:
        with open(os.path.join(_root(cwd), slug, name)) as f:
            return f.read()
    except OSError:
        return None
```

Routes in `bridge/dashboard/server.py` (GET chain):

```python
        if path == "/local/design/drafts":
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json({"drafts": designdrafts.slugs(cwd)})
        if path == "/local/design/draft":
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            html = designdrafts.read(cwd, qs.get("slug", [""])[0], qs.get("file", [""])[0])
            return self._json({"html": html} if html is not None
                              else {"error": "unknown draft"}, 200 if html is not None else 404)
```

`DesignGallery` in `Canvas.tsx` renders, for the newest slug, one card per file laid out **across** the board (a row, not the gutter column) at `PIN_W * 1.4` wide, each an `<iframe srcdoc={html} sandbox="" />` scaled to fit, with the file name as its title. It mounts at world `top: 0, left: BOARD_W + 60` so the BOARD fit still frames the conversation and the gutter, and the gallery is a pan to the right.

- [ ] **Step 4: Run the tests and the typecheck**

Run:
```bash
python3 -m pytest tests/test_designdrafts.py -q
cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json
```
Expected: 4 passed; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/designdrafts.py bridge/dashboard/server.py bridge/dashboard/web/src tests/test_designdrafts.py
git commit -m "feat(canvas): design drafts render side by side on the board"
```

---

### Task 9: Judge and pick

**Files:**
- Modify: `bridge/designdrafts.py` (`judge`, `pick`)
- Modify: `bridge/dashboard/server.py` (POST routes)
- Modify: `bridge/dashboard/web/src/api.ts`, `Canvas.tsx`
- Test: `tests/test_designdrafts.py` (append)

**Interfaces:**
- Produces:
  - `designdrafts.judge(cwd, slug, name, chat_id) -> str` — one `cards._one_shot`, gated by `aifeatures.enabled("card_design")`, cached in `cards.json` under `design:<slug>/<name>:<mtime>`
  - `designdrafts.pick(cwd, slug, name) -> bool` — writes/replaces a `chosen: <name>` line in that slug's `SPEC.md`
  - `POST /local/design/judge` `{project, branch, slug, file}` → `{"text": str}`
  - `POST /local/design/pick` `{project, branch, slug, file}` → `{"ok": bool}`

- [ ] **Step 1: Write the failing tests**

```python
def test_pick_writes_chosen_once(tmp_path):
    d = _draft(tmp_path, "composer", "a.html")
    (d / "SPEC.md").write_text("# Intent\n\nsomething\n")
    assert designdrafts.pick(str(tmp_path), "composer", "a.html") is True
    body = (d / "SPEC.md").read_text()
    assert "chosen: a.html" in body
    designdrafts.pick(str(tmp_path), "composer", "a.html")
    assert body.count("chosen:") == 1, "picking twice must not stack lines"


def test_pick_refuses_a_file_that_is_not_listed(tmp_path):
    _draft(tmp_path, "composer", "a.html")
    assert designdrafts.pick(str(tmp_path), "composer", "b.html") is False


def test_judge_is_off_by_default(tmp_path, monkeypatch):
    from bridge import aifeatures
    _draft(tmp_path, "composer", "a.html")
    monkeypatch.setattr(aifeatures, "enabled", lambda k: False)
    assert designdrafts.judge(str(tmp_path), "composer", "a.html", 0) == ""
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_designdrafts.py -q`
Expected: FAIL — `AttributeError: module 'bridge.designdrafts' has no attribute 'pick'`

- [ ] **Step 3: Implement**

```python
_JUDGE = (
    "You are reviewing one design mockup for a phosphor-CRT terminal HUD: "
    "teal on black, monospace, corner-bracketed panels.\n"
    "Score hierarchy, contrast and state coverage. At most four lines, each "
    "starting with the aspect. Say what is wrong, not what is fine.\n\n{html}"
)


def judge(cwd: str, slug: str, name: str, chat_id: int) -> str:
    from bridge import aifeatures, cards
    if not aifeatures.enabled("card_design"):
        return ""
    html = read(cwd, slug, name)
    if html is None:
        return ""
    try:
        mtime = os.path.getmtime(os.path.join(_root(cwd), slug, name))
    except OSError:
        return ""
    slot = f"design:{slug}/{name}"
    state = cards._load()
    prev = state.get(slot) or {}
    if prev.get("mark") == str(mtime):
        return prev.get("body") or ""
    text = cards._one_shot(chat_id, _JUDGE.format(html=html[:8000]), cwd)
    if not text:
        return prev.get("body") or ""
    state[slot] = {"mark": str(mtime), "body": text, "at": time.time()}
    cards._save(state)
    return text


def pick(cwd: str, slug: str, name: str) -> bool:
    """Record the choice where /design-implement and the Claude Design push
    already look: the slug's own SPEC.md."""
    entry = next((s for s in slugs(cwd) if s["slug"] == slug), None)
    if entry is None or name not in entry["files"]:
        return False
    p = os.path.join(_root(cwd), slug, "SPEC.md")
    try:
        body = open(p).read() if os.path.exists(p) else ""
        lines = [ln for ln in body.splitlines() if not ln.startswith("chosen:")]
        lines.append(f"chosen: {name}")
        with open(p, "w") as f:
            f.write("\n".join(lines) + "\n")
        return True
    except OSError:
        return False
```

`judge` needs `import os, time` and `from bridge import cards` at the module top — the cache is deliberately the same file `cards.py` writes, keyed on the draft's mtime, so re-editing a mockup is what invalidates its critique. Add the two POST routes mirroring the GET ones, and a `JUDGE` / `PICK` button pair on each gallery card (JUDGE hidden while `card_design` is off — the switch's own rule).

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/ -q`
Expected: full suite at baseline plus the new tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/designdrafts.py bridge/dashboard/server.py bridge/dashboard/web/src tests/test_designdrafts.py
git commit -m "feat(canvas): judge a design variant, and record the pick"
```

---

### Task 10: Verify on the real board, then ship

**Files:** none — this task changes nothing, it proves the rest.

- [ ] **Step 1: Full backend suite**

Run: `python3 -m pytest tests/ -q`
Expected: green at or above the baseline recorded in Task 1.

- [ ] **Step 2: Frontend checks, typecheck, build**

```bash
node bridge/dashboard/web/src/lib/cards.check.ts
node bridge/dashboard/web/src/lib/livefiles.check.ts
node bridge/dashboard/web/src/lib/viewport.check.ts
cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json && ./node_modules/.bin/vite build --outDir /tmp/cards-dist --emptyOutDir
```
Expected: every check prints `ok -` lines; `tsc` exits 0; the build succeeds.

- [ ] **Step 3: Drive the board headlessly (bridge-eyes)**

Serve the scratch build read-only against the live bridge and screenshot, per the **bridge-eyes** skill:

```bash
python3 .mystical/probe/probe.py 8917 /tmp/cards-dist 8790 &
node .mystical/probe/shot2.mjs "http://127.0.0.1:8917/" /tmp/cards.png 1600 1000 9000 \
  '{"hud-settings":{"canvasPins":["card:lesson","card:drift","panel:changes"]},"hud-last-session":"<a session id>"}' \
  "<click CANVAS, then FOCUS, then BOARD>" 2500
```

Capture four states and look at each: a card with a body, a stale card, an empty card ("nothing yet"), and the design gallery at BOARD fit. Pick the port with `ss -ltn` first — another session may hold 8899. Kill the probe by pid, never `pkill -f` (it matches your own wrapper shell and exits 144).

- [ ] **Step 4: Commit the verification notes**

Append an "As built" section to the spec recording every deviation from the design, the way `2026-08-25-flow-native-chat-ui-design.md` does, and commit.

- [ ] **Step 5: Ship**

Per **bridge-ship**: build the dashboard into the bridge's LAUNCH checkout, restart the bridge from outside your own session's cgroup (`setsid`), and confirm the switches appear in SETTINGS ▸ AI EXTRAS and a card renders in the gutter of a live session. Nothing in this plan is live before that restart.

---

## Self-review notes

- **Spec coverage:** §1 → Task 1; §2 → Task 2; §3 → Task 3; §4a → Task 4; §4b → Task 5; §4c → Task 6; §4d → Task 7; §4e → Tasks 8–9; §5 → Task 2; §6 degradation → covered by the failure tests in Tasks 1, 7, 8; §7 testing → each task's own steps plus Task 10; §8 rollout → Task 10.
- **Known soft spots for the executor:** `config.py`'s boolean helper is named by the surrounding code, not by this plan — copy the neighbouring flags' form. `self._body()` in Task 2 must match whatever the POST handlers next to `/local/queue/` already use to read a JSON body. `FileEdit`'s field names in Task 5 come from `lib/toolfold.ts` — the check pins them, so run it before writing the card.
