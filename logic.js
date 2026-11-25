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

// Splits one list's tasks into open and completed top-level tasks,
// each with its subtasks attached (open subtasks first, finished ones last).
export function groupTasks(tasks, listId) {
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
  const open = top.filter((t) => !t.done).sort(byOrder).map(withSubs);
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
