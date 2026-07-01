"""Teacher mode: propose review candidates after code turns, and generate
on-demand teaching content. Every Claude call goes through runner.run_blocking.
Capture is best-effort — nothing here may raise into the turn lifecycle."""
import json
import sys

from bridge import config, runner, store

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
            owner_id, prompt, cwd=project_path or None, timeout=60, model="haiku")
    except Exception as e:  # noqa: BLE001
        print(f"[learning] extract call failed: {e}", file=sys.stderr)
        return []
    return [] if is_error else _parse_candidates(text)


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
            item["owner_id"], prompt, cwd=item.get("project_path") or None, timeout=120)
    except Exception as e:  # noqa: BLE001
        print(f"[learning] teach call failed: {e}", file=sys.stderr)
        return ""
    return "" if is_error else (text or "")
