// Backup files: build (with or without thumbnails), parse and merge (old and new formats).

import { mutate, ensureGroup, dupKey, uid, idbGet, idbPut, normalizeState } from './common.js';

export const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

// items: the items to include. allGroups: include every group (whole-stash backups).
export async function buildBackup(state, items, { thumbs = true, allGroups = false } = {}) {
  const used = new Set();
  const addWithAncestors = (id) => {
    for (let g = state.groups.find((x) => x.id === id); g && !used.has(g.id); g = state.groups.find((x) => x.id === g.parentId)) used.add(g.id);
  };
  if (allGroups) state.groups.forEach((g) => used.add(g.id));
  else items.forEach((i) => i.groupIds.forEach(addWithAncestors));
  const out = [];
  for (const it of items) {
    const copy = { ...it };
    if (thumbs) {
      try {
        const blob = await idbGet('thumbs', it.id);
        if (blob) copy.thumb = await blobToDataUrl(blob);
      } catch {
        /* no thumbnail */
      }
    }
    out.push(copy);
  }
  return {
    app: 'tab-stash',
    version: 3,
    exportedAt: new Date().toISOString(),
    groups: state.groups.filter((g) => used.has(g.id)),
    orders: allGroups ? state.orders : {},
    items: out,
  };
}

// Accepts a Tab Stash backup (any version) or any text containing links.
export function parseBackup(text) {
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.items)) {
      const items = data.items.filter((i) => i && typeof i.url === 'string' && /^[a-z-]+:/i.test(i.url));
      return normalizeState({ items, groups: Array.isArray(data.groups) ? data.groups : [], orders: data.orders || {} });
    }
  } catch {
    /* not JSON: fall through to the link list */
  }
  const urls = [...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/g) || [])];
  return urls.length ? normalizeState({ items: urls.map((url) => ({ url, title: url })), groups: [], orders: {} }) : null;
}

// Adds what is missing to `state` (in place). Groups are matched by name and parent; duplicates (by
// dupKey) only get their group memberships merged. Returns counts; thumbnails to store go to thumbsOut.
export function mergeData(state, data, thumbsOut = []) {
  const mapped = new Map();
  const mapGroup = (g) => {
    if (mapped.has(g.id)) return mapped.get(g.id);
    const parent = g.parentId ? data.groups.find((x) => x.id === g.parentId) : null;
    const found = ensureGroup(state, g.name, g.color, parent ? mapGroup(parent) : null);
    mapped.set(g.id, found.id);
    return found.id;
  };
  data.groups.forEach(mapGroup);

  const byKey = new Map(state.items.map((i) => [dupKey(i.url), i]));
  const taken = new Set(state.items.map((i) => i.id));
  let added = 0;
  let skipped = 0;
  let n = 0;
  for (const it of data.items) {
    n++;
    const groupIds = (it.groupIds || []).map((g) => mapped.get(g)).filter(Boolean);
    const existing = byKey.get(dupKey(it.url));
    if (existing) {
      for (const g of groupIds) if (!existing.groupIds.includes(g)) existing.groupIds.push(g);
      skipped++;
      continue;
    }
    const { thumb, ...rest } = it;
    const id = !rest.id || taken.has(rest.id) ? uid() : rest.id;
    const item = { title: it.url, description: '', ogImage: '', note: '', addedAt: Date.now(), order: n, ...rest, id, groupIds };
    state.items.push(item);
    byKey.set(dupKey(it.url), item);
    taken.add(id);
    added++;
    if (typeof thumb === 'string' && thumb.startsWith('data:image/')) thumbsOut.push([id, thumb]);
  }
  return { added, skipped };
}

export async function importBackup(data) {
  let result;
  await mutate(async (state) => {
    const thumbs = [];
    result = mergeData(state, data, thumbs);
    for (const [id, url] of thumbs) {
      try {
        await idbPut('thumbs', id, await (await fetch(url)).blob());
      } catch {
        /* skip bad thumbnail */
      }
    }
  });
  return result;
}
