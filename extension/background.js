const NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;
const TITLE_PREF = "titlePrefixEnabled";

// Serialize all title work so overlapping events cannot interleave writes.
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn).catch(() => {}));

// Coalesce bursts of events per window. Renaming a group fires tabGroups
// .onUpdated on every keystroke, and refreshing per keystroke means injecting a
// script and rewriting the window title while the rename bubble is open.
const pending = new Map();
function scheduleRefresh(windowId, delay = 0) {
  clearTimeout(pending.get(windowId));
  pending.set(
    windowId,
    setTimeout(() => {
      pending.delete(windowId);
      queue(() => refreshWindow(windowId));
    }, delay),
  );
}
const RENAME_SETTLE_MS = 300;

// ---------------------------------------------------------------- grouping

// The sole group of `windowId`, or null if the window is not exactly one group.
// Pinned tabs are ignored: Chrome drops a tab from its group when you pin it,
// so counting them as strays would disable the feature permanently.
async function soleGroupId(windowId, ignoreTabId) {
  const groups = await chrome.tabGroups.query({ windowId });
  if (groups.length !== 1) return null;
  const tabs = await chrome.tabs.query({ windowId });
  const stray = tabs.some(
    (t) => t.groupId === NONE && !t.pinned && t.id !== ignoreTabId,
  );
  return stray ? null : groups[0].id;
}

chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    if (tab.pinned || tab.groupId !== NONE) return; // Chrome may have grouped it already
    const win = await chrome.windows.get(tab.windowId);
    if (win.type !== "normal") return; // skip popups and app windows

    const groupId = await soleGroupId(tab.windowId, tab.id);
    if (groupId === null) return;

    // Re-read: the tab may have been grouped, moved, or closed during the awaits.
    const fresh = await chrome.tabs.get(tab.id);
    if (fresh.groupId !== NONE || fresh.windowId !== tab.windowId) return;

    await chrome.tabs.group({ groupId, tabIds: tab.id });
  } catch {
    // Tab or group disappeared mid-flight; nothing to do.
  }
});

// ------------------------------------------------------------------ titles

// Runs in the page (isolated world). `window[KEY]` survives repeated injections
// into the same document, so we install exactly one observer per page.
//
// The tricky part is Chrome's PDF viewer, whose behavior was pinned down by
// experiment:
//   - It sets the *tab* title from file metadata, out of band from
//     document.title, so the two can disagree; the caller passes the real tab
//     title (read from chrome.tabs) as `tabTitle`.
//   - The browser decides whether a document.title assignment is a change by
//     comparing against the previous document.title, trimmed. Re-writing the
//     value it already holds is a no-op, even when the tab is showing something
//     else. So when the viewer has desynced the tab, we cannot simply re-assign
//     the target: we drop document.title to the bare base first (a real change,
//     which the browser propagates to the tab), and the observer re-prefixes it,
//     which is itself a change and reaches the tab too.
function pageAgent(prefix, stale, tabTitle) {
  const KEY = "__singleGroupWindowTitle";
  const norm = (t) => (t ?? "").trim(); // the browser trims when detecting change
  let s = window[KEY];
  const fresh = !s;

  // When the tab title and document.title disagree, the tab title is what the
  // user sees and the truth to build the base on.
  const observed =
    tabTitle && tabTitle !== document.title ? tabTitle : document.title;

  if (fresh) {
    // A prefix written by a previous extension session (reload, update, or a
    // disable/enable cycle) may still be on the title with no state left to
    // remove it. Strip exactly what we recorded writing, or it becomes part of
    // base and every later rename stacks another copy on top.
    let base = observed;
    if (stale && base.startsWith(stale)) base = base.slice(stale.length);

    s = window[KEY] = { prefix: "", base, written: null };

    s.write = () => {
      const want = s.prefix + s.base;
      if (norm(document.title) === norm(want)) return;
      s.written = want; // lets the observer recognize and skip our own write
      document.title = want;
    };

    s.obs = new MutationObserver(() => {
      if (norm(document.title) === norm(s.written)) return;
      // The title changed under us: a page retitle (SPA route, unread counter),
      // or our own base nudge below. Re-derive the base and re-prefix.
      s.base =
        s.prefix && document.title.startsWith(s.prefix)
          ? document.title.slice(s.prefix.length)
          : document.title;
      s.write();
    });
  } else if (observed !== s.written) {
    // Re-injected, and the visible title moved with no mutation we could see
    // (the PDF viewer again). Rebuild the base from what is actually shown.
    s.base =
      s.prefix && observed.startsWith(s.prefix)
        ? observed.slice(s.prefix.length)
        : observed;
  }

  s.prefix = prefix;

  // Observe before writing so the observer catches the base nudge below.
  // Generated documents such as the PDF viewer's may have no <head>.
  const root = document.head || document.documentElement;
  if (prefix && root) {
    s.obs.observe(root, { subtree: true, childList: true, characterData: true });
  } else if (!prefix) {
    s.obs.disconnect();
  }

  const want = s.prefix + s.base;
  if (norm(document.title) !== norm(want)) {
    s.write(); // a genuine change; the browser propagates it to the tab
  } else if (prefix && tabTitle && norm(tabTitle) !== norm(want)) {
    // document.title already equals the target, but the tab shows something else
    // because the viewer wrote it directly. A same-value assignment is ignored,
    // so drop to the bare base; the observer re-prefixes it and that reaches the
    // tab.
    document.title = s.base;
  }

  return true;
}

