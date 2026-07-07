import { useState, useEffect } from "react";
import { projectTint } from "../../lib/surfaces";

export type TaskQueuePanelProps = {
  projects: string[];
  onFeed: (texts: string[]) => void;
};

type Task = {
  id: string;
  text: string;
  project: string;
  done: boolean;
  sent: boolean;
};

const STORAGE_KEY = "hud-tasks";

function loadTasks(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Task[];
  } catch {
    return [];
  }
}

export function TaskQueuePanel(props: TaskQueuePanelProps) {
  const { projects, onFeed } = props;
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks());
  const [newTask, setNewTask] = useState("");
  const [newProject, setNewProject] = useState<string>(projects[0] ?? "");
  const [feedAllHover, setFeedAllHover] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      /* ignore */
    }
  }, [tasks]);

  // If projects load in after mount and the new-task project is unset, adopt
  // the first project so the cycle tag has a value.
  useEffect(() => {
    if (!newProject && projects.length) setNewProject(projects[0]);
  }, [projects, newProject]);

  const openCount = tasks.filter((t) => !t.done).length;

  function cycle(current: string): string {
    if (!projects.length) return "";
    const i = projects.indexOf(current);
    return projects[(i + 1) % projects.length];
  }

  function toggleTask(id: string) {
    setTasks((s) => s.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  function cycleTaskProject(id: string) {
    setTasks((s) =>
      s.map((t) => (t.id === id ? { ...t, project: cycle(t.project) } : t)),
    );
  }

  function addTask() {
    const text = newTask.trim();
    if (!text) return;
    setTasks((s) => [
      ...s,
      { id: "t" + Date.now(), text, project: newProject, done: false, sent: false },
    ]);
    setNewTask("");
  }

  function feedTask(task: Task) {
    if (task.done || task.sent) return;
    setTasks((s) => s.map((t) => (t.id === task.id ? { ...t, sent: true } : t)));
    onFeed([task.text]);
  }

  function feedAll() {
    const open = tasks.filter((t) => !t.done && !t.sent);
    if (!open.length) return;
    setTasks((s) => s.map((t) => (!t.done && !t.sent ? { ...t, sent: true } : t)));
    onFeed(open.map((t) => t.text));
  }

  return (
    <div
      className="panel"
      style={{
        border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
        background: "color-mix(in srgb, var(--panel) 50%, transparent)",
        animation: "enterLeftUp .55s cubic-bezier(.2,.8,.2,1) both .3s",
        flex: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
        }}
      >
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "var(--txl)" }}>
          QUEUE
        </span>
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "var(--acc)" }}>
          TASK QUEUE
        </span>
      </div>
      <div
        style={{
          height: "1px",
          background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))",
          transformOrigin: "left",
          animation: "drawline .7s ease both .36s",
        }}
      />
      <div style={{ padding: "10px 12px 13px" }}>
        <div
          style={{
            fontSize: "9.5px",
            letterSpacing: "1px",
            color: "var(--txl)",
            padding: "0 2px 4px",
          }}
        >
          {openCount} OPEN · ASSIGN + FEED TO CLAUDE
        </div>

        {tasks.map((t, i) => {
          const tint = projectTint(t.project);
          const color = tint.color;
          const bd = tint.border;
          const textColor = t.done ? "var(--txl)" : "var(--txh)";
          const boxBg = t.done ? "var(--acc)" : "transparent";
          const boxBorder = t.done ? "var(--acc)" : "color-mix(in srgb, var(--acc) 35%, transparent)";
          const canFeed = !t.done && !t.sent;
          return (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "9px",
                padding: "9px 4px",
                borderBottom: "1px solid color-mix(in srgb, var(--acc) 6%, transparent)",
                animation: "mfadeup .35s ease both",
                animationDelay: i * 50 + "ms",
              }}
            >
              <button
                onClick={() => toggleTask(t.id)}
                title="toggle done"
                style={{
                  width: "15px",
                  height: "15px",
                  flex: "none",
                  marginTop: "1px",
                  cursor: "pointer",
                  border: `1px solid ${boxBorder}`,
                  background: boxBg,
                  color: "var(--acc-on)",
                  fontSize: "10px",
                  lineHeight: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  fontFamily: "inherit",
                }}
              >
                {t.done ? "✓" : ""}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "12px",
                    lineHeight: 1.4,
                    color: textColor,
                    textDecoration: t.done ? "line-through" : "none",
                  }}
                >
                  {t.text}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginTop: "6px",
                  }}
                >
                  {projects.length > 0 && (
                    <button
                      onClick={() => cycleTaskProject(t.id)}
                      title="reassign project"
                      style={{
                        appearance: "none",
                        cursor: "pointer",
                        border: `1px solid ${bd}`,
                        background: "transparent",
                        color: color,
                        fontFamily: "inherit",
                        fontSize: "8.5px",
                        letterSpacing: "1px",
                        padding: "2px 7px",
                        display: "flex",
                        alignItems: "center",
                        gap: "5px",
                      }}
                    >
                      <span
                        style={{
                          width: "5px",
                          height: "5px",
                          borderRadius: "50%",
                          background: color,
                        }}
                      />
                      {projectTint(t.project).tag}
                    </button>
                  )}
                  {t.sent && (
                    <span
                      style={{
                        fontSize: "8.5px",
                        letterSpacing: "1px",
                        color: "var(--ok)",
                      }}
                    >
                      QUEUED ▸ CLAUDE
                    </span>
                  )}
                </div>
              </div>
              {canFeed && (
                <button
                  onClick={() => feedTask(t)}
                  title="feed to Claude"
                  style={{
                    flex: "none",
                    appearance: "none",
                    cursor: "pointer",
                    border: "1px solid var(--acc)",
                    background: "color-mix(in srgb, var(--acc) 12%, transparent)",
                    color: "var(--txb)",
                    fontFamily: "inherit",
                    fontSize: "11px",
                    padding: "4px 9px",
                    marginTop: "1px",
                  }}
                >
                  ▸
                </button>
              )}
            </div>
          );
        })}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "7px",
            marginTop: "11px",
            border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)",
            background: "color-mix(in srgb, var(--panel2) 60%, transparent)",
            padding: "7px 8px",
          }}
        >
          {projects.length > 0 && (
            <button
              onClick={() => setNewProject(cycle(newProject))}
              title="assign project"
              style={{
                appearance: "none",
                cursor: "pointer",
                border: `1px solid ${projectTint(newProject).border}`,
                background: "transparent",
                color: projectTint(newProject).color,
                fontFamily: "inherit",
                fontSize: "8.5px",
                letterSpacing: "1px",
                padding: "3px 6px",
                flex: "none",
              }}
            >
              {projectTint(newProject).tag}
            </button>
          )}
          <input
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addTask();
            }}
            placeholder="add a task…"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: 0,
              outline: "none",
              color: "var(--txb)",
              fontFamily: "inherit",
              fontSize: "12px",
            }}
          />
          <button
            onClick={addTask}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: 0,
              background: "transparent",
              color: "var(--acc)",
              fontFamily: "inherit",
              fontSize: "10.5px",
              letterSpacing: "1px",
              padding: "0 3px",
              flex: "none",
            }}
          >
            ADD +
          </button>
        </div>
        <button
          onClick={feedAll}
          onMouseEnter={() => setFeedAllHover(true)}
          onMouseLeave={() => setFeedAllHover(false)}
          style={{
            width: "100%",
            appearance: "none",
            cursor: "pointer",
            border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
            background: feedAllHover ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "color-mix(in srgb, var(--acc) 6%, transparent)",
            color: "var(--tx)",
            fontFamily: "inherit",
            fontSize: "10px",
            letterSpacing: "2px",
            padding: "9px",
            marginTop: "9px",
          }}
        >
          FEED ALL OPEN TO CLAUDE →
        </button>
      </div>
    </div>
  );
}
