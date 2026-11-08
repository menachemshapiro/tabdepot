// Shared helpers: storage, IndexedDB (thumbnails), small utilities.

export const STASH_PAGE = chrome.runtime.getURL('stash.html');

export const COLOR_HEX = {
  grey: '#9aa0a6',
  blue: '#4c8bf5',
  red: '#e8584f',
  yellow: '#f2b705',
  green: '#34a853',
  pink: '#ee6aa7',
  purple: '#9b6bdf',
  cyan: '#14b8c4',
  orange: '#f28b30',
};
export const COLORS = Object.keys(COLOR_HEX);
const AUTO_COLORS = ['blue', 'green', 'orange', 'purple', 'pink', 'cyan', 'yellow', 'red', 'grey'];

export const DEFAULT_SETTINGS = {
  includePinned: false, // include pinned tabs when stashing many tabs
  preserveChromeGroups: true, // keep Chrome tab groups as stash groups
  dedupe: true, // don't store the same URL twice
  flipCapture: false, // screenshot unloaded tabs by visiting them (slow, can start videos)
  fetchThumbs: true, // after stashing, fetch thumbnails from the web without touching tabs
  openMode: 'remove', // clicking a card: 'remove' (open + remove), 'keep' (open, stay in stash), 'ask'
  lazyRestore: true, // restore many tabs without loading them until clicked
  autoStashDays: 0, // 0 = off
  checkUpdates: true, // look for a newer release on GitHub (at most every 6 hours)
  snapshots: true, // rolling safety snapshots (stash history + open-tabs history)
  openDest: 'tabs', // where several tabs open: 'tabs' (this window), 'group' (as a Chrome tab group), 'window' (new window)
  notifications: true, // system notifications (reminders, auto-stash, shortcuts)
  keepDeleted: false, // keep deleted tabs for 30 days in "Recently deleted"
  cardSize: 300,
  sort: 'newest',
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const faviconFor = (url) =>
  `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;

const SKIP = [
  /^chrome:\/\/newtab/,
  /^chrome:\/\/new-tab-page/,
  /^edge:\/\/newtab/,
  /^brave:\/\/newtab/,
  /^about:blank/,
  /^chrome-search:/,
];
export function isStashableUrl(url) {
  if (!url) return false;
  if (url.startsWith(STASH_PAGE)) return false;
  return !SKIP.some((r) => r.test(url));
}

export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else id = (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1];
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Two links that point at the same page get the same key: ignores http/https, www, a trailing
// slash, #fragments, tracking parameters (utm_*, fbclid, ...) and parameter order; every kind of
// YouTube link to the same video (watch, youtu.be, shorts, embed; any timestamp) is one key.
const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|vero_id|ref_src|ref_url|spm|cmpid)$/i;
export function dupKey(url) {
  try {
    const yt = youtubeId(url);
    if (yt) return 'yt:' + yt;
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const q = [...u.searchParams]
      .filter(([k]) => !TRACKING_PARAMS.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    let path = u.pathname.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/$/, '');
    const hash = /^#[!/]/.test(u.hash) ? u.hash : ''; // keep single-page-app routes only
    return `${host}${u.port ? ':' + u.port : ''}${path}${q ? '?' + q : ''}${hash}`;
  } catch {
    return url;
  }
}

// ---------- state (chrome.storage.local) ----------
//
// state = { items: [{ id, url, title, description, ogImage, addedAt, order, groupIds: [], note, link? }],
//           groups: [{ id, name, color, parentId|null, collapsed, treeCollapsed }],
//           orders: { [groupId | 'none']: [itemId, ...] }   // manual card order per section }
// An item can be in any number of groups; no groups = "Ungrouped".

// Brings any stored state (including the pre-1.3 shape with a single groupId) up to date, in place.
export function normalizeState(state) {
  state.items ||= [];
  state.groups ||= [];
  state.orders ||= {};
  const ids = new Set(state.groups.map((g) => g.id));
  for (const g of state.groups) if (g.parentId === undefined || !ids.has(g.parentId)) g.parentId = null;
  for (const g of state.groups) {
    // defensive: break accidental parent cycles
    const seen = new Set([g.id]);
    for (let p = state.groups.find((x) => x.id === g.parentId); p; p = state.groups.find((x) => x.id === p.parentId)) {
      if (seen.has(p.id)) {
        g.parentId = null;
        break;
      }
      seen.add(p.id);
    }
  }
  for (const it of state.items) {
    if (!Array.isArray(it.groupIds)) it.groupIds = it.groupId ? [it.groupId] : [];
    delete it.groupId;
    it.groupIds = [...new Set(it.groupIds)].filter((id) => ids.has(id));
  }
  return state;
}

export async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return normalizeState({ items: state?.items || [], groups: state?.groups || [], orders: state?.orders || {} });
}

// ---- group tree helpers (pure) ----
export const childGroups = (groups, parentId = null) => groups.filter((g) => (g.parentId ?? null) === parentId);
export function descendantIds(groups, id) {
  const out = [];
  const walk = (pid) => {
    for (const g of childGroups(groups, pid)) {
      out.push(g.id);
      walk(g.id);
    }
  };
  walk(id);
  return out;
}
export function flattenGroups(groups, rootId = null, depth = 0) {
  const out = [];
  for (const g of childGroups(groups, rootId)) {
    out.push({ group: g, depth });
    out.push(...flattenGroups(groups, g.id, depth + 1));
  }
  return out;
}
export function groupPath(groups, id, sep = ' / ') {
  const parts = [];
  const seen = new Set();
  for (let g = groups.find((x) => x.id === id); g && !seen.has(g.id); g = groups.find((x) => x.id === g.parentId)) {
    seen.add(g.id);
    parts.unshift(g.name);
  }
  return parts.join(sep);
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (settings && settings.openMode === undefined && settings.keepOnOpen) merged.openMode = 'keep'; // pre-1.3 setting
  delete merged.keepOnOpen;
  return merged;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Serialised read-modify-write, safe across the service worker and extension pages.
export function mutate(fn) {
  return navigator.locks.request('tab-stash-state', async () => {
    const state = await getState();
    const result = await fn(state);
    await chrome.storage.local.set({ state });
    return result;
  });
}

export function ensureGroup(state, name, color, parentId = null) {
  let g = state.groups.find((x) => x.name === name && (x.parentId ?? null) === parentId);
  if (!g) {
    g = {
      id: uid(),
      name,
      color: color && COLOR_HEX[color] ? color : AUTO_COLORS[state.groups.length % AUTO_COLORS.length],
      parentId,
      collapsed: false,
    };
    state.groups.push(g);
  }
  return g;
}

// ---------- IndexedDB: thumbnails ----------
// 'thumbs' : stash item id -> Blob
// 'live'   : browser tab id -> { blob, url, ts }   (rolling cache of open tabs)
// 'snapshots': snapshot id -> { id, ts, kind, label, ... }   (safety snapshots)
// 'meta'   : misc keys (e.g. the auto-backup file handle)

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tab-stash', 2);
    req.onupgradeneeded = () => {
      for (const name of ['thumbs', 'live', 'snapshots', 'meta']) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const idbGet = (s, k) => tx(s, 'readonly', (st) => st.get(k));
export const idbPut = (s, k, v) => tx(s, 'readwrite', (st) => st.put(v, k));
export const idbDel = (s, k) => tx(s, 'readwrite', (st) => st.delete(k));
export const idbClear = (s) => tx(s, 'readwrite', (st) => st.clear());
export const idbKeys = (s) => tx(s, 'readonly', (st) => st.getAllKeys());
