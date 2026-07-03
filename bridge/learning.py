"""Teacher mode: propose review candidates after code turns, and generate
on-demand teaching content. Every Claude call goes through runner.run_blocking.
Capture is best-effort — nothing here may raise into the turn lifecycle."""
import json
import sys

from bridge import config, native, runner, store

EDIT_TOOLS = {"Edit", "Write", "MultiEdit"}

_EXTRACT_SYS = (
    "You are a learning coach reviewing a coding assistant's work. From the "
    "assistant output below, identify AT MOST 2 concepts or code patterns the "
    "developer likely accepted WITHOUT fully understanding and should review "
    "later. If the work did not involve writing or changing code, or nothing is "
    "worth reviewing, return an empty array. Respond with ONLY a JSON array of "
    'objects, each exactly {"title": short concept name, "snippet": smallest '
    'relevant code excerpt (may be ""), "why_it_matters": one sentence}. '
    "No prose, no markdown fences."
)


def _parse_candidates(raw: str) -> list[dict]:
    s = (raw or "").strip()
    if s.startswith("```"):
        s = s[3:]                        # drop the opening fence only
        nl = s.find("\n")
        if nl != -1:
            s = s[nl + 1:]               # drop the ```lang tag line
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]          # drop the closing fence only
        s = s.strip()
    try:
        data = json.loads(s)
    except (ValueError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for d in data:
        if isinstance(d, dict) and isinstance(d.get("title"), str) and d["title"].strip():
            out.append({"title": d["title"].strip(),
                        "snippet": str(d.get("snippet") or ""),
                        "why_it_matters": str(d.get("why_it_matters") or "")})
        if len(out) >= 2:
            break
    return out


def propose_review_items(owner_id: int, project_path: str, assistant_text: str,
                         edits_summary: str, *, edited: bool | None) -> list[dict]:
    if not getattr(config, "LEARNING_ENABLE", True):
        return []
    if not (assistant_text or edits_summary):
        return []
    gate = ("\nNOTE: it is UNKNOWN whether code changed; return [] unless code "
            "was clearly written or edited.") if edited is None else ""
    prompt = (f"{_EXTRACT_SYS}{gate}\n\n=== ASSISTANT OUTPUT ===\n{assistant_text}\n\n"
              f"=== EDITS ===\n{edits_summary}")
    try:
        text, _sid, _cost, is_error = runner.run_blocking(
            owner_id, native.INTERNAL_ONESHOT_TAG + "\n" + prompt,
            cwd=project_path or None, timeout=60, model="haiku")
    except Exception as e:  # noqa: BLE001
        print(f"[learning] extract call failed: {e}", file=sys.stderr)
        return []
    return [] if is_error else _parse_candidates(text)


def capture_after_turn(chat_id: int, session: dict, turn_id: str, *,
                       tool_visibility: bool) -> None:
    """Best-effort: propose review candidates for a finished turn. Streaming
    surfaces set tool_visibility=True (we can trust the absence of Edit/Write to
    mean 'no code change'); the bot sets False (unknown — the extractor decides)."""
    try:
        if not getattr(config, "LEARNING_ENABLE", True):
            return
        evs = [e for e in store.transcript(session["id"])["events"]
               if e.get("turn_id") == turn_id]
        edited_tools = [e for e in evs
                        if e.get("type") == "tool" and e.get("name") in EDIT_TOOLS]
        edited = bool(edited_tools)
        if tool_visibility and not edited:
            return
        texts = [e["text"] for e in evs if e.get("type") == "text" and e.get("text")]
        if not texts:
            texts = [e.get("result", "") for e in evs if e.get("type") == "result"]
        assistant_text = "\n\n".join(t for t in texts if t)[:6000]
        edits_summary = "\n".join(e.get("summary", "") for e in edited_tools)[:2000]
        cands = propose_review_items(chat_id, session["project"], assistant_text,
                                     edits_summary,
                                     edited=(edited if tool_visibility else None))
        for c in cands:
            item = store.add_learning_item(
                chat_id, session["project"], c["title"], session_id=session["id"],
                source_turn_id=turn_id, code_snippet=c["snippet"],
                why_it_matters=c["why_it_matters"], status="candidate")
            if tool_visibility:
                store.append_event(session["id"], turn_id, {
                    "type": "review_candidate", "item_id": item["id"],
                    "title": item["title"], "why_it_matters": item["why_it_matters"],
                    "snippet": item["code_snippet"]})
            else:
                _send_bot_candidate_card(chat_id, item)
    except Exception as e:  # noqa: BLE001
        print(f"[learning] capture failed: {e}", file=sys.stderr)


def _send_bot_candidate_card(chat_id: int, item: dict) -> None:
    from bridge import telegram  # local import: avoid import cycles at module load
    text = "📚 Review later?\n" + item["title"]
    if item["why_it_matters"]:
        text += "\n" + item["why_it_matters"]
    kb = {"inline_keyboard": [[
        {"text": "✅ Keep", "callback_data": f"rvw:k:{item['id']}"},
        {"text": "✖ Skip", "callback_data": f"rvw:s:{item['id']}"}]]}
    telegram.send(chat_id, text, reply_markup=kb)


def teach(item: dict, mode: str, *, user_answer: str | None = None) -> str:
    ctx = (f"Concept: {item.get('title', '')}\n"
           f"Why it matters: {item.get('why_it_matters', '')}\n"
           f"Code:\n{item.get('code_snippet', '')}")
    if mode == "explain":
        prompt = ("Explain this concept clearly to a developer who accepted it "
                  "without fully understanding it. Cover what it does, why it is "
                  "written this way, and one common alternative with its tradeoff. "
                  f"Be concise.\n\n{ctx}")
    elif mode == "quiz":
        prompt = ("Ask ONE focused question that tests whether the developer "
                  f"understands this concept. Output only the question.\n\n{ctx}")
    elif mode == "exercise":
        prompt = ("Give ONE small by-hand exercise (~15 minutes max) that builds "
                  f"intuition for this concept. Output the task only.\n\n{ctx}")
    elif mode == "grade":
        prompt = ("The developer was asked to explain the concept below in their "
                  "own words. Grade their understanding: name what is correct, what "
                  "is missing or wrong, and the one thing to remember. Be direct and "
                  f"brief.\n\n{ctx}\n\n=== THEIR ANSWER ===\n{user_answer or ''}")
    else:
        return ""
    try:
        text, _sid, _cost, is_error = runner.run_blocking(
            item["owner_id"], native.INTERNAL_ONESHOT_TAG + "\n" + prompt,
            cwd=item.get("project_path") or None, timeout=120)
    except Exception as e:  # noqa: BLE001
        print(f"[learning] teach call failed: {e}", file=sys.stderr)
        return ""
    return "" if is_error else (text or "")
