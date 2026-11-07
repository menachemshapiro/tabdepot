// Safety snapshots.
//  - 'stash' snapshots: a copy of the stash (items, groups, order) taken automatically every 30 min
//    when something changed, and before risky operations (bulk delete, import, duplicate removal...).
//  - 'tabs' snapshots: the list of open windows/tabs every 10 min (when changed) and when a window
//    closes, so an accidental window close or a crash is recoverable.
// Thumbnails are not copied (they are re-fetched if needed). Kept locally in IndexedDB.

import { mergeData } from './backup.js';
import {
  getState,
  getSettings,
  mutate,
  normalizeState,
  ensureGroup,
  dupKey,
  uid,
  isStashableUrl,
  idbGet,
  idbPut,
  idbDel,
} from './common.js';

const LIMIT = { stash: 40, tabs: 30 };
const withLock = (fn) => navigator.locks.request('tab-stash-snapshots', fn);

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const stashSignature = (s) =>
  hash(s.items.map((i) => `${i.id}|${i.groupIds.join(',')}|${(i.note || '').length}|${(i.title || '').length}`).join(';') +
    s.groups.map((g) => `${g.id}|${g.name}|${g.parentId}`).join(';'));

const readIndex = async () => (await idbGet('meta', 'snapshotIndex')) || [];

async function addSnapshot(snap) {
  await withLock(async () => {
    const { data, ...info } = snap;
    await idbPut('snapshots', snap.id, snap);
    const index = [info, ...(await readIndex())];
    const seen = {};
    const keep = [];
    for (const i of index) {
      seen[i.kind] = (seen[i.kind] || 0) + 1;
      if (seen[i.kind] <= (LIMIT[i.kind] || 30)) keep.push(i);
      else await idbDel('snapshots', i.id);
    }
    await idbPut('meta', 'snapshotIndex', keep);
  });
}

export async function listSnapshots(kind) {
  return (await readIndex()).filter((i) => !kind || i.kind === kind);
}
export const getSnapshot = (id) => idbGet('snapshots', id);

export async function deleteSnapshot(id) {
  await withLock(async () => {
    await idbDel('snapshots', id);
    await idbPut('meta', 'snapshotIndex', (await readIndex()).filter((i) => i.id !== id));
  });
}

// ---- stash snapshots ----

export async function takeStashSnapshot(label, { auto = false, minGapMs = 0 } = {}) {
  if (!(await getSettings()).snapshots) return null;
  const state = await getState();
  if (!state.items.length && !state.groups.length) return null;
  const sig = stashSignature(state);
  const [last] = await listSnapshots('stash');
  if (last && last.sig === sig) return null; // nothing changed since the last one
  if (auto && last && Date.now() - last.ts < minGapMs) return null;
  const snap = {
    id: uid(),
    ts: Date.now(),
    kind: 'stash',
    label,
    sig,
    items: state.items.length,
    groups: state.groups.length,
    data: { items: state.items, groups: state.groups, orders: state.orders },
  };
  await addSnapshot(snap);
  return snap.id;
}

// mode: 'replace' (make the stash exactly like the snapshot) or 'merge' (add what is missing)
export async function restoreStashSnapshot(id, mode = 'merge') {
  const snap = await getSnapshot(id);
  if (!snap) throw new Error('Snapshot not found');
  await takeStashSnapshot('before restoring a snapshot');
  const data = normalizeState(structuredClone(snap.data));
  await mutate((state) => {
    if (mode === 'replace') {
      state.items = data.items;
      state.groups = data.groups;
      state.orders = data.orders;
      return;
    }
    mergeData(state, data);
  });
}

// ---- open-tabs snapshots ----

async function chromeGroupInfo() {
  const info = new Map();
  try {
    for (const g of await chrome.tabGroups.query({})) info.set(g.id, { title: g.title || '', color: g.color });
  } catch {
    /* tabGroups unavailable */
  }
  return info;
}

export async function windowsData() {
  const groups = await chromeGroupInfo();
  const windows = [];
  for (const w of await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })) {
    const tabs = (w.tabs || [])
      .map((t) => ({ url: t.url || t.pendingUrl || '', title: t.title || '', pinned: !!t.pinned, group: groups.get(t.groupId)?.title || '' }))
      .filter((t) => isStashableUrl(t.url));
    if (tabs.length) windows.push({ id: w.id, tabs });
  }
  return windows;
}

const tabsSignature = (windows) => hash(windows.map((w) => w.tabs.map((t) => t.url).join('\n')).join('\n--\n'));

export async function takeTabsSnapshot(label = 'automatic', windows = null) {
  if (!(await getSettings()).snapshots) return null;
  windows ||= await windowsData();
  const total = windows.reduce((n, w) => n + w.tabs.length, 0);
  if (!total) return null;
  const sig = tabsSignature(windows);
  const [last] = await listSnapshots('tabs');
  if (last && last.sig === sig && label === 'automatic') return null;
  const snap = { id: uid(), ts: Date.now(), kind: 'tabs', label, sig, windows: windows.length, tabs: total, data: { windows } };
  await addSnapshot(snap);
  return snap.id;
}
