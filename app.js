import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, onSnapshot, writeBatch, query
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  esc, sortLists, groupTasks, openCount, findListByName, parseAddParams,
  idsToDelete, toggleChanges, formatDue, firstLine,
  LIST_COLORS, ACCENT_KEYS, listLook, listStats, greeting, firstSymbol, agendaGroups, agendaCounts, googleCalendarUrl, canSee, canMakePrivate
} from "./logic.js";

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

/* ---------- Setup ---------- */

const configured =
  firebaseConfig.apiKey && !Object.values(firebaseConfig).some((v) => String(v).includes("PASTE_HERE"));

let auth = null;
let db = null;
if (configured) {
  const fb = initializeApp(firebaseConfig);
  auth = getAuth(fb);
  try {
    // Keeps a copy on the phone so the app opens and works offline.
    db = initializeFirestore(fb, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (err) {
    console.warn("Offline cache unavailable, using plain Firestore.", err);
    db = getFirestore(fb);
  }
}

// A link like  ?add=Milk&list=Grocery  (from an NFC tag) adds a task.
let pendingAdd = parseAddParams(location.search);
if (pendingAdd) history.replaceState(null, "", location.pathname + location.hash);

const state = {
  user: undefined, // undefined = still checking, null = signed out
  lists: [],      // lists this person can see (shared ones, plus their own private ones)
  tasks: [],
  listsReady: false,
  tasksReady: false,
  fatal: null,
  route: parseRoute(),
  composer: { mode: "task", parentId: null },
  showDone: {},
  enter: true,       // play the entrance animation on the next real render
  pop: null,         // id of the task whose checkbox just changed
  pendingListId: null,
  agendaDone: new Set() // tasks checked off while viewing Today / Next 7 days (kept visible until you leave)
};
let shellBuilt = false;
let unsubLists = null;
let unsubTasks = null;

/* ---------- Device settings (theme, sort) ---------- */

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
const getMode = () => (["auto", "light", "dark"].includes(lsGet("theme-mode")) ? lsGet("theme-mode") : "auto");
const getAccent = () => (ACCENT_KEYS.includes(lsGet("theme-accent")) ? lsGet("theme-accent") : "grape");

function applyTheme() {
  const [c1, c2] = LIST_COLORS[getAccent()];
  const root = document.documentElement;
  root.dataset.mode = getMode();
  root.style.setProperty("--accent", c1);
  root.style.setProperty("--accent2", c2);
  const meta = $("#themeColorMeta");
  if (meta) meta.setAttribute("content", c1);
}
applyTheme();

// Sort choice (added order vs due date) is remembered per list on this phone.
const getSort = (listId) => (lsGet("sort:" + listId) === "due" ? "due" : "added");
const setSort = (listId, mode) => lsSet("sort:" + listId, mode);

/* ---------- Routing ---------- */

function parseRoute() {
  const a = location.hash.match(/^#a=(today|week)$/);
  if (a) return { view: "agenda", tab: a[1], listId: null };
  const m = location.hash.match(/^#l=(.+)$/);
  return m ? { view: "list", listId: decodeURIComponent(m[1]) } : { view: "lists", listId: null };
}
function go(listId) {
  location.hash = listId ? "#l=" + encodeURIComponent(listId) : "";
}
window.addEventListener("hashchange", () => {
  const prevView = state.route.view;
  state.route = parseRoute();
  if (state.route.view === "agenda" && prevView !== "agenda") state.agendaDone.clear();
  state.composer = { mode: "task", parentId: null };
  state.enter = true;
  renderAll();
});

/* ---------- Small UI helpers ---------- */

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function handleError(err) {
  console.error(err);
  if (err && err.code === "permission-denied") {
    toast("Not allowed. Check the sign-in email matches your Firestore rules.", 5000);
  } else {
    toast((err && err.message) || "Something went wrong.", 4500);
  }
}

// Generic "ask, then resolve once" dialog helper used by every popup window.
function modal(dialog, { onOpen, setup }) {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups = [];
    const on = (el, ev, fn) => { el.addEventListener(ev, fn); cleanups.push(() => el.removeEventListener(ev, fn)); };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanups.forEach((c) => c());
      if (dialog.open) dialog.close();
      resolve(result);
    };
    on(dialog, "cancel", () => finish(null));
    on(dialog, "close", () => finish(null));
    setup({ on, finish });
    dialog.showModal();
    onOpen && onOpen();
  });
}

const dlg = $("#dialog");
const dlgForm = $("#dialogForm");
const dlgTitle = $("#dialogTitle");
const dlgMsg = $("#dialogMsg");
const dlgInput = $("#dialogInput");
const dlgOk = $("#dialogOk");
const dlgCancel = $("#dialogCancel");

// Confirm box. Resolves true if confirmed, null if cancelled.
function confirmBox(title, message, okLabel = "Delete") {
  dlgTitle.textContent = title;
  dlgMsg.textContent = message;
  dlgMsg.hidden = !message;
  dlgInput.hidden = true;
  dlgOk.textContent = okLabel;
  dlgOk.className = "btn-danger";
  return modal(dlg, {
    setup: ({ on, finish }) => {
      on(dlgForm, "submit", (e) => { e.preventDefault(); finish(true); });
      on(dlgCancel, "click", () => finish(null));
    }
  });
}

// Edit a task's text, due date and note. Resolves to { text, due, note } or null.
const detDlg = $("#detailDialog");
const detText = $("#detailText");
const detDue = $("#detailDue");
const detNote = $("#detailNote");

// Opens Google Calendar with this task pre-filled as an all-day event.
function openCalendar(fields, listId) {
  const list = state.lists.find((l) => l.id === listId);
  const url = googleCalendarUrl(fields, list ? list.name : "");
  if (!url) return false;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

function openDetails(task) {
  detText.value = task.text;
  detDue.value = task.due || "";
  detNote.value = task.note || "";
  return modal(detDlg, {
    onOpen: () => detDlg.focus(), // don't pop the phone keyboard open until a field is tapped
    setup: ({ on, finish }) => {
      on($("#detailForm"), "submit", (e) => {
        e.preventDefault();
        const text = detText.value.trim();
        if (!text) { detText.focus(); return; }
        finish({ text, due: detDue.value || null, note: detNote.value.trim() });
      });
      on($("#detailCancel"), "click", () => finish(null));
      on($("#detailClearDue"), "click", () => { detDue.value = ""; });
      on($("#detailCal"), "click", () => {
        const fields = { text: detText.value.trim() || task.text, due: detDue.value, note: detNote.value };
        if (!openCalendar(fields, task.listId)) {
          // No date yet: take her to the date field instead of failing silently.
          detDue.focus();
          if (detDue.showPicker) { try { detDue.showPicker(); } catch { /* needs a tap on some browsers */ } }
        }
      });
    }
  });
}

async function editDetails(task) {
  const r = await openDetails(task);
  if (!r) return;
  const changes = {};
  if (r.text !== task.text) changes.text = r.text;
  if (r.due !== (task.due || null)) changes.due = r.due;
  if (r.note !== (task.note || "")) changes.note = r.note;
  if (Object.keys(changes).length) updateTask(task.id, changes);
}

// Create or edit a list: name, icon and color. Resolves to { name, emoji, color } or null.
const listDlg = $("#listDialog");
const listName = $("#listName");
const listEmoji = $("#listEmoji");
const EMOJIS = ["🛒", "🏠", "🧹", "🐱", "📚", "✈️", "🎁", "🍳", "💼", "💊", "🌿", "🎬", "🧾", "🐶", "🛠️", "🎉"];

function openListEditor({ title, list }) {
  const keys = Object.keys(LIST_COLORS);
  let color = list ? listLook(list).key : keys[state.lists.length % keys.length];
  let priv = !!(list && list.private);
  const me = state.user && state.user.email;
  const lockedShared = !!list && !list.private && !canMakePrivate(list, me); // someone else's shared list
  $("#listDialogTitle").textContent = title;
  listName.value = list ? list.name : "";
  listEmoji.value = list && list.emoji ? list.emoji : "";
  listEmoji.placeholder = "📋 Type or pick an emoji";
  $("#listSave").textContent = list ? "Save" : "Create";
  $("#emojiPicks").innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}" aria-label="Use ${e}">${e}</button>`).join("");
  const drawColors = () => {
    $("#colorPicks").innerHTML = keys
      .map((k) => `<button type="button" data-color="${k}" aria-label="${k}" aria-pressed="${k === color}"
        style="--s1:${LIST_COLORS[k][0]};--s2:${LIST_COLORS[k][1]}"></button>`)
      .join("");
  };
  drawColors();
  const drawVis = () => {
    $("#visPicks").innerHTML = [[false, "Shared"], [true, "Only me"]]
      .map(([val, label]) => `<button type="button" data-priv="${val}" aria-pressed="${priv === val}" ${val && lockedShared ? "disabled" : ""}>${val ? "🔒 " : "👥 "}${label}</button>`)
      .join("");
    $("#visHint").textContent = lockedShared
      ? "Only the person who created this list can make it private."
      : priv
        ? "Hidden from the other person's app, including their Today and week views."
        : "Both of you can see and edit this list.";
  };
  drawVis();
  return modal(listDlg, {
    onOpen: () => { if (list) listDlg.focus(); else listName.focus(); },
    setup: ({ on, finish }) => {
      on($("#emojiPicks"), "click", (e) => {
        const b = e.target.closest("[data-emoji]");
        if (b) listEmoji.value = b.dataset.emoji;
      });
      on($("#colorPicks"), "click", (e) => {
        const b = e.target.closest("[data-color]");
        if (b) { color = b.dataset.color; drawColors(); }
      });
      on($("#visPicks"), "click", (e) => {
        const b = e.target.closest("[data-priv]");
        if (b && !b.disabled) { priv = b.dataset.priv === "true"; drawVis(); }
      });
      on($("#listForm"), "submit", (e) => {
        e.preventDefault();
        const name = listName.value.trim();
        if (!name) { listName.focus(); return; }
        finish({ name, emoji: firstSymbol(listEmoji.value), color, private: priv });
      });
      on($("#listCancel"), "click", () => finish(null));
    }
  });
}

// Appearance window: light/dark and accent color. Applies instantly.
const themeDlg = $("#themeDialog");
function openThemeDialog() {
  const body = $("#themeBody");
  const draw = () => {
    const mode = getMode();
    const accent = getAccent();
    body.innerHTML = `<h2>Appearance</h2>
      <div class="field"><span class="field-label">Mode</span>
        <div class="segmented">${["auto", "light", "dark"]
          .map((m) => `<button type="button" data-mode="${m}" aria-pressed="${m === mode}">${m[0].toUpperCase() + m.slice(1)}</button>`)
          .join("")}</div></div>
      <div class="field"><span class="field-label">Accent color</span>
        <div class="color-picks">${ACCENT_KEYS
          .map((k) => `<button type="button" data-accent="${k}" aria-label="${k}" aria-pressed="${k === accent}"
            style="--s1:${LIST_COLORS[k][0]};--s2:${LIST_COLORS[k][1]}"></button>`)
          .join("")}</div></div>
      <div class="dialog-buttons"><button type="button" class="btn-primary" data-done>Done</button></div>`;
  };
  draw();
  themeDlg.onclick = (e) => {
    if (e.target === themeDlg) { themeDlg.close(); return; }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mode) { lsSet("theme-mode", b.dataset.mode); applyTheme(); draw(); }
    else if (b.dataset.accent) { lsSet("theme-accent", b.dataset.accent); applyTheme(); draw(); }
    else if (b.hasAttribute("data-done")) themeDlg.close();
  };
  themeDlg.showModal();
  themeDlg.focus();
}

