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
// Returns false when nothing could be applied, so the caller does not record a
// prefix it will later be unable to remove.
function pageAgent(prefix, stale, tabTitle) {
  const KEY = "__singleGroupWindowTitle";
  let s = window[KEY];
  const fresh = !s;

  // The browser can set the tab title without touching document.title. Chrome's
  // PDF viewer does exactly that, from the file's metadata, which is why reading
  // document.title alone loses the document's real name and leaves the filename
  // or URL behind. When the two disagree, the tab title is what the user sees
  // and the only correct thing to build on.
  const observed =
    tabTitle && tabTitle !== document.title ? tabTitle : document.title;

  if (!s) {
    // A prefix written by a previous extension session (reload, update, or a
    // disable/enable cycle) is still on the title, but the state that knew how
    // to remove it is gone. Strip exactly what we recorded writing here, or it
    // becomes part of base and every later rename stacks another copy on top.
    let base = observed;
    if (stale && base.startsWith(stale)) base = base.slice(stale.length);

    s = window[KEY] = { prefix: "", base, written: null };

    s.write = () => {
      const want = s.prefix + s.base;
      if (document.title === want) return;
      s.written = want; // lets the observer recognize and ignore our own write
      document.title = want;
    };

    s.obs = new MutationObserver(() => {
      if (document.title === s.written) return;
      // The page retitled itself (SPA route change, unread counter, ...).
      s.base =
        s.prefix && document.title.startsWith(s.prefix)
          ? document.title.slice(s.prefix.length)
          : document.title;
      s.write();
    });
  }

  // Re-read the title when injecting into state that already exists. Not every
  // writer produces a mutation the observer can see: Chrome's PDF viewer sets
  // the title from file metadata after loading finishes, and the agent never
  // hears about it. Trusting the cached base would resurrect a stale one, which
  // is how a re-apply used to produce "[Research] " with the filename missing.
  // Skipped when fresh, where base was just derived and the stale hint stripped.
  if (!fresh && observed !== s.written) {
    s.base =
      s.prefix && observed.startsWith(s.prefix)
        ? observed.slice(s.prefix.length)
        : observed;
  }

  s.prefix = prefix;
  s.write();

  // Generated documents such as the PDF viewer's may have no <head>.
  const root = document.head || document.documentElement;
  if (prefix && root) {
    s.obs.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  } else if (!prefix) {
    s.obs.disconnect();
  }

  return true;
}

// What we last injected into each tab. Skipping no-op injections is what stops
// the echo: our own title write fires tabs.onUpdated, which schedules a refresh,
// which would otherwise inject the same prefix again, forever.
const applied = new Map();

// How many times we will put the prefix back after something else removes it,
// per document. One is enough for the PDF viewer's single post-load write; the
// cap exists so a page that rewrites its title in a loop cannot be fought
// forever. Reset whenever the document changes.
const MAX_DIVERGENCE = 3;
const diverged = new Map();

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

  // Writing onto a title that is about to be replaced only produces a flash,
  // and the base captured mid-load is wrong anyway. The "complete" event, and
  // for PDFs the title event after it, bring us back here.
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

chrome.tabs.onActivated.addListener(({ windowId }) => scheduleRefresh(windowId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A navigation destroys the injected agent and resets the title, so whatever
  // we last applied no longer holds. Invalidating on *every* status change, not
  // just "loading", matters: a title event mid-load repopulates the cache for a
  // document that is still being replaced, and then the refresh at "complete"
  // skips as a no-op and the finished page never gets an agent.
  if (changeInfo.status) {
    applied.delete(tabId);
    diverged.delete(tabId);
  }

  // A background tab joining or leaving the group changes whether the window
  // still qualifies, so this one is not gated on the tab being active.
  if (changeInfo.groupId !== undefined) return scheduleRefresh(tab.windowId);

  if (!tab.active) return;

  if (changeInfo.title !== undefined) {
    const current = applied.get(tabId);
    if (current && !changeInfo.title.startsWith(current)) {
      // The prefix is gone from the tab title and the page agent did not put it
      // back, so whatever rewrote it was invisible to the observer. Chrome's PDF
      // viewer does this once, from file metadata, after "complete". Drop the
      // cache so the refresh below actually re-injects instead of no-opping.
      const tries = diverged.get(tabId) ?? 0;
      if (tries >= MAX_DIVERGENCE) return; // stop rather than trade writes forever
      diverged.set(tabId, tries + 1);
      applied.delete(tabId);
    }
    return scheduleRefresh(tab.windowId);
  }

  if (changeInfo.status === "complete") scheduleRefresh(tab.windowId);
});

// Closing or dragging a tab can make a window qualify or stop qualifying
// without the active tab itself changing. Tab *creation* is deliberately not
// hooked: grouping the new tab fires onUpdated with groupId, and refreshing
// before that lands would count the fresh tab as a stray and flicker the title.
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  applied.delete(tabId);
  diverged.delete(tabId);
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