// What we last injected into each tab. Skipping no-op injections is what stops
// the echo: our own title write fires tabs.onUpdated, which schedules a refresh,
// which would otherwise inject the same prefix again, forever.
const applied = new Map();

// Resolves true only when the prefix is actually on the page. Callers must not
// record a prefix on a false return: a prefix we believe is applied but cannot
// remove is how a stale group name gets stranded on an inactive tab.
async function setPrefix(tabId, prefix, stale = "") {
  if (applied.get(tabId) === prefix) return true;

  // Read the tab title from the browser rather than letting the page infer it.
  // For a PDF this is the file's metadata name, which never reaches
  // document.title and would otherwise be lost the first time we rewrite it.
  let tabTitle = "";
  try {
    tabTitle = (await chrome.tabs.get(tabId)).title ?? "";
  } catch {
    return false; // tab closed mid-flight
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageAgent,
      args: [prefix, stale, tabTitle],
    });
    if (result === false) {
      applied.delete(tabId); // the document declined, e.g. the PDF viewer
      return false;
    }
    applied.set(tabId, prefix);
    return true;
  } catch {
    // chrome://, the Web Store, and other extensions reject injection outright.
    applied.delete(tabId);
    return false;
  }
}

async function prefixFor(tab) {
  if (!tab || tab.groupId === NONE) return "";
  // Only in windows that are exactly one group: the same condition that drives
  // auto-grouping, so the prefix is a reliable signal that the window is "the"
  // Research window rather than a window that merely has Research open.
  if ((await soleGroupId(tab.windowId)) !== tab.groupId) return "";
  try {
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title ? `[${group.title}] ` : "";
  } catch {
    return "";
  }
}

async function titlesEnabled() {
  const stored = await chrome.storage.local.get(TITLE_PREF);
  return stored[TITLE_PREF] !== false; // default on
}

// Only the active tab is ever prefixed, so the tab strip stays readable.
// `w<id>` records {tabId, prefix}: which tab in this window carries a prefix and
// exactly what that prefix is. It lives in storage.local, not storage.session,
// so it survives an extension reload. That is the only way to recover a prefix
// whose page-side state was destroyed while the text stayed on the title.
async function refreshWindow(windowId) {
  const key = `w${windowId}`;
  const prev = (await chrome.storage.local.get(key))[key];
  const [active] = await chrome.tabs.query({ active: true, windowId });

  if (prev && prev.tabId !== active?.id) {
    await setPrefix(prev.tabId, "", prev.prefix);
  }
  if (!active) return chrome.storage.local.remove(key);

  const prefix = (await titlesEnabled()) ? await prefixFor(active) : "";

  // Writing onto a title that is about to be replaced only produces a flash, and
  // the base captured mid-load is wrong anyway. The "complete" event brings us
  // back, and the settle loop covers a title that keeps moving after that.
  if (prefix && active.status === "loading") return;

  const stale = prev && prev.tabId === active.id ? prev.prefix : "";
  const ok = await setPrefix(active.id, prefix, stale);

  if (prefix && ok) {
    await chrome.storage.local.set({ [key]: { tabId: active.id, prefix } });
  } else {
    await chrome.storage.local.remove(key);
  }
}

const refreshAll = async () => {
  for (const win of await chrome.windows.getAll({ windowTypes: ["normal"] })) {
    await refreshWindow(win.id);
  }
};

// Chrome's PDF viewer sets the *tab* title from file metadata, out of band from
// document.title, and gets the last word during load: after "complete" it flips
// the tab back to "loading" and rewrites the filename, overwriting the prefix we
// applied. The in-page agent cannot see this (it never touches document.title),
// and a single re-apply loses the race because the viewer writes again.
//
// So after a load completes, poll a short settle window and re-assert the prefix
// whenever the tab title has lost it. The re-apply only runs once the tab is out
// of "loading" (injecting into a loading PDF is unreliable); otherwise the tick
// just waits for the next one. An ordinary page whose title stuck on the first
// tick stops immediately; a PDF keeps being watched until the window closes,
// which outlasts the viewer's rewrites. Once the viewer settles, our last write
// stands and nothing further disturbs it.
const RECONCILE_MS = 350;
const RECONCILE_TICKS = 6; // ~2s window, comfortably past the viewer's rewrites
const reconcilers = new Map();

