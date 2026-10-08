import type { PrComment, PrInfo, PrState } from "../api";

/** The PR chip's words and colours, and the messages its buttons send
 *  (components/hud/PrChip.tsx, review loop B/C). Pure, so prchip.check.ts
 *  can run it under node. */

/** Sheet C in the app's tokens: --acc running, --err failing, --ok green
 *  (READY filled), --warn review comments, --purple merged. `ink` is the
 *  state's colour on the popover, where READY's fill would vanish. */
export const TONE: Record<PrState, { fg: string; border: string; bg: string; num: string; ink: string; glyph: string }> = {
  running: { fg: "var(--acc)", border: "color-mix(in srgb, var(--acc) 40%, transparent)", bg: "color-mix(in srgb, var(--acc) 8%, transparent)", num: "var(--txh)", ink: "var(--acc)", glyph: "◌" },
  failing: { fg: "var(--err-hi)", border: "color-mix(in srgb, var(--err) 45%, transparent)", bg: "color-mix(in srgb, var(--err) 10%, transparent)", num: "var(--txh)", ink: "var(--err)", glyph: "✕" },
  review: { fg: "var(--ok)", border: "color-mix(in srgb, var(--ok) 35%, transparent)", bg: "transparent", num: "var(--txh)", ink: "var(--ok)", glyph: "✓" },
  changes: { fg: "var(--warn)", border: "color-mix(in srgb, var(--warn) 45%, transparent)", bg: "color-mix(in srgb, var(--warn) 9%, transparent)", num: "var(--txh)", ink: "var(--warn)", glyph: "◆" },
  ready: { fg: "var(--acc-on)", border: "var(--ok)", bg: "var(--ok)", num: "var(--acc-on)", ink: "var(--ok)", glyph: "✓" },
  merged: { fg: "var(--purple-h)", border: "color-mix(in srgb, var(--purple) 45%, transparent)", bg: "color-mix(in srgb, var(--purple) 10%, transparent)", num: "var(--txh)", ink: "var(--purple)", glyph: "⇡" },
  closed: { fg: "var(--txl)", border: "color-mix(in srgb, var(--txl) 35%, transparent)", bg: "transparent", num: "var(--txm)", ink: "var(--txl)", glyph: "⇡" },
};

/** What SEND n COMMENTS sends: the review's own words first, if it has any,
 *  then each inline comment. */
export function reviewItems(pr: PrInfo): PrComment[] {
  const r = pr.review;
  if (!r) return [];
  return [...(r.body ? [{ path: "", line: null, body: r.body }] : []), ...r.comments];
}

/** The chip's text after "⇡ #131" (sheet C). `spin` draws the running ring. */
export function chipLabel(pr: PrInfo): { text: string; spin: boolean } {
  switch (pr.status) {
    case "running": return { text: `${pr.passed + pr.failed}/${pr.total}`, spin: true };
    case "failing": return { text: `✕ ${pr.failed} FAILING`, spin: false };
    case "review": {
      const word = pr.draft ? "DRAFT" : "REVIEW";
      return { text: pr.total ? `✓ ${pr.passed}/${pr.total} · ${word}` : word, spin: false };
    }
    case "changes": {
      const n = reviewItems(pr).length;
      return { text: n ? `◆ ${n} COMMENT${n === 1 ? "" : "S"}` : "◆ CHANGES", spin: false };
    }
    case "ready": return { text: "✓ READY", spin: false };
    case "merged": return { text: "MERGED", spin: false };
    case "closed": return { text: "CLOSED", spin: false };
  }
}

/** The popover's state words: OPEN, CHANGES REQUESTED, MERGED INTO MAIN. */
export function stateLine(pr: PrInfo): string {
  if (pr.state === "MERGED") return `MERGED INTO ${pr.base.toUpperCase()}`;
  if (pr.state === "CLOSED") return "CLOSED";
  if (pr.status === "changes") return "CHANGES REQUESTED";
  if (pr.draft) return "DRAFT";
  if (pr.status === "ready") return "READY";
  return "OPEN";
}

/** A check's duration: "48s" or "2m 14s", with "…" while it runs. Blank
 *  without a start. */
export function duration(started: string, completed: string, now: number): string {
  const a = Date.parse(started);
  if (!started || Number.isNaN(a)) return "";
  const b = completed ? Date.parse(completed) : now;
  const s = Math.max(0, Math.round(((Number.isNaN(b) ? now : b) - a) / 1000));
  const txt = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return completed ? txt : `${txt}…`;
}

/** SEND FAILURE TO AGENT: the PR, then each failing check with its link and
 *  log, as one message. */
export function failureMessage(pr: PrInfo): string {
  const bad = pr.checks.filter((c) => c.state === "fail");
  const out = [`Checks failed on PR #${pr.number} · ⎇ ${pr.head} (${bad.length}): ${pr.url}`];
  for (const c of bad) {
    out.push("", `${c.name}${c.url ? ` — ${c.url}` : ""}`);
    out.push(c.log ? "```\n" + c.log + "\n```" : "(no log here, open the link)");
  }
  return out.join("\n");
}

/** SEND n COMMENTS TO AGENT: shaped like the diff notes' message (sheet A). */
export function commentsMessage(pr: PrInfo): string {
  const items = reviewItems(pr);
  const by = pr.review?.by ? ` by ${pr.review.by}` : "";
  const out = [`Changes requested${by} on PR #${pr.number} · ⎇ ${pr.head} (${items.length}): ${pr.url}`];
  for (const c of items) {
    if (c.path) out.push(`${c.path}${c.line ? `:${c.line}` : ""}`);
    for (const l of c.body.trim().split("\n")) out.push(`  ${l}`);
  }
  return out.join("\n");
}

/** The bell's line for one of the bridge's alert keys. */
export function pingText(pr: PrInfo, key: string): string {
  if (key.startsWith("failing:")) {
    const names = pr.checks.filter((c) => c.state === "fail").map((c) => c.name).join(", ");
    return `PR #${pr.number} · ${pr.failed} check${pr.failed === 1 ? "" : "s"} failing${names ? ` — ${names}` : ""}`;
  }
  return `PR #${pr.number} · changes requested${pr.review?.by ? ` by ${pr.review.by}` : ""}`;
}

/** Bell pings due now: alerts the bridge holds that this browser hasn't shown yet. */
export const freshPings = (seen: string[], pinged: string[]) => pinged.filter((k) => !seen.includes(k));

/** The popover's fixed-position offsets: under the chip, 8px off it and off the
 *  window's edge — unless there's more room over it. The COMPACT layout moves
 *  the nameplate, chip and all, down into the composer, where under the chip is
 *  a strip a few rows tall. */
export function popPlace(chip: { top: number; bottom: number }, vh: number): { top?: number; bottom?: number; maxHeight: number } {
  return chip.top > vh - chip.bottom
    ? { bottom: vh - chip.top + 8, maxHeight: chip.top - 16 }
    : { top: chip.bottom + 8, maxHeight: vh - chip.bottom - 24 };
}
