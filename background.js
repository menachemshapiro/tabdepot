// Service worker: rolling thumbnail cache, context menus, shortcuts, auto-stash, badge.

import { STASH_PAGE, getSettings, getState, mutate, idbPut, idbDel, idbClear, hostOf } from './common.js';
import { captureActive, openStashPage, stashTabs, stashLink, tabsForScope, activity, restoreItems } from './core.js';
import { notify } from './notify.js';
import { REMINDER_ALARM, scheduleReminders, fireDueReminders } from './reminders.js';
import { purgeTrash } from './trash.js';
import { takeStashSnapshot, takeTabsSnapshot, windowsData } from './snapshots.js';

// ---------- rolling thumbnail cache for open tabs ----------

const lastCapture = new Map();

async function captureTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab.active || tab.discarded || tab.status !== 'complete') return;
  if (!/^https?:|^file:/i.test(tab.url || '') || (tab.url || '').startsWith(STASH_PAGE)) return;
  const now = Date.now();
  if (now - (lastCapture.get(tabId) || 0) < 4000) return;
  lastCapture.set(tabId, now);
  try {
    const blob = await captureActive(tab.windowId);
    await idbPut('live', tabId, { blob, url: tab.url, ts: now });
  } catch {
    /* restricted page or window not visible */
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => setTimeout(() => captureTab(tabId), 700));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) setTimeout(() => captureTab(tabId), 900);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  lastCapture.delete(tabId);
  idbDel('live', tabId).catch(() => {});
});

// ---------- setup ----------

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'stash-page', title: 'Stash this tab', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'stash-link', title: 'Stash this link', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'open-stash', title: 'Open TabDepot', contexts: ['action'] });
  });
}

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  setupMenus();
  if (reason === 'update' && previousVersion && previousVersion !== chrome.runtime.getManifest().version) {
    chrome.storage.local.set({ updatedFrom: previousVersion });
  }
  chrome.alarms.create('auto-stash', { periodInMinutes: 30 });
  chrome.alarms.create('snapshot', { periodInMinutes: 10 });
  refreshWindowCache();
  updateBadge();
  checkReminders();
  if (reason === 'install' || reason === 'update') openStashPage();
});

chrome.runtime.onStartup.addListener(() => {
  idbClear('live').catch(() => {}); // tab ids are not stable across browser restarts
  chrome.alarms.create('auto-stash', { periodInMinutes: 30 });
  chrome.alarms.create('snapshot', { periodInMinutes: 10 });
  refreshWindowCache();
  updateBadge();
  checkReminders();
});

// ---------- actions ----------

// System notification after a stash that was started from a shortcut or menu (no page is showing the result).
function tellStashed(res) {
  if (!res?.count) return;
  notify('stashed', 'TabDepot', res.count === 1 ? 'Stashed 1 tab' : `Stashed ${res.count} tabs`);
}

async function stashScope(scope, extra = {}) {
  const tabs = await tabsForScope(scope);
  if (!tabs.length) return { count: 0 };
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return stashTabs(tabs, { protectWindowId: active?.windowId, ...extra });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'stash-page' && tab) tellStashed(await stashTabs([tab], { protectWindowId: tab.windowId }));
  else if (info.menuItemId === 'stash-link' && info.linkUrl) {
    await stashLink(info.linkUrl, info.selectionText || '');
    notify('stashed', 'TabDepot', 'Link stashed');
  }
  else if (info.menuItemId === 'open-stash') await openStashPage();
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'stash-current') tellStashed(await stashScope('tab'));
  else if (cmd === 'stash-window') tellStashed(await stashScope('window'));
  else if (cmd === 'open-stash') await openStashPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'stash') return stashScope(msg.scope, { groupId: msg.groupId || null, groupName: msg.groupName || null });
    if (msg?.type === 'stashTabs') {
      const found = await Promise.all((msg.tabIds || []).map((id) => chrome.tabs.get(id).catch(() => null)));
      const win = await chrome.windows.getLastFocused();
      return stashTabs(found.filter(Boolean), { groupId: msg.groupId || null, groupName: msg.groupName || null, protectWindowId: win.id });
    }
    if (msg?.type === 'openStash') {
      await openStashPage(msg.hash || '');
      return { ok: true };
    }
    return { error: 'unknown message' };
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