const sheet = $("#sheet");
const sheetBody = $("#sheetBody");
function openSheet(title, items) {
  sheetBody.innerHTML =
    `<div class="sheet-title">${esc(title)}</div>` +
    items
      .map((it, i) => `<button class="sheet-btn ${it.danger ? "danger" : ""}" data-i="${i}">${esc(it.label)}</button>`)
      .join("");
  sheet.onclick = (e) => {
    if (e.target === sheet) { sheet.close(); return; }
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const item = items[Number(b.dataset.i)];
    sheet.close();
    item.run();
  };
  sheet.showModal();
  sheet.focus();
}

// A little celebration when the last task in a list is checked off.
function confetti() {
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = document.createElement("canvas");
  cv.className = "confetti";
  document.body.appendChild(cv);
  const dpr = window.devicePixelRatio || 1;
  const w = (cv.width = Math.floor(innerWidth * dpr));
  const h = (cv.height = Math.floor(innerHeight * dpr));
  const ctx = cv.getContext("2d");
  const colors = ["#7c4dff", "#ff5fa2", "#ffb020", "#22d3ee", "#34d399", "#ff7a59"];
  const bits = Array.from({ length: 120 }, () => ({
    x: w / 2, y: h * 0.7,
    vx: (Math.random() - 0.5) * 15 * dpr, vy: (-Math.random() * 17 - 8) * dpr,
    s: (Math.random() * 6 + 5) * dpr, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
    c: colors[Math.floor(Math.random() * colors.length)]
  }));
  const t0 = performance.now();
  const life = 2300;
  (function frame(t) {
    const el = t - t0;
    ctx.clearRect(0, 0, w, h);
    for (const p of bits) {
      p.vy += 0.5 * dpr; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - el / life);
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    if (el < life) requestAnimationFrame(frame); else cv.remove();
  })(t0);
}