function cancelReconcile(tabId) {
  clearTimeout(reconcilers.get(tabId));
  reconcilers.delete(tabId);
}

function scheduleReconcile(tabId, windowId, tick = 0) {
  cancelReconcile(tabId);
  reconcilers.set(
    tabId,
    setTimeout(() => {
      reconcilers.delete(tabId);
      queue(() => reconcile(tabId, windowId, tick));
    }, RECONCILE_MS),
  );
}

async function reconcile(tabId, windowId, tick) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // tab gone
  }
  if (!tab.active) return; // another tab is active now; its own flow owns it

  const prefix = (await titlesEnabled()) ? await prefixFor(tab) : "";
  if (!prefix) return; // window no longer qualifies (e.g. a tab was dragged out)

  const missing = !(tab.title ?? "").startsWith(prefix);
  if (missing && tab.status !== "loading") {
    applied.delete(tabId); // force setPrefix past its cache and re-inject
    await refreshWindow(windowId);
  }

  // Stop early only when the very first tick already finds the prefix present:
  // that is an ordinary page whose title stuck, and there is nothing to watch.
  // Any miss means a viewer-style tab that can rewrite again, so keep watching
  // the whole window.
  if ((missing || tick > 0) && tick + 1 < RECONCILE_TICKS) {
    scheduleReconcile(tabId, windowId, tick + 1);
  }
}

chrome.tabs.onActivated.addListener(({ windowId }) => scheduleRefresh(windowId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A navigation replaces the document, so the injected agent is gone and the
  // cache no longer describes this page. A pending settle from the old load is
  // moot too.
  if (changeInfo.status) {
    applied.delete(tabId);
    cancelReconcile(tabId);
  }

  // A background tab joining or leaving the group changes whether the window
  // still qualifies, so this one is not gated on the tab being active.
  if (changeInfo.groupId !== undefined) return scheduleRefresh(tab.windowId);

  // Apply on load completion, then watch the settle window. Title changes are
  // not handled here: for ordinary pages the in-page agent maintains the prefix
  // against document.title, and for the PDF viewer the settle loop is what wins
  // the tab-title rewrites, which is the only case document.title cannot cover.
  if (tab.active && changeInfo.status === "complete") {
    scheduleRefresh(tab.windowId);
    scheduleReconcile(tabId, tab.windowId);
  }
});

// Closing or dragging a tab can make a window qualify or stop qualifying
// without the active tab itself changing. Tab *creation* is deliberately not
// hooked: grouping the new tab fires onUpdated with groupId, and refreshing
// before that lands would count the fresh tab as a stray and flicker the title.
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  applied.delete(tabId);
  cancelReconcile(tabId);
  if (!isWindowClosing) scheduleRefresh(windowId);
});
chrome.tabs.onAttached.addListener((_id, { newWindowId }) =>
  scheduleRefresh(newWindowId),
);
chrome.tabs.onDetached.addListener((_id, { oldWindowId }) =>
  scheduleRefresh(oldWindowId),
);
chrome.tabGroups.onCreated.addListener(({ windowId }) =>
  scheduleRefresh(windowId),
);
// Renaming fires this once per keystroke, so let the name settle first.
chrome.tabGroups.onUpdated.addListener(({ windowId }) =>
  scheduleRefresh(windowId, RENAME_SETTLE_MS),
);
chrome.tabGroups.onRemoved.addListener(({ windowId }) =>
  scheduleRefresh(windowId),
);
chrome.windows.onRemoved.addListener((windowId) =>
  chrome.storage.local.remove(`w${windowId}`),
);

// ------------------------------------------------------------------ toggle

async function paintBadge() {
  const on = await titlesEnabled();
  await chrome.action.setBadgeText({ text: on ? "" : "off" });
}

chrome.action.onClicked.addListener(() =>
  queue(async () => {
    await chrome.storage.local.set({ [TITLE_PREF]: !(await titlesEnabled()) });
    await paintBadge();
    await refreshAll();
  }),
);

// Tab ids are reassigned across a browser restart and restored pages reload
// with their own titles, so the stored records are meaningless and would strip
// text off the wrong tab. On reload or update they are kept: that is exactly
// when a prefix outlives the page state that knew how to remove it.
chrome.runtime.onStartup.addListener(() =>
  queue(async () => {
    const stale = Object.keys(await chrome.storage.local.get(null)).filter((k) =>
      /^w\d+$/.test(k),
    );
    await chrome.storage.local.remove(stale);
    await paintBadge();
    await refreshAll();
  }),
);

chrome.runtime.onInstalled.addListener(() =>
  queue(async () => (await paintBadge(), refreshAll())),
);
