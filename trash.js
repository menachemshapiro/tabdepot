// "Recently deleted": an opt-in safety net. When the setting is on, tabs you delete are kept (without
// their thumbnails, which are fetched again on restore) for 30 days. Stored locally in IndexedDB.

import { getSettings, getState, mutate, idbGet, idbPut, dupKey } from './common.js';

export const TRASH_DAYS = 30;
const KEY = 'trash';
const load = async () => (await idbGet('meta', KEY)) || [];

export async function addToTrash(items) {
  if (!items.length || !(await getSettings()).keepDeleted) return;
  const list = await load();
  const now = Date.now();
  for (const it of items) {
    const i = list.findIndex((e) => e.item.id === it.id);
    if (i >= 0) list.splice(i, 1);
    list.unshift({ item: it, deletedAt: now });
  }
  await idbPut('meta', KEY, list);
}

export async function purgeTrash(now = Date.now()) {
  const list = await load();
  const keep = list.filter((e) => now - e.deletedAt < TRASH_DAYS * 86400000);
  if (keep.length !== list.length) await idbPut('meta', KEY, keep);
  return keep;
}

// Newest first. Entries whose tab is back in the stash (for example after Undo) are left out.
export async function listTrash() {
  const [list, state] = await Promise.all([purgeTrash(), getState()]);
  const live = new Set(state.items.map((i) => i.id));
  return list.filter((e) => !live.has(e.item.id));
}

// ids: item ids to bring back (default all). Returns how many were restored.
export async function restoreFromTrash(ids = null) {
  const list = await load();
  const want = ids ? new Set(ids) : null;
  const take = list.filter((e) => !want || want.has(e.item.id));
  let restored = 0;
  await mutate((state) => {
    const have = new Set(state.items.map((i) => i.id));
    const keys = new Set(state.items.map((i) => dupKey(i.url)));
    const groups = new Set(state.groups.map((g) => g.id));
    for (const { item } of take) {
      if (have.has(item.id) || keys.has(dupKey(item.url))) continue;
      state.items.push({ ...item, groupIds: (item.groupIds || []).filter((g) => groups.has(g)) });
      restored++;
    }
  });
  const gone = new Set(take.map((e) => e.item.id));
  await idbPut('meta', KEY, list.filter((e) => !gone.has(e.item.id)));
  return restored;
}

// ids: item ids to drop for good (default everything).
export async function deleteFromTrash(ids = null) {
  const list = await load();
  const want = ids ? new Set(ids) : null;
  await idbPut('meta', KEY, want ? list.filter((e) => !want.has(e.item.id)) : []);
}