/* ---------- Data listeners ---------- */

function startListeners() {
  stopListeners();
  unsubLists = onSnapshot(
    query(collection(db, "lists")),
    (snap) => {
      const me = state.user && state.user.email;
      state.lists = sortLists(snap.docs.map((d) => ({ id: d.id, ...d.data() }))).filter((l) => canSee(l, me));
      state.listsReady = true;
      state.fatal = null;
      processPendingAdd(snap.metadata.fromCache);
      renderHeader();
      renderContent();
    },
    onListenError
  );
  unsubTasks = onSnapshot(
    query(collection(db, "tasks")),
    (snap) => {
      state.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.tasksReady = true;
      renderHeader();
      renderContent();
    },
    onListenError
  );
}
function stopListeners() {
  if (unsubLists) unsubLists();
  if (unsubTasks) unsubTasks();
  unsubLists = unsubTasks = null;
}
function onListenError(err) {
  console.error(err);
  state.fatal =
    err.code === "permission-denied"
      ? "Signed in, but this account isn't allowed to read the lists. Check the email addresses in your Firestore rules."
      : err.message || "Could not load your lists.";
  renderContent();
}

function processPendingAdd(fromCache) {
  if (!pendingAdd) return;
  const { item, list } = pendingAdd;
  let target = list ? findListByName(state.lists, list) : state.lists.length === 1 ? state.lists[0] : null;
  // The first snapshot can come from the phone's cache; wait for server data before giving up.
  if (!target && fromCache && navigator.onLine) return;
  pendingAdd = null;
  if (!target) {
    toast(list ? `No list named “${list}”` : "Add &list=ListName to the link so I know where it goes.", 5000);
    return;
  }
  addTask(target.id, item, null);
  toast(`Added “${item}” to ${target.name}`);
}

