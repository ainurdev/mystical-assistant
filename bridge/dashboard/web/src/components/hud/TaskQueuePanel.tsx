import { useState, useEffect } from "react";

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

const PROJ_COLORS = [
  "#7fe9d8",
  "#b9a6ff",
  "#8fd9a8",
  "#6fb5ff",
  "#e3c279",
  "#ff7ad9",
];

/** basename of a project path (last path segment). */
function basename(name: string): string {
  const parts = name.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

/** stable djb2-ish hash → index into PROJ_COLORS. */
function projColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return PROJ_COLORS[Math.abs(h) % PROJ_COLORS.length];
}

/** 4-letter uppercase tag from the basename. */
function projTag(name: string): string {
  const base = basename(name).replace(/[^a-z0-9]/gi, "");
  return (base.slice(0, 4) || "proj").toUpperCase();
}

/** convert a hex color (#rrggbb) to an rgba() border string at the given alpha. */
function projBorder(color: string): string {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},.45)`;
}

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
        border: "1px solid rgba(127,233,216,.16)",
        background: "rgba(9,16,16,.5)",
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
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "#3c544f" }}>
          QUEUE
        </span>
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "#7fe9d8" }}>
          TASK QUEUE
        </span>
      </div>
      <div
        style={{
          height: "1px",
          background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))",
          transformOrigin: "left",
          animation: "drawline .7s ease both .36s",
        }}
      />
      <div style={{ padding: "10px 12px 13px" }}>
        <div
          style={{
            fontSize: "9.5px",
            letterSpacing: "1px",
            color: "#3c544f",
            padding: "0 2px 4px",
          }}
        >
          {openCount} OPEN · ASSIGN + FEED TO CLAUDE
        </div>

        {tasks.map((t, i) => {
          const color = projColor(t.project);
          const bd = projBorder(color);
          const textColor = t.done ? "#3c544f" : "#cfe9e3";
          const boxBg = t.done ? "#7fe9d8" : "transparent";
          const boxBorder = t.done ? "#7fe9d8" : "rgba(127,233,216,.35)";
          const canFeed = !t.done && !t.sent;
          return (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "9px",
                padding: "9px 4px",
                borderBottom: "1px solid rgba(127,233,216,.06)",
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
                  color: "#06100e",
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
                      {projTag(t.project)}
                    </button>
                  )}
                  {t.sent && (
                    <span
                      style={{
                        fontSize: "8.5px",
                        letterSpacing: "1px",
                        color: "#8fd9a8",
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
                    border: "1px solid #7fe9d8",
                    background: "rgba(127,233,216,.12)",
                    color: "#dff8f2",
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
            border: "1px solid rgba(127,233,216,.18)",
            background: "rgba(7,13,13,.6)",
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
                border: `1px solid ${projBorder(projColor(newProject))}`,
                background: "transparent",
                color: projColor(newProject),
                fontFamily: "inherit",
                fontSize: "8.5px",
                letterSpacing: "1px",
                padding: "3px 6px",
                flex: "none",
              }}
            >
              {projTag(newProject)}
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
              color: "#dff8f2",
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
              color: "#7fe9d8",
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
            border: "1px solid rgba(127,233,216,.3)",
            background: feedAllHover ? "rgba(127,233,216,.14)" : "rgba(127,233,216,.06)",
            color: "#bfe6de",
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
