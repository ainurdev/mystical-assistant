"""What an agent can show in the transcript besides words: a sheet, a chart, a board.

Plenty of answers have a shape, and a paragraph, a numbered list or a Markdown table loses it:
tasks, finances, test coverage by folder, benchmarks, bundle sizes, options side by side, how a
request moves through the code, what happened when. The
agent gets its data wherever it comes from and calls show_data once per view. The data goes on
the turn as a `data` event, and each surface draws it live: sortable, exportable,
readable on a phone. It is a snapshot of when it was asked, and says so: `as_of` and `source`.

This module is the contract, because a model writes the input. It normalizes the spec, so the
clients draw one shape, and the refusals are sentences the agent can act on. A value that won't
read as its column's type is left blank and counted, and the agent is told how many.
Totals are computed here, never taken from the agent: a total in a finance sheet shouldn't be a
number a model added up. Likewise a burndown's ideal line, a kanban's counts and a projection's
balances. Each view gets a ref, so the agent can place it in its answer with [[view:v1]]; a view
it doesn't place is drawn above the answer.

Size is capped because the event goes in the store and down every SSE stream. Past the cap, the
agent is told to aggregate, which is usually the better chart anyway. ponytail: a view is a
frozen copy of the data on the turn, with no way to refresh it or drop it short of the chat
going; asking again draws a new one. No HTML passes: clients draw values as text, and a card's
link has to be http(s).

Stdlib only. Pure: nothing here touches the disk or a job.
"""

import datetime as dt
import json
import math
import re

VIEWS = ("table", "chart", "kanban", "stats", "diagram")
CHARTS = ("bar", "bar_horizontal", "bar_stacked", "line", "step", "area", "donut", "burndown", "projection")
_FLOWING = ("line", "step", "area", "burndown")
COLUMN_TYPES = ("text", "number", "money", "percent", "progress", "date", "link")
FORMATS = ("number", "money", "percent", "text")
MAX_ROWS, MAX_COLUMNS, MAX_SERIES = 5000, 60, 8
MAX_BOARD_COLUMNS, MAX_CARDS, MAX_POINTS, MAX_STATS = 30, 1000, 500, 12
MAX_BYTES = 768 * 1024
DIAGRAMS = ("flow", "timeline")
SHAPES = ("process", "decision", "terminal")
MAX_NODES, MAX_EDGES, MAX_EVENTS = 60, 120, 100
MAX_NOTES, MAX_LINES, MAX_MONEY_EVENTS = 40, 8, 300
# Where an agent wants a view inside its answer. The clients cut the answer there; everywhere
# else (Telegram, a chat's history) it's noise, so strip_refs takes it out.
REF = re.compile(r"[ \t]*\[\[view:[\w-]+\]\][ \t]*")
_TEXT = 2000
_NUM = re.compile(r"^[^\d\-+.,]*([-+]?)\s*([\d.,'\s]+?)\s*([%a-zA-Z€$£¥]*)$")
_NEGATIVE_PARENS = re.compile(r"^\(\s*(.+?)\s*\)$")


class Refused(ValueError):
    """A sentence for the agent: what to change."""


def _s(v, cap: int = _TEXT) -> str:
    return " ".join(str(v).split())[:cap] if v is not None else ""