// ---------- auto-stash of long-idle tabs ----------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'snapshot') {
    await takeTabsSnapshot('automatic').catch(() => {});
    await takeStashSnapshot('automatic', { auto: true, minGapMs: 30 * 60 * 1000 }).catch(() => {});
    await purgeTrash().catch(() => {});
    return;
  }
  if (alarm.name === REMINDER_ALARM) {
    await fireDueReminders().catch(() => {});
    await scheduleReminders().catch(() => {});
    return;
  }
  if (alarm.name !== 'auto-stash') return;
  const settings = await getSettings();
  if (!settings.autoStashDays) return;
  const cutoff = Date.now() - settings.autoStashDays * 86400000;
  const tabs = (await chrome.tabs.query({})).filter(
    (t) => !t.active && !t.pinned && !t.audible && t.lastAccessed && t.lastAccessed < cutoff
  );
  // never visits tabs (noCapture): thumbnails come only from the rolling cache
  if (tabs.length) {
    const res = await stashTabs(tabs, { noCapture: true });
    if (res?.count) notify('autostash', 'TabDepot', `Stashed ${res.count} ${res.count === 1 ? 'tab' : 'tabs'} you had not used for ${settings.autoStashDays} days`);
  }
});

// ---------- reminders ----------

async function checkReminders() {
  await fireDueReminders().catch(() => {}); // anything that came due while the browser was closed
  await scheduleReminders().catch(() => {});
}

chrome.notifications?.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  if (id.startsWith('reminder:') || id === 'stashed' || id === 'autostash') await openStashPage();
});

chrome.notifications?.onButtonClicked.addListener(async (id, button) => {
  chrome.notifications.clear(id);
  if (!id.startsWith('reminder:')) return;
  const itemId = id.slice('reminder:'.length);
  const { items } = await getState();
  const item = items.find((i) => i.id === itemId);
  if (!item) return;
  if (button === 0) {
    await restoreItems([item], { keep: true });
    await mutate((s) => {
      const it = s.items.find((x) => x.id === itemId);
      if (it) {
        delete it.remindAt;
        delete it.remindFired;
      }
    });
  } else {
    await mutate((s) => {
      const it = s.items.find((x) => x.id === itemId);
      if (it) {
        it.remindAt = Date.now() + 3600000;
        delete it.remindFired;
      }
    });
  }
  await scheduleReminders();
});

// ---------- safety snapshots: remember open windows so an accidental close is recoverable ----------

let cacheTimer;
function scheduleWindowCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(refreshWindowCache, 2500);
}
async function refreshWindowCache() {
  try {
    const cache = {};
    for (const w of await windowsData()) cache[w.id] = w;
    await chrome.storage.session.set({ winCache: cache });
  } catch {
    /* best effort */
  }
}
for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.windows.onCreated]) {
  ev.addListener(scheduleWindowCache);
}
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.title || info.url) scheduleWindowCache();
});
chrome.windows.onRemoved.addListener(async (windowId) => {
  if (Date.now() - activity.lastStashAt < 8000) return; // closed because we stashed it
  try {
    const { winCache } = await chrome.storage.session.get('winCache');
    const w = winCache?.[windowId];
    if (w && w.tabs.length >= 2) await takeTabsSnapshot('window closed', [w]);
  } catch {
    /* best effort */
  }
});

// ---------- badge ----------

async function updateBadge() {
  const { items } = await getState();
  const n = items.length;
  chrome.action.setBadgeText({ text: n ? (n > 999 ? '999+' : String(n)) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4c6ef5' });
}
let remindTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state) return;
  updateBadge();
  clearTimeout(remindTimer);
  remindTimer = setTimeout(() => scheduleReminders().catch(() => {}), 1500);
});
updateBadge();
