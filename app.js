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
  idsToDelete, toggleChanges
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
  lists: [],
  tasks: [],
  listsReady: false,
  tasksReady: false,
  fatal: null,
  route: parseRoute(),
  composer: { mode: "task", parentId: null },
  showDone: {}
};
let shellBuilt = false;
let unsubLists = null;
let unsubTasks = null;

/* ---------- Routing ---------- */

function parseRoute() {
  const m = location.hash.match(/^#l=(.+)$/);
  return m ? { view: "list", listId: decodeURIComponent(m[1]) } : { view: "lists", listId: null };
}
function go(listId) {
  location.hash = listId ? "#l=" + encodeURIComponent(listId) : "";
}
window.addEventListener("hashchange", () => {
  state.route = parseRoute();
  state.composer = { mode: "task", parentId: null };
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

const dlg = $("#dialog");
const dlgForm = $("#dialogForm");
const dlgTitle = $("#dialogTitle");
const dlgMsg = $("#dialogMsg");
const dlgInput = $("#dialogInput");
const dlgOk = $("#dialogOk");
const dlgCancel = $("#dialogCancel");

// Shows the dialog. Resolves to the typed text (input dialogs), true (confirm
// dialogs), or null if cancelled.
function openDialog({ title, message = "", input = false, value = "", okLabel = "OK", danger = false, placeholder = "" }) {
  return new Promise((resolve) => {
    dlgTitle.textContent = title;
    dlgMsg.textContent = message;
    dlgMsg.hidden = !message;
    dlgInput.hidden = !input;
    dlgInput.value = value;
    dlgInput.placeholder = placeholder;
    dlgOk.textContent = okLabel;
    dlgOk.className = danger ? "btn-danger" : "btn-primary";

    let settled = false;
    const cleanup = () => {
      dlgForm.removeEventListener("submit", onSubmit);
      dlgCancel.removeEventListener("click", onCancel);
      dlg.removeEventListener("cancel", onCancel);
      dlg.removeEventListener("close", onCancel);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dlg.open) dlg.close();
      resolve(result);
    };
    function onSubmit(e) {
      e.preventDefault();
      const v = dlgInput.value.trim();
      finish(input ? v || null : true);
    }
    function onCancel() { finish(null); }

    dlgForm.addEventListener("submit", onSubmit);
    dlgCancel.addEventListener("click", onCancel);
    dlg.addEventListener("cancel", onCancel);
    dlg.addEventListener("close", onCancel);
    dlg.showModal();
    if (input) { dlgInput.focus(); dlgInput.select(); }
  });
}
const askText = (title, value = "", okLabel = "Save") =>
  openDialog({ title, input: true, value, okLabel });
const confirmBox = (title, message, okLabel = "Delete") =>
  openDialog({ title, message, okLabel, danger: true });

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
}

/* ---------- Data listeners ---------- */

function startListeners() {
  stopListeners();
  unsubLists = onSnapshot(
    query(collection(db, "lists")),
    (snap) => {
      state.lists = sortLists(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
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

function addList(name) {
  const ref = doc(collection(db, "lists"));
  setDoc(ref, { name, order: Date.now(), createdBy: state.user.email }).catch(handleError);
  return ref.id;
}
function renameList(id, name) {
  updateDoc(doc(db, "lists", id), { name }).catch(handleError);
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
  const batch = writeBatch(db);
  for (const c of changes) batch.update(doc(db, "tasks", c.id), { done: c.done, doneAt: c.doneAt });
  batch.commit().catch(handleError);
}
function renameTask(id, text) {
  updateDoc(doc(db, "tasks", id), { text }).catch(handleError);
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
    app.innerHTML = '<div class="empty">Loading…</div>';
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
  app.innerHTML = `<form class="auth" id="authForm">
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

function renderHeader() {
  const h = $("#hdr");
  if (!h) return;
  const offline = navigator.onLine ? "" : '<span class="chip">Offline</span>';
  if (state.route.view === "lists") {
    h.innerHTML = `<h1>Our Lists</h1>${offline}
      <button class="icon-btn" data-action="account" aria-label="Account">⋯</button>`;
    return;
  }
  const list = state.lists.find((l) => l.id === state.route.listId);
  h.innerHTML = `<button class="icon-btn back-btn" data-action="back" aria-label="Back to lists">‹ Lists</button>
    <h1>${esc(list ? list.name : "")}</h1>${offline}
    <button class="icon-btn" data-action="listMenu" aria-label="List options">⋯</button>`;
}

function rowHtml(t, isSub) {
  const cls = isSub ? "sub" : "task";
  return `<div class="${cls} ${t.done ? "is-done" : ""}">
    <button class="check" data-action="toggle" data-id="${t.id}" aria-label="${t.done ? "Mark not done" : "Mark done"}"><span>✓</span></button>
    <div class="task-text" data-action="rename" data-id="${t.id}">${esc(t.text)}</div>`;
}

function blockHtml(g) {
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
  return `<li class="task-block">${rowHtml(t, false)}${counter}
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
    c.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }

  if (state.route.view === "lists") {
    if (!state.lists.length) {
      c.innerHTML = '<div class="empty">No lists yet.<br>Tap “New list” to start one.</div>';
      return;
    }
    c.innerHTML = `<div class="card">${state.lists
      .map(
        (l) => `<button class="list-row" data-action="openList" data-id="${l.id}">
          <span class="name">${esc(l.name)}</span>
          <span class="count">${openCount(state.tasks, l.id) || ""}</span>
          <span class="chev">›</span></button>`
      )
      .join("")}</div>`;
    return;
  }

  const list = state.lists.find((l) => l.id === state.route.listId);
  if (!list) {
    if (state.pendingListId === state.route.listId) {
      c.innerHTML = '<div class="empty">Loading…</div>';
      return;
    }
    toast("That list no longer exists.");
    go(null);
    return;
  }
  if (state.pendingListId === list.id) state.pendingListId = null;
  const { open, done } = groupTasks(state.tasks, list.id);
  let html = "";
  if (!open.length && !done.length) {
    html = '<div class="empty">Nothing here yet.<br>Add your first task below.</div>';
  } else {
    if (open.length) html += `<ul class="tasks card">${open.map(blockHtml).join("")}</ul>`;
    else html += '<div class="empty">All done. 🎉</div>';
    if (done.length) {
      const show = !!state.showDone[list.id];
      html += `<button class="section-toggle" data-action="toggleDone">${show ? "▾" : "▸"} Completed (${done.length})</button>`;
      if (show) html += `<ul class="tasks card">${done.map(blockHtml).join("")}</ul>`;
    }
  }
  c.innerHTML = html;
}

function renderComposer() {
  const c = $("#composer");
  if (!c) return;
  if (state.route.view === "lists") {
    c.innerHTML = '<button class="btn-primary btn-block" data-action="newList">+ New list</button>';
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
    case "back": go(null); break;
    case "toggle": toggleTask(id); break;
    case "toggleDone": {
      const k = state.route.listId;
      state.showDone[k] = !state.showDone[k];
      renderContent();
      break;
    }
    case "newList": {
      const name = await askText("New list", "", "Create");
      if (name) {
        const newId = addList(name);
        state.pendingListId = newId; // so we don't mistake it for a deleted list while it syncs in
        go(newId);
      }
      break;
    }
    case "rename": {
      if (!task) break;
      const text = await askText("Edit task", task.text);
      if (text && text !== task.text) renameTask(task.id, text);
      break;
    }
    case "taskMenu": {
      if (!task) break;
      const items = [];
      if (!task.parentId) {
        items.push({
          label: "Add subtask",
          run: () => {
            state.composer = { mode: "sub", parentId: task.id };
            renderComposer();
          }
        });
      }
      items.push({
        label: "Rename",
        run: async () => {
          const text = await askText("Edit task", task.text);
          if (text && text !== task.text) renameTask(task.id, text);
        }
      });
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
      const list = state.lists.find((l) => l.id === state.route.listId);
      if (!list) break;
      const doneCount = state.tasks.filter((t) => t.listId === list.id && t.done).length;
      const items = [
        {
          label: "Rename list",
          run: async () => {
            const name = await askText("Rename list", list.name);
            if (name && name !== list.name) renameList(list.id, name);
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
      openSheet(list.name, items);
      break;
    }
    case "account":
      openSheet(`Signed in as ${state.user.email}`, [
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
