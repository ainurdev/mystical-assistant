/* The GIT tab's status card (/design-first git-calm, A · PIPE, 2026-11-19):
   the one step this branch is on, a headline that says the situation in plain
   words, and three stops (local, committed, origin) with what sits at each.
   Pure, so the panel only maps the step to its button; the step order is the
   ledger's NEXT STEP order: commit, then sync with origin, then push, then a
   pull request, then whatever the PR needs from you. */
import type { PrInfo } from "../api";
import type { Sync } from "./gitsync";

export interface CardIn {
  sync: Sync;
  dirty: number;     // changed files
  staged: number;    // of those, staged
  up: number;        // commits only here
  down: number;      // commits only on origin
  base: string;      // the branch this one is compared with; "" until the ledger reads
  shippedN: number;  // on origin, not in the base
  pr: PrInfo | null; // the open pull request
  canSend: boolean;  // a chat to send review comments to
  fresh: string;     // origin's freshness, short ("1m ago", "not checked")
}
export type Step = "commit" | "sync" | "push" | "pr" | "fix";
export type Tone = "on" | "ask" | "ok" | "dim" | "";
export interface Stop { tone: Tone; icon: "laptop" | "check" | "up" | "down" | "cloud" | "pr"; value: string }
export interface Card { step: Step | null; amber: boolean; head: string; sub: string; stops: [Stop, Stop, Stop] }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function gitCard(c: CardIn): Card {
  const { sync, dirty, staged, up, down, base, shippedN, pr } = c;
  const failing = !!pr && (pr.failed > 0 || (!!pr.review && c.canSend));
  const step: Step | null = dirty ? "commit" : down ? "sync" : up ? "push"
    : base && shippedN > 0 && !pr ? "pr" : failing ? "fix" : null;
  const remote = sync.kind !== "local" && sync.kind !== "detached" && sync.kind !== "none";
  const fails = pr?.checks.filter((k) => k.state === "fail").map((k) => k.name) ?? [];

  const [head, sub] = step === "commit"
    ? ["Your work is still on this computer",
      `Commit ${staged ? `${staged} of ${plural(dirty, "file")}` : plural(dirty, "file")}${down ? `, then bring in origin's ${down}` : remote ? ", then push" : ""}.`]
    : step === "sync" ? (sync.kind === "diverged"
      ? ["You and origin both moved", `${up} here, ${down} on origin. Merge them in.`]
      : [`Origin has ${plural(down, "new commit")}`, `Pull ${down === 1 ? "it" : "them"} in to catch up.`])
    : step === "push" ? (sync.kind === "publish"
      ? ["This branch isn't on origin yet", `Publish it with ${plural(up, "commit")}.`]
      : ["Committed, not pushed yet", `Push ${plural(up, "commit")} to origin.`])
    : step === "pr" ? ["Ready for a pull request", `${plural(shippedN, "commit")} on origin ${shippedN === 1 ? "isn't" : "aren't"} in ${base}.`]
    : step === "fix" && pr ? (pr.failed
      ? [`PR #${pr.number} has ${pr.failed === 1 ? "a failing check" : `${pr.failed} failing checks`}`,
        `${fails.slice(0, 2).join(", ") || plural(pr.failed, "check")} failed. Everything is pushed.`]
      : [`PR #${pr.number} has review comments`, `${pr.review?.by || "A reviewer"} asked for changes.`])
    : pr ? [`PR #${pr.number} is open`, `Into ${pr.base}.${pr.running ? ` ${plural(pr.running, "check")} running.` : pr.total ? " Checks passed." : ""}`]
    : sync.kind === "local" ? ["All committed", "This branch has no remote."]
    : sync.kind === "detached" ? ["Detached HEAD", "Check out a branch to commit and push."]
    : base ? [`All in ${base}`, "Nothing to commit or push."]
    : ["Everything is pushed", "Nothing to commit."];

  const mac: Stop = dirty ? { tone: "on", icon: "laptop", value: plural(dirty, "file") } : { tone: "ok", icon: "check", value: "clean" };
  const committed: Stop = up ? { tone: step === "push" ? "on" : "", icon: "up", value: `${up} to push` }
    : !remote ? { tone: "dim", icon: "up", value: sync.kind === "detached" ? "detached" : "no remote" }
    : { tone: "ok", icon: "check", value: "all pushed" };
  const origin: Stop = down ? { tone: "ask", icon: "down", value: `${down} new` }
    : step === "fix" && pr ? { tone: "ask", icon: "pr", value: pr.failed ? `PR · ${pr.failed} failed` : "PR · changes asked" }
    : pr ? { tone: "", icon: "pr", value: `PR #${pr.number}` }
    : step === "pr" ? { tone: "on", icon: "pr", value: "no PR yet" }
    : sync.kind === "publish" ? { tone: "dim", icon: "cloud", value: "not on origin yet" }
    : !remote ? { tone: "dim", icon: "cloud", value: "no remote" }
    : { tone: "dim", icon: "cloud", value: c.fresh || "on origin" };

  return { step, amber: step === "sync" || step === "fix", head, sub, stops: [mac, committed, origin] };
}