/* ---------- Data actions (writes are not awaited, so the UI stays instant offline) ---------- */

function addList({ name, emoji, color, private: isPrivate }) {
  const ref = doc(collection(db, "lists"));
  setDoc(ref, { name, emoji, color, private: !!isPrivate, order: Date.now(), createdBy: state.user.email }).catch(handleError);
  return ref.id;
}
function updateList(id, fields) {
  updateDoc(doc(db, "lists", id), fields).catch(handleError);
}
function commitDeletes(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    batch.commit().catch(handleError);
  }
}
function deleteList(id) {
  const refs = state.tasks.filter((t) => t.listId === id).map((t) => doc(db, "tasks", t.id));
  refs.push(doc(db, "lists", id));
  commitDeletes(refs);
}
function addTask(listId, text, parentId) {
  const ref = doc(collection(db, "tasks"));
  const now = Date.now();
  setDoc(ref, {
    listId, parentId: parentId || null, text, done: false, order: now, createdAt: now, doneAt: null,
    createdBy: state.user.email
  }).catch(handleError);
}
function toggleTask(id) {
  const changes = toggleChanges(state.tasks, id);
  if (!changes.length) return;
  const t = state.tasks.find((x) => x.id === id);
  if (t && !t.done) {
    state.pop = id;
    if (navigator.vibrate) navigator.vibrate(8);
    if (state.route.view === "list" && !t.parentId && openCount(state.tasks, t.listId) === 1) confetti();
    if (state.route.view === "agenda") changes.forEach((c) => c.done && state.agendaDone.add(c.id));
  }
  const batch = writeBatch(db);
  for (const c of changes) batch.update(doc(db, "tasks", c.id), { done: c.done, doneAt: c.doneAt });
  batch.commit().catch(handleError);
}
function updateTask(id, fields) {
  updateDoc(doc(db, "tasks", id), fields).catch(handleError);
}
function deleteTask(id) {
  commitDeletes(idsToDelete(state.tasks, id).map((tid) => doc(db, "tasks", tid)));
}
function clearCompleted(listId) {
  commitDeletes(
    state.tasks.filter((t) => t.listId === listId && t.done).map((t) => doc(db, "tasks", t.id))
  );
}

/* ---------- Rendering ---------- */

function renderAll() {
  if (!configured) return renderConfigMissing();
  if (state.user === undefined) {
    shellBuilt = false;
    app.innerHTML = '<div class="empty"><span class="big">✅</span>Loading…</div>';
    return;
  }
  if (state.user === null) return renderAuth();
  if (!shellBuilt) {
    app.innerHTML = '<header id="hdr"></header><main id="content"></main><footer id="composer"></footer>';
    shellBuilt = true;
  }
  renderHeader();
  renderContent();
  renderComposer();
}

function renderConfigMissing() {
  shellBuilt = false;
  app.innerHTML = `<div class="setup-note">
    <h1>Almost there</h1>
    <p>The app isn't connected to Firebase yet. Open <code>firebase-config.js</code>,
    paste in your Firebase settings (SETUP.md, step 3), and upload it again.</p></div>`;
}

