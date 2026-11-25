// Pure helper functions (no Firebase, no DOM) so they are easy to test.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

export function sortLists(lists) {
  return [...lists].sort((a, b) => byOrder(a, b) || String(a.name).localeCompare(String(b.name)));
}

// Turns a due date string like "2026-12-05" into a short label and a status
// ("overdue", "today", "soon", "later") for display.
export function formatDue(due, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due || "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((d - today) / 86400000);
  const short = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {})
  });
  if (diff < 0) return { label: diff === -1 ? "Yesterday" : short, status: "overdue", diff };
  if (diff === 0) return { label: "Today", status: "today", diff };
  if (diff === 1) return { label: "Tomorrow", status: "soon", diff };
  if (diff < 7) return { label: d.toLocaleDateString("en-US", { weekday: "long" }), status: "soon", diff };
  return { label: short, status: "later", diff };
}

// First non-empty line of a note, for the preview under a task.
export function firstLine(note) {
  return String(note ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
}

// Splits one list's tasks into open and completed top-level tasks,
// each with its subtasks attached (open subtasks first, finished ones last).
// sortMode "due" puts the soonest due date first (no date goes last);
// anything else keeps the order tasks were added.
export function groupTasks(tasks, listId, sortMode = "added") {
  const inList = tasks.filter((t) => t.listId === listId);
  const top = inList.filter((t) => !t.parentId);
  const subsByParent = new Map();
  for (const t of inList) {
    if (!t.parentId) continue;
    if (!subsByParent.has(t.parentId)) subsByParent.set(t.parentId, []);
    subsByParent.get(t.parentId).push(t);
  }
  const withSubs = (task) => {
    const subs = (subsByParent.get(task.id) || []).sort(byOrder);
    return {
      task,
      subs: [...subs.filter((s) => !s.done), ...subs.filter((s) => s.done)],
      subsOpen: subs.filter((s) => !s.done).length,
      subsTotal: subs.length
    };
  };
  const dueKey = (t) => t.due || "9999-12-31";
  const cmp = sortMode === "due"
    ? (a, b) => dueKey(a).localeCompare(dueKey(b)) || byOrder(a, b)
    : byOrder;
  const open = top.filter((t) => !t.done).sort(cmp).map(withSubs);
  const done = top
    .filter((t) => t.done)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    .map(withSubs);
  return { open, done };
}

// Number of unfinished top-level tasks in a list.
export function openCount(tasks, listId) {
  return tasks.filter((t) => t.listId === listId && !t.parentId && !t.done).length;
}

export function findListByName(lists, name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return lists.find((l) => String(l.name).trim().toLowerCase() === wanted) || null;
}

// Reads ?add=Milk&list=Grocery (used by NFC tags and shortcuts).
export function parseAddParams(search) {
  const p = new URLSearchParams(search || "");
  const item = (p.get("add") || "").trim();
  if (!item) return null;
  return { item: item.slice(0, 200), list: (p.get("list") || "").trim() };
}

// All task ids that must be deleted along with the given task
// (the task itself plus its subtasks).
export function idsToDelete(tasks, taskId) {
  return tasks.filter((t) => t.id === taskId || t.parentId === taskId).map((t) => t.id);
}

// Figures out which writes a checkbox tap should make.
// Returns an array of { id, done, doneAt }.
export function toggleChanges(tasks, taskId, now = Date.now()) {
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return [];
  const done = !t.done;
  const changes = [{ id: t.id, done, doneAt: done ? now : null }];
  if (!t.parentId && done) {
    // Finishing a task finishes its open subtasks too.
    for (const s of tasks) {
      if (s.parentId === t.id && !s.done) changes.push({ id: s.id, done: true, doneAt: now });
    }
  }
  if (t.parentId && !done) {
    // Re-opening a subtask re-opens a finished parent.
    const parent = tasks.find((x) => x.id === t.parentId);
    if (parent && parent.done) changes.push({ id: parent.id, done: false, doneAt: null });
  }
  return changes;
}
