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

/* ---------- Look and feel helpers ---------- */

export const LIST_COLORS = {
  grape:  ["#7c4dff", "#b06cff"],
  ocean:  ["#0ea5e9", "#6366f1"],
  sunset: ["#ff7a59", "#ff3d81"],
  mint:   ["#10b981", "#22d3ee"],
  berry:  ["#e83e8c", "#ff8ad8"],
  sun:    ["#f59e0b", "#ff7a3d"],
  forest: ["#16a34a", "#84cc16"],
  slate:  ["#475569", "#7c8aa5"]
};
export const ACCENT_KEYS = ["grape", "ocean", "sunset", "mint"];
export const DEFAULT_EMOJI = "📋";

function hashString(s) {
  let h = 0;
  for (const ch of String(s ?? "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// Colors and icon for a list. Lists without a chosen color get a stable one.
export function listLook(list) {
  const keys = Object.keys(LIST_COLORS);
  const key = list && LIST_COLORS[list.color] ? list.color : keys[hashString(list && list.id) % keys.length];
  const [c1, c2] = LIST_COLORS[key];
  return { key, c1, c2, emoji: (list && list.emoji) || DEFAULT_EMOJI };
}

export function dayString(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Counts for one list: unfinished and finished top-level tasks, and how many
// unfinished ones are overdue.
export function listStats(tasks, listId, now = new Date()) {
  const today = dayString(now);
  let open = 0, done = 0, overdue = 0;
  for (const t of tasks) {
    if (t.listId !== listId || t.parentId) continue;
    if (t.done) done++;
    else {
      open++;
      if (t.due && t.due < today) overdue++;
    }
  }
  return { open, done, overdue, total: open + done };
}

export function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// Keeps just the first emoji (or character) someone typed or pasted.
export function firstSymbol(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)[Symbol.iterator]().next();
    return first.done ? "" : first.value.segment;
  }
  return Array.from(s).slice(0, 2).join("");
}

/* ---------- Today / next 7 days ---------- */

function parseDay(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// Tasks with due dates from every list, grouped for the Today / Next 7 days screens.
// Overdue tasks come first, then one group per day (empty days are kept so the
// week reads like a calendar). tab "today" shows just today; anything else shows
// 7 days starting today. Finished tasks are hidden unless listed in keepIds
// (so a task you just checked off stays visible, crossed out, until you leave).
export function agendaGroups(tasks, lists, now = new Date(), tab = "week", keepIds = new Set()) {
  const todayStr = dayString(now);
  const listById = new Map(lists.map((l) => [l.id, l]));
  const listOrder = new Map(lists.map((l, i) => [l.id, i]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const items = [];
  for (const t of tasks) {
    if (!t.due || !parseDay(t.due)) continue;
    if (t.done && !keepIds.has(t.id)) continue;
    const list = listById.get(t.listId);
    if (!list) continue;
    const parent = t.parentId ? taskById.get(t.parentId) : null;
    if (t.parentId && !parent) continue;
    items.push({ task: t, list, parent });
  }
  const cmp = (a, b) =>
    (listOrder.get(a.list.id) - listOrder.get(b.list.id)) || ((a.task.order || 0) - (b.task.order || 0));

  const groups = [];
  const overdue = items
    .filter((i) => i.task.due < todayStr)
    .sort((a, b) => a.task.due.localeCompare(b.task.due) || cmp(a, b));
  if (overdue.length) groups.push({ key: "overdue", label: "Overdue", date: "", status: "overdue", items: overdue });

  const days = tab === "today" ? 1 : 7;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dayString(d);
    groups.push({
      key,
      label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "long" }),
      date: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
      status: i === 0 ? "today" : "day",
      items: items.filter((x) => x.task.due === key).sort(cmp)
    });
  }
  return groups;
}

// Numbers for the home screen cards and screen headers.
export function agendaCounts(tasks, lists, now = new Date()) {
  const sum = (groups) => groups.filter((g) => g.key !== "overdue").reduce((n, g) => n + g.items.length, 0);
  const week = agendaGroups(tasks, lists, now, "week");
  const overdueGroup = week.find((g) => g.key === "overdue");
  return {
    today: sum(agendaGroups(tasks, lists, now, "today")),
    week: sum(week),
    overdue: overdueGroup ? overdueGroup.items.length : 0
  };
}

/* ---------- Google Calendar export ---------- */

// Link that opens Google Calendar's "new event" screen, pre-filled as an
// all-day event on the task's due date. Returns null if there is no valid due date.
export function googleCalendarUrl({ text, due, note }, listName = "") {
  const start = parseDay(due);
  if (!start) return null;
  const end = new Date(start);
  end.setDate(start.getDate() + 1); // all-day events end on the following day
  const ymd = (d) => dayString(d).replace(/-/g, "");
  const details = [
    String(note ?? "").trim(),
    listName ? `From the list "${listName}" in Our Lists` : ""
  ].filter(Boolean).join("\n\n");
  let url =
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    "&text=" + encodeURIComponent(String(text || "Task").trim()) +
    "&dates=" + ymd(start) + "/" + ymd(end);
  if (details) url += "&details=" + encodeURIComponent(details);
  return url;
}

/* ---------- Shared / private lists ---------- */

// A private list is only visible to the person who created it.
export function canSee(list, email) {
  if (!list || !list.private) return true;
  return !!email && list.createdBy === email;
}

// Only the creator may make a shared list private, otherwise one person could
// hide the other's list from them. Lists with no recorded creator (made before
// this feature) can be claimed by whoever edits them.
export function canMakePrivate(list, email) {
  if (!list || !list.createdBy) return true;
  return list.createdBy === email;
}