function renderAuth() {
  shellBuilt = false;
  app.style.removeProperty("--c1");
  app.style.removeProperty("--c2");
  app.innerHTML = `<form class="auth" id="authForm">
    <div class="logo">✓</div>
    <h1>Our Lists</h1>
    <p>Sign in to see your shared lists.</p>
    <input id="authEmail" type="email" placeholder="Email" autocomplete="username" autocapitalize="none" required>
    <input id="authPass" type="password" placeholder="Password" autocomplete="current-password" required>
    <p class="msg" id="authMsg"></p>
    <button class="btn-primary" id="authBtn" type="submit">Sign in</button>
  </form>`;
}

function authMessage(err) {
  switch (err && err.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "That email or password isn't right.";
    case "auth/too-many-requests":
      return "Too many tries. Wait a minute and try again.";
    case "auth/network-request-failed":
      return "No connection. Try again when you're online.";
    case "auth/operation-not-allowed":
      return "Email/password sign-in isn't turned on in Firebase yet.";
    default:
      return (err && err.message) || "Couldn't sign in.";
  }
}

function currentList() {
  return state.lists.find((l) => l.id === state.route.listId) || null;
}

function renderHeader() {
  const h = $("#hdr");
  if (!h) return;
  const offline = navigator.onLine ? "" : '<span class="chip">Offline</span>';

  if (state.route.view === "agenda") {
    app.style.removeProperty("--c1");
    app.style.removeProperty("--c2");
    const tab = state.route.tab;
    let sub = "";
    if (state.listsReady && state.tasksReady) {
      const c = agendaCounts(state.tasks, state.lists);
      const n = tab === "today" ? c.today : c.week;
      const what = tab === "today" ? "due today" : "due this week";
      sub = n ? `${n} ${what}` : "Nothing due";
      if (c.overdue) sub += ` · ${c.overdue} overdue`;
    }
    h.innerHTML = `<div class="banner">
      <div class="banner-top">
        <button class="icon-btn light back-btn" data-action="back" aria-label="Back to lists">‹ Lists</button>
        <span class="spacer"></span>${offline ? offline.replace("chip", "chip light") : ""}
      </div>
      <div class="banner-title"><span class="big-emoji">${tab === "today" ? "☀️" : "📅"}</span><h1>${tab === "today" ? "Today" : "Next 7 days"}</h1></div>
      <div class="banner-sub">${esc(sub)}</div>
      <div class="segmented on-banner">
        <button type="button" data-action="agendaTab" data-tab="today" aria-pressed="${tab === "today"}">Today</button>
        <button type="button" data-action="agendaTab" data-tab="week" aria-pressed="${tab === "week"}">Next 7 days</button>
      </div>
    </div>`;
    return;
  }

  if (state.route.view === "lists") {
    app.style.removeProperty("--c1");
    app.style.removeProperty("--c2");
    let stats = "";
    if (state.listsReady && state.tasksReady) {
      let open = 0, overdue = 0;
      for (const l of state.lists) {
        const s = listStats(state.tasks, l.id);
        open += s.open;
        overdue += s.overdue;
      }
      stats = open ? ` · <b>${open}</b> to do` : " · All clear";
      if (overdue) stats += ` · <span class="warn">${overdue} overdue</span>`;
    }
    const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const initial = esc(((state.user && state.user.email) || "?").charAt(0).toUpperCase());
    h.innerHTML = `<div class="hero">
      <div class="hero-text"><div class="greet">${greeting()}</div><div class="hero-sub">${esc(date)}${stats}</div></div>
      ${offline}
      <button class="avatar" data-action="account" aria-label="Account and appearance">${initial}</button>
    </div>`;
    return;
  }

  const list = currentList();
  if (list) {
    const look = listLook(list);
    app.style.setProperty("--c1", look.c1);
    app.style.setProperty("--c2", look.c2);
    const s = listStats(state.tasks, list.id);
    const sub = !s.total ? "Nothing here yet" : `${s.open} to do${s.done ? ` · ${s.done} done` : ""}`;
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    h.innerHTML = `<div class="banner">
      <div class="banner-top">
        <button class="icon-btn light back-btn" data-action="back" aria-label="Back to lists">‹ Lists</button>
        <span class="spacer"></span>${list.private ? '<span class="chip light">🔒 Only you</span>' : ""}${offline ? offline.replace("chip", "chip light") : ""}
        <button class="icon-btn light" data-action="listMenu" aria-label="List options">⋯</button>
      </div>
      <div class="banner-title"><span class="big-emoji">${esc(look.emoji)}</span><h1>${esc(list.name)}</h1></div>
      <div class="banner-sub">${esc(sub)}</div>
      <div class="progress"><span style="width:${pct}%"></span></div>
    </div>`;
  } else {
    h.innerHTML = `<div class="banner"><div class="banner-top">
      <button class="icon-btn light back-btn" data-action="back">‹ Lists</button></div></div>`;
  }
}

