import { useEffect, useRef, useState } from "react";
import { api, PUSHED_EVENT, type TaskState } from "../../api";
import { RivendellIcon } from "../../lib/rivendellicon";
import { hairline } from "../../lib/shell";
import { ContextMenu, menuH, type CtxItem } from "./ContextMenu";
import { notify } from "./Notifications";

/** The branch's Rivendell task (docs/superpowers/specs/rivendell-task-check.md):
 *  a tab beside the branch in the prompt box (TaskChip) and a line above PUBLISH
 *  in the GIT tab (TaskLine). NO TASK while there is work no task covers; the
 *  key once the branch carries one, or a create or a card answer recorded it;
 *  NOT A TASK once you said so. A linked task also names its board column as
 *  Rivendell has it (NRA-79 · In progress): its PR webhook moves the card as
 *  the PR opens and merges. The question itself waits for the push (the
 *  runner's note, held to it by bridge/taskcheck.py). This is where you see the
 *  state, and can answer before the push asks.
 *
 *  Polls like PrChip: on mount, every 60s while the tab is visible, on focus,
 *  after a dashboard push, and when a turn starts or ends (it may have answered
 *  the card, filed a task or renamed the branch). Every failure draws nothing:
 *  a bridge still on pre-restart code 404s the route. */

const POLL_MS = 60_000;
const LINK_NOW = "Link this work to a Rivendell task now: check the board, and ask me with the Task card instead of waiting for the push.";
const LOOK = {
  none: { mark: "var(--ask)", ink: "var(--txd)" },
  linked: { mark: "var(--acc)", ink: "var(--txb)" },
  skip: { mark: "var(--txl)", ink: "var(--txl)" },
} as const;
const label = (t: TaskState) => t.state === "linked" ? t.key : t.state === "skip" ? "NOT A TASK" : "NO TASK";
const open = (url: string | null) => { if (url) window.open(url, "_blank", "noopener"); };

function useTaskState(project: string | null, branch: string, busy = false) {
  const [task, setTask] = useState<TaskState | null>(null);
  const load = useRef(() => {});
  useEffect(() => {
    setTask(null);
    load.current = () => {};
    if (!project || !branch) return;
    let live = true;
    const get = () => {
      if (document.visibilityState !== "visible") return;
      api.taskState(project, branch)
        .then((r) => { if (live) setTask(r.task); })
        .catch(() => { /* a pre-restart bridge (404) or offline: no tab, never a toast */ });
    };
    const onVisible = () => { if (document.visibilityState === "visible") get(); };
    load.current = get;
    get();
    const id = window.setInterval(get, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(PUSHED_EVENT, get);
    return () => {
      live = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(PUSHED_EVENT, get);
    };
  }, [project, branch]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    load.current();
  }, [busy]);

  async function skip() {
    if (!project) return;
    const r = await api.taskSkip(project, branch)
      .catch((e: Error) => { notify("error", `Not a task wasn't saved: ${e.message}`); return null; });
    if (r) setTask(r.task);
  }
  return { task, skip };
}

/** The tab, after the branch in the prompt box's caption. A linked task opens
 *  in Rivendell; otherwise a menu: link one now, not a task, the board. */
export function TaskChip({ project, branch, busy, onSend }: {
  project: string;
  branch: string;
  /** A turn is running: when it flips, the state may have moved. */
  busy: boolean;
  onSend?: (text: string) => void;
}) {
  const { task, skip } = useTaskState(project, branch, busy);
  const [hov, setHov] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!task) return null;
  const look = LOOK[task.state];
  const items: CtxItem[] = [
    ...(onSend ? [{ icon: "▸", label: "Link a task now", hint: "Claude checks the board and asks you now, not at the push", onClick: () => onSend(LINK_NOW) }] : []),
    ...(task.state === "none" ? [{ icon: "⊘", label: "Not a task", hint: "pushes from this branch won't ask", onClick: () => void skip() }] : []),
    ...(task.board_url ? [{ divider: true }, { icon: "⇗", label: "Open the board", hint: task.board ?? undefined, onClick: () => open(task.board_url) }] : []),
  ];
  return (
    <>
      <span className="np-sep" style={hairline(9)} />
      <button
        className="np-task"
        title={task.state === "linked" ? `${task.key}${task.column ? ` · ${task.column}` : ""}${task.title ? ` · ${task.title}` : ""}: open in Rivendell`
          : task.state === "skip" ? "you said this work isn't a task" : "no Rivendell task for this work yet: the push asks"}
        onClick={(e) => {
          if (task.state === "linked") return open(task.url);
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.left, y: r.top - 6 - menuH(items, 44) });   // above: the tab sits at the screen's foot
        }}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", fontFamily: "var(--mono)", fontSize: "var(--t9)", letterSpacing: ".4px", padding: 0, border: 0, appearance: "none", background: "transparent", cursor: "pointer", color: hov ? "var(--txb)" : look.ink }}>
        <RivendellIcon size={11} strokeWidth={2.2} style={{ color: look.mark, flex: "none" }} />
        {label(task)}
        {task.state === "linked" && task.column && (
          <span style={{ color: "var(--txd)", maxWidth: "18ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {task.column}</span>
        )}
      </button>
      {at && (
        <ContextMenu ctx={{ x: at.x, y: at.y, type: "task", id: branch, label: `${task.state === "skip" ? "not a task" : "no task yet"}${task.board ? ` · ${task.board}` : ""}` }}
          items={items} onClose={() => setAt(null)} />
      )}
    </>
  );
}

/** The same state as one line of the GIT tab's readout, right above PUBLISH. */
export function TaskLine({ project, branch, onSend }: {
  project: string | null;
  branch: string;
  onSend?: (text: string) => void;
}) {
  const { task, skip } = useTaskState(project, branch);
  if (!task) return null;
  const link = onSend && <> · <button onClick={() => onSend(LINK_NOW)}>link one</button></>;
  return (
    <div className="gp-rosub gp-task">
      <RivendellIcon size={13} strokeWidth={2.2} style={{ color: LOOK[task.state].mark, flex: "none" }} />
      {task.state === "linked" ? (
        <button onClick={() => open(task.url)} title="open in Rivendell">
          <b className="ln">{task.key}</b>{task.column && <span className="col"> · {task.column}</span>} {task.title ?? "open in Rivendell"} ↗
        </button>
      ) : task.state === "skip" ? (
        <span><b className="skip">Not a task</b> for this branch{link}</span>
      ) : (
        <span><b>No task</b> for this branch{link} · <button onClick={() => void skip()}>not a task</button></span>
      )}
    </div>
  );
}
