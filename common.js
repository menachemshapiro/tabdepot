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
  keepOnOpen: false, // keep the entry in the stash after opening it
  lazyRestore: true, // restore many tabs without loading them until clicked
  autoStashDays: 0, // 0 = off
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

// ---------- state (chrome.storage.local) ----------

export async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return { items: state?.items || [], groups: state?.groups || [] };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
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

export function ensureGroup(state, name, color) {
  let g = state.groups.find((x) => x.name === name);
  if (!g) {
    g = {
      id: uid(),
      name,
      color: color && COLOR_HEX[color] ? color : AUTO_COLORS[state.groups.length % AUTO_COLORS.length],
      collapsed: false,
    };
    state.groups.push(g);
  }
  return g;
}

// ---------- IndexedDB: thumbnails ----------
// 'thumbs' : stash item id -> Blob
// 'live'   : browser tab id -> { blob, url, ts }   (rolling cache of open tabs)

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tab-stash', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('thumbs');
      req.result.createObjectStore('live');
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