function rowHtml(t, isSub, opts = {}) {
  const cls = isSub ? "sub" : "task";
  const due = t.due && !opts.hideDue ? formatDue(t.due) : null;
  const meta = [];
  if (opts.extra) meta.push(opts.extra);
  if (due) meta.push(`<span class="due ${t.done ? "later" : due.status}">${esc(due.label)}</span>`);
  if (t.note) meta.push(`<span class="note-preview">${esc(firstLine(t.note))}</span>`);
  return `<div class="${cls} ${t.done ? "is-done" : ""}">
    <button class="check" data-action="toggle" data-id="${t.id}" aria-label="${t.done ? "Mark not done" : "Mark done"}"><span class="${state.pop === t.id ? "pop" : ""}">✓</span></button>
    <div class="task-text" data-action="details" data-id="${t.id}">
      <div>${esc(t.text)}</div>${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
    </div>`;
}

function agendaItemHtml({ task: t, list, parent }, i, hideDue) {
  const look = listLook(list);
  const chip = `<span class="list-chip">${esc(look.emoji)} ${esc(list.name)}</span>`;
  const via = parent ? `<span class="note-preview">↳ ${esc(parent.text)}</span>` : "";
  return `<li class="task-block" style="--c1:${look.c1};--c2:${look.c2};--i:${Math.min(i, 12)}">${rowHtml(t, false, { hideDue, extra: chip + via })}
      <button class="more" data-action="taskMenu" data-id="${t.id}" aria-label="More options">⋯</button></div></li>`;
}

function blockHtml(g, i) {
  const t = g.task;
  const counter = g.subsTotal
    ? `<span class="sub-count">${g.subsTotal - g.subsOpen}/${g.subsTotal}</span>`
    : "";
  const subs = g.subs
    .map(
      (s) => `<li>${rowHtml(s, true)}
        <button class="more" data-action="taskMenu" data-id="${s.id}" aria-label="More options">⋯</button></div></li>`
    )
    .join("");
  return `<li class="task-block" style="--i:${Math.min(i, 12)}">${rowHtml(t, false)}${counter}
      <button class="more" data-action="taskMenu" data-id="${t.id}" aria-label="More options">⋯</button></div>
      ${subs ? `<ul class="subs">${subs}</ul>` : ""}</li>`;
}