def to_number(v) -> "float | None":
    """A number from what agents really send: 1234.5, "1.234,56", "€ 1,234.56", "(40)", "12%".
    None when it isn't one. With one kind of separator repeated it's thousands; with both, the
    last one is the decimal point. "1.000" and "1,234" are None: they read a thousand times
    apart depending on who wrote them, and in a finance sheet a wrong guess is worse than a blank
    the agent is told about and can resend as a plain number."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    text = str(v).strip()
    negative = False
    m = _NEGATIVE_PARENS.match(text)
    if m:
        text, negative = m.group(1), True
    m = _NUM.match(text)
    if not m:
        return None
    sign, body = m.group(1), re.sub(r"[\s']", "", m.group(2))
    if not re.search(r"\d", body):
        return None
    commas, dots = body.count(","), body.count(".")
    if commas and dots:
        dec = "," if body.rfind(",") > body.rfind(".") else "."
        body = body.replace("." if dec == "," else ",", "").replace(dec, ".")
    elif commas > 1:
        body = body.replace(",", "")
    elif dots > 1:
        body = body.replace(".", "")
    elif commas == 1 or dots == 1:
        whole, frac = body.split("," if commas else ".")
        if len(frac) == 3 and 1 <= len(whole) <= 3 and whole.strip("0"):
            return None
        body = f"{whole}.{frac}"
    try:
        out = float(body)
    except ValueError:
        return None
    return -out if negative or sign == "-" else out


def to_date(v) -> "str | None":
    """An ISO date from what agents send. None when it isn't one."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if v <= 0:
            return None
        secs = v / 1000 if v > 1e11 else v
        return dt.datetime.fromtimestamp(secs, dt.timezone.utc).date().isoformat()
    text = str(v or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m"):
        try:
            d = dt.datetime.strptime(text[:10], fmt)
            return d.date().isoformat() if fmt != "%Y-%m" else text[:7]
        except ValueError:
            continue
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def _link(v) -> "str | None":
    text = str(v or "").strip()
    return text[:2000] if re.match(r"^https?://", text, re.I) else None


def _currency(v) -> str:
    text = str(v or "").strip().upper()
    return text if re.fullmatch(r"[A-Z]{3}", text) else ""


def _rows(spec: dict) -> list:
    rows = spec.get("rows")
    if not isinstance(rows, list) or not rows:
        raise Refused("rows must be a non-empty list of objects, one per row.")
    if not all(isinstance(r, dict) for r in rows):
        raise Refused("Each row must be an object keyed by column.")
    return rows


def _table(spec: dict) -> "tuple[dict, list]":
    rows = _rows(spec)
    if len(rows) > MAX_ROWS:
        raise Refused(f"That's {len(rows)} rows and a sheet holds {MAX_ROWS}. Group or filter it first.")
    cols = spec.get("columns")
    if not cols:
        keys: list = []
        for r in rows[:50]:
            keys += [k for k in r if k not in keys]
        cols = [{"key": k} for k in keys]
    if not isinstance(cols, list) or len(cols) > MAX_COLUMNS:
        raise Refused(f"columns must be a list of at most {MAX_COLUMNS}.")
    clean_cols, notes = [], []
    for c in cols:
        c = c if isinstance(c, dict) else {"key": c}
        key = _s(c.get("key"), 100)
        if not key:
            raise Refused("Every column needs a key.")
        kind = c.get("type") if c.get("type") in COLUMN_TYPES else "text"
        clean_cols.append({"key": key, "label": _s(c.get("label"), 100) or key, "type": kind,
                           "currency": _currency(c.get("currency") or spec.get("currency")) if kind == "money" else ""})
    out, totals = [], {}
    for r in rows:
        row = {}
        for c in clean_cols:
            v = r.get(c["key"])
            if v is None or v == "":
                row[c["key"]] = None
                continue
            if c["type"] in ("number", "money", "percent", "progress"):
                n = to_number(v)
                if n is None:
                    notes.append(f"{c['label']}: {_s(v, 40)!r} isn't a clear number; send it as a plain number")
                row[c["key"]] = n
            elif c["type"] == "date":
                d = to_date(v)
                if d is None:
                    notes.append(f"{c['label']}: {_s(v, 40)!r} isn't a date")
                row[c["key"]] = d
            elif c["type"] == "link":
                row[c["key"]] = _link(v)
            else:
                row[c["key"]] = _s(v)
        out.append(row)
    wanted = spec.get("totals", True) is not False
    for c in clean_cols:
        if wanted and c["type"] in ("number", "money"):
            nums = [r[c["key"]] for r in out if isinstance(r.get(c["key"]), float)]
            if nums:
                totals[c["key"]] = round(math.fsum(nums), 6)
    return {"columns": clean_cols, "rows": out, "totals": totals}, notes


def strip_refs(text: str) -> str:
    return REF.sub("", text or "")


def _epoch_days(iso: str) -> int:
    return dt.date.fromisoformat(iso).toordinal()


def _extras(spec: dict, out: dict, notes: list) -> None:
    """What any chart can say beyond its values: pins on points, lines across it, dashes."""
    points = out["points"]
    where = {p["x"]: i for i, p in enumerate(points)}
    keys = {s["key"] for s in out["series"]}
    raw = spec.get("annotations") if isinstance(spec.get("annotations"), list) else []
    if len(raw) > MAX_NOTES:
        raise Refused(f"A chart reads with at most {MAX_NOTES} annotations. Keep the ones that matter.")
    pins = []
    for a in raw:
        a = a if isinstance(a, dict) else {}
        x, label = _s(a.get("x"), 120), _s(a.get("label"), 160)
        iso = to_date(x) if x not in where else None
        i = where.get(x, where.get(iso))
        if i is None or not label:
            notes.append(f"annotation {label or x!r}: its x isn't on the chart, so it isn't shown")
            continue
        series = _s(a.get("series"), 100)
        pins.append({"i": i, "label": label, "note": _s(a.get("note"), 300), "series": series if series in keys else ""})
    out["annotations"] = sorted(pins, key=lambda p: p["i"])
    raw = spec.get("lines") if isinstance(spec.get("lines"), list) else []
    if len(raw) > MAX_LINES:
        raise Refused(f"A chart reads with at most {MAX_LINES} reference lines.")
    lines = []
    for ln in raw:
        y = to_number((ln or {}).get("y")) if isinstance(ln, dict) else None
        if y is not None:
            lines.append({"y": y, "label": _s(ln.get("label"), 80)})
    out["lines"] = lines
    for s, given in zip(out["series"], spec.get("series") or []):
        if isinstance(given, dict):
            s["dashed"] = given.get("dashed") is True
            start = _s(given.get("dashed_from"), 120)
            if start:
                i = where.get(start, where.get(to_date(start)))
                if i is None:
                    notes.append(f"{s['label']}: dashed_from {start!r} isn't on the chart")
                else:
                    s["dash_from"] = i


def _time_axis(out: dict) -> None:
    """Dates spaced as they are: a week and a month apart shouldn't look the same. Only when
    every x is a whole date, in the charts where distance along the axis means time."""
    if out["kind"] not in _FLOWING or len(out["points"]) < 2:
        return
    dates = [to_date(p["x"]) for p in out["points"]]
    if not all(d and len(d) == 10 for d in dates):
        return
    for p, d in zip(out["points"], dates):
        p["x"] = d
    out["points"].sort(key=lambda p: p["x"])
    out["xs"] = [_epoch_days(p["x"]) for p in out["points"]]


def _money_events(raw, whose: str) -> list:
    if not isinstance(raw, list):
        return []
    out = []
    for e in raw:
        e = e if isinstance(e, dict) else {}
        when = to_date(e.get("x") or e.get("date"))
        amount = to_number(e.get("amount"))
        if not when or len(when) != 10 or amount is None:
            raise Refused(f"{whose}: each event needs x as a date like 2026-12-01 and amount as a number "
                          f"(negative for money out). {_s(e.get('label'), 60) or e!r} doesn't.")
        out.append({"x": when, "amount": amount, "label": _s(e.get("label"), 120)})
    return out


def _projection(spec: dict) -> "tuple[dict, list]":
    """A balance over time, worked out here from a start and dated amounts, so "what would I have
    if I buy it in March instead" is arithmetic and not a model's guess. Each scenario is the shared
    events plus its own. Every event becomes a pin, so the chart says what happens at each point."""
    start = to_number(spec.get("start"))
    if start is None:
        raise Refused("A projection needs start: the balance it begins from, as a number.")
    common = _money_events(spec.get("events"), "events")
    raw = spec.get("scenarios") if isinstance(spec.get("scenarios"), list) else []
    if len(raw) > MAX_SERIES:
        raise Refused(f"A projection reads with at most {MAX_SERIES} scenarios.")
    scenarios = []
    for k, sc in enumerate(raw or [{"label": "Balance"}]):
        sc = sc if isinstance(sc, dict) else {"label": sc}
        label = _s(sc.get("label"), 100) or f"Scenario {k + 1}"
        scenarios.append({"key": f"s{k}", "label": label, "events": _money_events(sc.get("events"), label),
                          "start": to_number(sc.get("start"))})
    total = len(common) + sum(len(s["events"]) for s in scenarios)
    if not total:
        raise Refused("A projection needs events: [{x, amount, label}], in events or in a scenario.")
    if total > MAX_MONEY_EVENTS:
        raise Refused(f"A projection reads with at most {MAX_MONEY_EVENTS} events. Group them by month.")
    dates = {e["x"] for e in common} | {e["x"] for s in scenarios for e in s["events"]}
    begin = to_date(spec.get("from")) or dt.date.today().isoformat()
    begin = min(begin, min(dates))
    end = to_date(spec.get("until"))
    dates |= {begin, *([end] if end and len(end) == 10 else [])}
    ordered = sorted(dates)
    index = {d: i for i, d in enumerate(ordered)}
    points = [{"x": d} for d in ordered]
    pins, outlook = [], []
    for e in common:
        pins.append({"i": index[e["x"]], "label": e["label"] or "Change", "amount": e["amount"], "note": "", "series": ""})
    for s in scenarios:
        for e in s["events"]:
            pins.append({"i": index[e["x"]], "label": e["label"] or "Change", "amount": e["amount"], "note": "", "series": s["key"]})
        bal = start if s["start"] is None else s["start"]
        low, low_x = None, begin
        for d, p in zip(ordered, points):
            bal = math.fsum([bal, *(e["amount"] for e in common + s["events"] if e["x"] == d)])
            p[s["key"]] = round(bal, 2)
            if low is None or p[s["key"]] < low:
                low, low_x = p[s["key"]], d
        outlook.append({"series": s["key"], "label": s["label"], "end": round(bal, 2), "low": low, "low_x": low_x})
    fmt = spec.get("format") if spec.get("format") in ("number", "money") else "money"
    out = {"kind": "step", "projection": True, "x_label": _s(spec.get("x_label"), 100), "y_label": _s(spec.get("y_label"), 100),
           "format": fmt, "currency": _currency(spec.get("currency")),
           "series": [{"key": s["key"], "label": s["label"], "dashed": True} for s in scenarios],
           "points": points, "xs": [_epoch_days(d) for d in ordered], "annotations": sorted(pins, key=lambda p: p["i"]),
           "lines": [], "outlook": outlook}
    notes: list = []
    lines = spec.get("lines") if isinstance(spec.get("lines"), list) else []
    for ln in lines[:MAX_LINES]:
        y = to_number(ln.get("y")) if isinstance(ln, dict) else None
        if y is not None:
            out["lines"].append({"y": y, "label": _s(ln.get("label"), 80)})
    return out, notes


def _chart(spec: dict) -> "tuple[dict, list]":
    kind = spec.get("kind") or "bar"
    if kind not in CHARTS:
        raise Refused(f"kind must be one of {', '.join(CHARTS)}.")
    if kind == "projection":
        return _projection(spec)
    rows = _rows(spec)
    if len(rows) > MAX_POINTS:
        raise Refused(f"That's {len(rows)} points and a chart holds {MAX_POINTS}. Bucket it by week or month.")
    x = spec.get("x")
    x = _s((x.get("key") if isinstance(x, dict) else x) or "")
    keys = [k for r in rows[:20] for k in r]
    if not x:
        x = keys[0] if keys else ""
    raw = spec.get("series")
    if not raw:
        raw = [k for k in dict.fromkeys(keys) if k != x and to_number(rows[0].get(k)) is not None]
    series = []
    for s in raw if isinstance(raw, list) else []:
        s = s if isinstance(s, dict) else {"key": s}
        key = _s(s.get("key"), 100)
        if key and key != x:
            series.append({"key": key, "label": _s(s.get("label"), 100) or key})
    if not series:
        raise Refused("A chart needs at least one numeric series: name it in `series`.")
    if len(series) > MAX_SERIES:
        raise Refused(f"A chart reads with at most {MAX_SERIES} series. Fold the rest into Other, or split it into charts.")
    if kind in ("donut",) and len(series) > 1:
        raise Refused("A donut shows one series. Use bar_stacked for several.")
    if kind == "donut" and len(rows) > MAX_SERIES:
        raise Refused(f"A donut reads with at most {MAX_SERIES} slices. Fold the rest into Other, or use a bar chart.")
    points, notes = [], []
    for r in rows:
        p = {"x": _s(r.get(x), 120)}
        for s in series:
            v = r.get(s["key"])
            n = None if v is None or v == "" else to_number(v)
            if n is None and v not in (None, ""):
                notes.append(f"{s['label']} at {p['x']}: {_s(v, 40)!r} isn't a clear number; send it as a plain number")
            p[s["key"]] = n
        points.append(p)
    if kind == "donut" and any((p[series[0]["key"]] or 0) < 0 for p in points):
        raise Refused("A donut can't show negative values. Use a bar chart.")
    out = {"kind": kind, "x_label": _s(spec.get("x_label"), 100), "y_label": _s(spec.get("y_label"), 100),
           "format": spec.get("format") if spec.get("format") in FORMATS else "number",
           "currency": _currency(spec.get("currency")), "series": series, "points": points}
    if kind == "burndown":      # its ideal line is by position, so it keeps its points in order
        out["ideal"] = _ideal(points, series[0]["key"], spec)
    else:
        _time_axis(out)
    _extras(spec, out, notes)
    return out, notes


def _ideal(points: list, key: str, spec: dict) -> list:
    """The straight line from where the work started to zero by the last point. Computed, as the
    agent's job is the actuals. `ideal_end` overrides zero for a scope that doesn't reach it."""
    start = next((p[key] for p in points if isinstance(p.get(key), float)), None)
    if start is None:
        raise Refused("A burndown needs its first point to have a value.")
    end = to_number(spec.get("ideal_end")) or 0.0
    n = max(len(points) - 1, 1)
    return [round(start + (end - start) * i / n, 6) for i in range(len(points))]


def _kanban(spec: dict) -> "tuple[dict, list]":
    cols = spec.get("columns")
    if not isinstance(cols, list) or not cols:
        raise Refused("columns must be a list of {name, cards: [...]}, including empty ones.")
    if len(cols) > MAX_BOARD_COLUMNS:
        raise Refused(f"A board holds {MAX_BOARD_COLUMNS} columns.")
    out, total, notes = [], 0, []
    for c in cols:
        if not isinstance(c, dict) or not _s(c.get("name")):
            raise Refused("Each column needs a name.")
        cards = []
        for card in c.get("cards") or []:
            card = card if isinstance(card, dict) else {"title": card}
            title = _s(card.get("title"), 300)
            if not title:
                notes.append(f"{c.get('name')}: a card with no title was dropped")
                continue
            due = to_date(card["due"]) if card.get("due") else None
            tags = card.get("tags") if isinstance(card.get("tags"), list) else []
            cards.append({"title": title, "key": _s(card.get("key"), 40), "assignee": _s(card.get("assignee"), 80),
                          "due": due, "priority": _s(card.get("priority"), 20), "note": _s(card.get("note"), 400),
                          "tags": [_s(t, 40) for t in tags[:8] if _s(t, 40)], "url": _link(card.get("url"))})
        total += len(cards)
        if total > MAX_CARDS:
            raise Refused(f"A board holds {MAX_CARDS} cards. Filter it, by assignee or by sprint.")
        limit = to_number(c.get("limit"))
        out.append({"name": _s(c.get("name"), 80), "cards": cards, "limit": int(limit) if limit else None})
    return {"columns": out, "count": total}, notes


def _stats(spec: dict) -> "tuple[dict, list]":
    items = spec.get("items")
    if not isinstance(items, list) or not items:
        raise Refused("items must be a list of {label, value}.")
    if len(items) > MAX_STATS:
        raise Refused(f"At most {MAX_STATS} headline figures: past that it's a table.")
    out, notes = [], []
    for it in items:
        if not isinstance(it, dict) or not _s(it.get("label")):
            raise Refused("Each item needs a label and a value.")
        fmt = it.get("format") if it.get("format") in FORMATS else "number"
        val = it.get("value")
        if fmt != "text":
            n = to_number(val)
            if n is None:
                fmt = "text"
            else:
                val = n
        else:
            val = _s(val, 80)
        out.append({"label": _s(it.get("label"), 80), "value": val if fmt != "text" else _s(val, 80), "format": fmt,
                    "currency": _currency(it.get("currency") or spec.get("currency")),
                    "delta": to_number(it.get("delta")), "note": _s(it.get("note"), 160)})
    return {"items": out}, notes


def _flow(spec: dict) -> "tuple[dict, list]":
    raw = spec.get("nodes")
    if not isinstance(raw, list) or not raw:
        raise Refused("A flow needs nodes: [{id, label}], and edges: [{from, to}].")
    if len(raw) > MAX_NODES:
        raise Refused(f"A flow reads with at most {MAX_NODES} steps. Split it, or group some into one.")
    nodes, ids, groups = [], set(), []
    for n in raw:
        n = n if isinstance(n, dict) else {"id": n}
        nid = _s(n.get("id"), 80)
        if not nid or nid in ids:
            raise Refused(f"Every node needs its own id, and {nid or 'one'!r} isn't.")
        ids.add(nid)
        group = _s(n.get("group"), 60)
        if group and group not in groups:
            groups.append(group)
        nodes.append({"id": nid, "label": _s(n.get("label"), 120) or nid, "note": _s(n.get("note"), 160),
                      "shape": n.get("shape") if n.get("shape") in SHAPES else "process", "group": group})
    if len(groups) > MAX_SERIES:
        raise Refused(f"At most {MAX_SERIES} groups: past that the colours stop meaning anything.")
    rawe = spec.get("edges") if isinstance(spec.get("edges"), list) else []
    if len(rawe) > MAX_EDGES:
        raise Refused(f"A flow reads with at most {MAX_EDGES} arrows. Split it.")
    edges = []
    for e in rawe:
        a, b = _s((e or {}).get("from"), 80), _s((e or {}).get("to"), 80)
        if a not in ids or b not in ids:
            raise Refused(f"The arrow from {a!r} to {b!r} names a node that isn't in nodes.")
        edges.append({"from": a, "to": b, "label": _s(e.get("label"), 60)})
    return {"kind": "flow", "nodes": nodes, "edges": edges, "groups": groups,
            "direction": spec.get("direction") if spec.get("direction") in ("right", "down") else ""}, []


def _timeline(spec: dict) -> "tuple[dict, list]":
    raw = spec.get("items")
    if not isinstance(raw, list) or not raw:
        raise Refused("A timeline needs items: [{date, label}].")
    if len(raw) > MAX_EVENTS:
        raise Refused(f"A timeline reads with at most {MAX_EVENTS} events. Group them by month.")
    items = []
    for it in raw:
        it = it if isinstance(it, dict) else {"label": it}
        label = _s(it.get("label"), 200)
        if not label:
            raise Refused("Each event needs a label.")
        items.append({"date": _s(it.get("date"), 40), "label": label, "note": _s(it.get("note"), 300),
                      "state": it.get("state") if it.get("state") in ("done", "now", "next") else ""})
    return {"kind": "timeline", "items": items}, []


def _diagram(spec: dict) -> "tuple[dict, list]":
    kind = spec.get("kind") or "flow"
    if kind not in DIAGRAMS:
        raise Refused(f"A diagram's kind is one of {', '.join(DIAGRAMS)}.")
    return _flow(spec) if kind == "flow" else _timeline(spec)


_BUILD = {"table": _table, "chart": _chart, "kanban": _kanban, "stats": _stats, "diagram": _diagram}


def build(spec: dict) -> "tuple[dict, list]":
    """(the `data` event, notes for the agent). Refused with a sentence when it can't be drawn."""
    if not isinstance(spec, dict):
        raise Refused("Give the view as an object.")
    view = spec.get("view")
    if view not in VIEWS:
        raise Refused(f"view must be one of {', '.join(VIEWS)}.")
    title = _s(spec.get("title"), 200)
    if not title:
        raise Refused("Give it a title: what this is, as you'd say it to the user.")
    body, notes = _BUILD[view](spec)
    ev = {"type": "data", "view": view, "title": title, "caption": _s(spec.get("caption"), 400),
          "source": _s(spec.get("source"), 200), "as_of": _s(spec.get("as_of"), 40) or dt.date.today().isoformat(),
          **body}
    size = len(json.dumps(ev))
    if size > MAX_BYTES:
        raise Refused(f"That's {size // 1024} KB and a view holds {MAX_BYTES // 1024} KB. Group or filter it first.")
    return ev, notes


def describe(ev: dict) -> str:
    """One line for the agent, and for a chat's history when it moves to another provider."""
    v = ev["view"]
    if v == "table":
        n = f"{len(ev['rows'])} rows"
        names = {c["key"]: c["label"] for c in ev["columns"]}
        totals = ", ".join(f"{names[k]} total {t:,.2f}" for k, t in ev["totals"].items())
        return f"a sheet, {ev['title']}: {n}" + (f" ({totals})" if totals else "")
    if v == "chart":
        if ev.get("outlook"):
            said = "; ".join(f"{s['label']} ends at {s['end']:,.2f}, lowest {s['low']:,.2f} on {s['low_x']}" for s in ev["outlook"])
            return f"a projection, {ev['title']}: {said}"
        kind = {"bar_stacked": "stacked bar", "bar_horizontal": "horizontal bar", "area": "filled area"}.get(ev["kind"], ev["kind"])
        return f"a {kind} chart, {ev['title']}: {len(ev['points'])} points"
    if v == "kanban":
        cards = "1 card" if ev["count"] == 1 else f"{ev['count']} cards"
        return f"a board, {ev['title']}: {cards} in {len(ev['columns'])} columns"
    if v == "diagram":
        if ev["kind"] == "flow":
            return f"a flow diagram, {ev['title']}: {len(ev['nodes'])} steps"
        return f"a timeline, {ev['title']}: {len(ev['items'])} events"
    return f"headline figures, {ev['title']}"