function renderContent() {
  const c = $("#content");
  if (!c) return;
  if (state.fatal) {
    c.innerHTML = `<div class="error-box">${esc(state.fatal)}</div>`;
    return;
  }
  if (!state.listsReady || !state.tasksReady) {
    c.innerHTML = '<div class="empty"><span class="big">✅</span>Loading…</div>';
    return;
  }

  if (state.route.view === "agenda") {
    const enter = state.enter;
    state.enter = false;
    const groups = agendaGroups(state.tasks, state.lists, new Date(), state.route.tab, state.agendaDone);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (!total && state.route.tab === "today") {
      c.innerHTML = '<div class="empty"><span class="big">🎉</span>Nothing due today.<br>Enjoy the breathing room.</div>';
      return;
    }
    let i = 0;
    c.innerHTML = `<div class="agenda ${enter ? "enter" : ""}">${groups
      .map(
        (g) => `<section class="agenda-day ${g.status}">
          <div class="agenda-head"><span class="day-name">${esc(g.label)}</span>${g.date ? `<span class="day-date">${esc(g.date)}</span>` : ""}${g.items.length ? `<span class="day-count">${g.items.length}</span>` : ""}</div>
          ${g.items.length
            ? `<ul class="tasks">${g.items.map((it) => agendaItemHtml(it, i++, g.status !== "overdue")).join("")}</ul>`
            : '<div class="day-empty">Nothing due</div>'}
        </section>`
      )
      .join("")}</div>`;
    state.pop = null;
    return;
  }

  if (state.route.view === "lists") {
    if (!state.lists.length) {
      c.innerHTML = '<div class="empty"><span class="big">🗒️</span>No lists yet.<br>Tap “New list” to start one.</div>';
      return;
    }
    const enter = state.enter;
    state.enter = false;
    const ac = agendaCounts(state.tasks, state.lists);
    const smart = `<div class="smart ${enter ? "enter" : ""}">
      <button class="smart-card" data-action="openAgenda" data-tab="today" style="--c1:#ff7a59;--c2:#ff3d81">
        <span class="smart-icon">☀️</span><span class="smart-count">${ac.today}</span>
        <span class="smart-label">Due today</span>
        ${ac.overdue ? `<span class="smart-warn">${ac.overdue} overdue</span>` : ""}</button>
      <button class="smart-card" data-action="openAgenda" data-tab="week" style="--c1:#0ea5e9;--c2:#6366f1">
        <span class="smart-icon">📅</span><span class="smart-count">${ac.week}</span>
        <span class="smart-label">Next 7 days</span></button>
    </div>`;
    c.innerHTML = `${smart}<div class="tiles ${enter ? "enter" : ""}">${state.lists
      .map((l, i) => {
        const look = listLook(l);
        const s = listStats(state.tasks, l.id);
        const meta = (l.private ? "🔒 " : "") + (!s.total ? "Empty" : s.open ? `${s.open} to do` : "All done ✓");
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        return `<button class="tile" style="--c1:${look.c1};--c2:${look.c2};--i:${Math.min(i, 12)}" data-action="openList" data-id="${l.id}">
          ${s.overdue ? `<span class="tile-badge">${s.overdue} overdue</span>` : ""}
          <span class="tile-emoji">${esc(look.emoji)}</span>
          <span class="tile-name">${esc(l.name)}</span>
          <span class="tile-meta">${meta}</span>
          <span class="progress"><span style="width:${pct}%"></span></span></button>`;
      })
      .join("")}</div>`;
    return;
  }

  const list = currentList();
  if (!list) {
    if (state.pendingListId === state.route.listId) {
      c.innerHTML = '<div class="empty"><span class="big">✅</span>Loading…</div>';
      return;
    }
    toast("That list no longer exists.");
    go(null);
    return;
  }
  if (state.pendingListId === list.id) state.pendingListId = null;

  const { open, done } = groupTasks(state.tasks, list.id, getSort(list.id));
  const enter = state.enter;
  state.enter = false;
  let html = "";
  if (!open.length && !done.length) {
    html = `<div class="empty"><span class="big">${esc(listLook(list).emoji)}</span>Nothing here yet.<br>Add your first task below.</div>`;
  } else {
    if (open.length) html += `<ul class="tasks ${enter ? "enter" : ""}">${open.map(blockHtml).join("")}</ul>`;
    else html += '<div class="empty"><span class="big">🎉</span>All done!</div>';
    if (done.length) {
      const show = !!state.showDone[list.id];
      html += `<button class="section-toggle" data-action="toggleDone">${show ? "▾" : "▸"} Completed (${done.length})</button>`;
      if (show) html += `<ul class="tasks">${done.map(blockHtml).join("")}</ul>`;
    }
  }
  c.innerHTML = html;
  state.pop = null;
}

function renderComposer() {
  const c = $("#composer");
  if (!c) return;
  c.hidden = state.route.view === "agenda";
  if (state.route.view === "agenda") { c.innerHTML = ""; return; }
  if (state.route.view === "lists") {
    c.innerHTML = '<button class="btn-primary btn-block" data-action="newList">＋ New list</button>';
    return;
  }
  const parent =
    state.composer.mode === "sub" ? state.tasks.find((t) => t.id === state.composer.parentId) : null;
  if (state.composer.mode === "sub" && !parent) state.composer = { mode: "task", parentId: null };
  c.innerHTML = `${
    parent
      ? `<div class="sub-mode">Subtask of <b>${esc(parent.text)}</b>
         <button type="button" data-action="cancelSub">Done</button></div>`
      : ""
  }<form class="composer-form" id="composerForm" autocomplete="off">
      <input id="composerInput" type="text" maxlength="200" enterkeyhint="done"
        autocapitalize="sentences" placeholder="${parent ? "Add a subtask" : "Add a task"}">
      <button class="btn-primary" type="submit">Add</button>
    </form>`;
  if (parent) $("#composerInput").focus();
}

/* ---------- Events ---------- */

app.addEventListener("submit", (e) => {
  if (e.target.id === "authForm") {
    e.preventDefault();
    const btn = $("#authBtn");
    const msg = $("#authMsg");
    btn.disabled = true;
    msg.textContent = "";
    signInWithEmailAndPassword(auth, $("#authEmail").value.trim(), $("#authPass").value)
      .catch((err) => {
        msg.textContent = authMessage(err);
        btn.disabled = false;
      });
    return;
  }
  if (e.target.id === "composerForm") {
    e.preventDefault();
    const input = $("#composerInput");
    const text = input.value.trim();
    if (!text) return;
    const listId = state.route.listId;
    if (state.composer.mode === "sub") {
      addTask(listId, text, state.composer.parentId);
    } else {
      addTask(listId, text, null);
    }
    input.value = "";
    input.focus();
  }
});

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const id = el.dataset.id;
  const task = id ? state.tasks.find((t) => t.id === id) : null;

  switch (el.dataset.action) {
    case "openList": go(id); break;
    case "openAgenda": location.hash = "#a=" + el.dataset.tab; break;
    case "agendaTab": location.replace("#a=" + el.dataset.tab); break;
    case "back": go(null); break;
    case "toggle": toggleTask(id); break;
    case "toggleDone": {
      const k = state.route.listId;
      state.showDone[k] = !state.showDone[k];
      renderContent();
      break;
    }
    case "newList": {
      const r = await openListEditor({ title: "New list" });
      if (r) {
        const newId = addList(r);
        state.pendingListId = newId; // so we don't mistake it for a deleted list while it syncs in
        go(newId);
      }
      break;
    }
    case "details": {
      if (!task) break;
      editDetails(task);
      break;
    }
    case "taskMenu": {
      if (!task) break;
      const items = [
        { label: "Edit details (due date, note)", run: () => editDetails(task) },
        {
          label: "Add to Google Calendar",
          run: () => {
            if (!openCalendar(task, task.listId)) toast("Add a due date first. Tap the task to set one.", 4000);
          }
        }
      ];
      if (state.route.view === "agenda") {
        items.push({ label: "Open list", run: () => go(task.listId) });
      }
      if (!task.parentId && state.route.view === "list") {
        items.push({
          label: "Add subtask",
          run: () => {
            state.composer = { mode: "sub", parentId: task.id };
            renderComposer();
          }
        });
      }
      items.push({
        label: "Delete",
        danger: true,
        run: async () => {
          const extra = state.tasks.filter((t) => t.parentId === task.id).length;
          const ok = await confirmBox(
            "Delete this task?",
            extra ? `This also deletes its ${extra} subtask${extra > 1 ? "s" : ""}.` : "",
            "Delete"
          );
          if (ok) deleteTask(task.id);
        }
      });
      openSheet(task.text, items);
      break;
    }
    case "cancelSub":
      state.composer = { mode: "task", parentId: null };
      renderComposer();
      break;
    case "listMenu": {
      const list = currentList();
      if (!list) break;
      const doneCount = state.tasks.filter((t) => t.listId === list.id && t.done).length;
      const sortMode = getSort(list.id);
      const items = [
        {
          label: "Edit list (name, icon, color)",
          run: async () => {
            const r = await openListEditor({ title: "Edit list", list });
            if (!r) return;
            const changes = {};
            if (r.name !== list.name) changes.name = r.name;
            if (r.emoji !== (list.emoji || "")) changes.emoji = r.emoji;
            if (r.color !== list.color) changes.color = r.color;
            if (r.private !== !!list.private) {
              changes.private = r.private;
              if (r.private && !list.createdBy) changes.createdBy = state.user.email;
            }
            if (Object.keys(changes).length) updateList(list.id, changes);
          }
        },
        {
          label: sortMode === "due" ? "Sort by order added" : "Sort by due date",
          run: () => {
            setSort(list.id, sortMode === "due" ? "added" : "due");
            renderContent();
          }
        }
      ];
      if (doneCount) {
        items.push({
          label: `Clear completed (${doneCount})`,
          run: async () => {
            const ok = await confirmBox("Clear completed tasks?", `${doneCount} finished item${doneCount > 1 ? "s" : ""} will be deleted.`, "Clear");
            if (ok) clearCompleted(list.id);
          }
        });
      }
      items.push({
        label: "Delete list",
        danger: true,
        run: async () => {
          const n = state.tasks.filter((t) => t.listId === list.id).length;
          const ok = await confirmBox(
            `Delete “${list.name}”?`,
            n ? `This deletes the list and its ${n} item${n > 1 ? "s" : ""} for both of you.` : "",
            "Delete"
          );
          if (ok) { deleteList(list.id); go(null); }
        }
      });
      openSheet(`${listLook(list).emoji} ${list.name}`, items);
      break;
    }
    case "account":
      openSheet(`Signed in as ${state.user.email}`, [
        { label: "Appearance (light, dark, color)", run: openThemeDialog },
        { label: "Sign out", danger: true, run: () => signOut(auth).catch(handleError) }
      ]);
      break;
  }
});

window.addEventListener("online", renderHeader);
window.addEventListener("offline", renderHeader);

/* ---------- Start ---------- */

if (configured) {
  onAuthStateChanged(auth, (user) => {
    state.user = user;
    if (user) {
      state.enter = true;
      startListeners();
    } else {
      stopListeners();
      state.lists = [];
      state.tasks = [];
      state.listsReady = state.tasksReady = false;
      state.fatal = null;
    }
    renderAll();
  });
}
renderAll();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker failed", err));
  });
}
