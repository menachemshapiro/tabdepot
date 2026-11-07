// Every change to the stash goes through here. Each operation returns its own "undo", computed from
// the values it overwrote, so undoing one action never touches anything else (for example tabs that
// were stashed afterwards).

import { mutate, ensureGroup, descendantIds, dupKey, hostOf } from './common.js';
import { takeStashSnapshot } from './snapshots.js';

export const undoStack = [];
const MAX_UNDO = 60;

// fn(state) mutates the state and returns an undo function (or { result, undo }).
export async function perform(label, fn, { snapshot = false } = {}) {
  if (snapshot) await takeStashSnapshot(`before: ${label}`).catch(() => {});
  let undo = null;
  let result;
  await mutate((state) => {
    const r = fn(state);
    if (typeof r === 'function') undo = r;
    else if (r) {
      undo = r.undo || null;
      result = r.result;
    }
  });
  if (undo) {
    undoStack.push({ label, undo });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }
  return result;
}

export async function undoLast() {
  const entry = undoStack.pop();
  if (!entry) return null;
  await mutate((state) => entry.undo(state));
  return entry.label;
}

const groupExists = (state, id) => state.groups.some((g) => g.id === id);

// ---------------- memberships ----------------

// replace: exact list of groups; add / remove: relative changes.
export function changeMembership(ids, { add = [], remove = [], replace = null }, label = 'change groups') {
  const set = new Set(ids);
  return perform(label, (state) => {
    const prev = new Map();
    for (const it of state.items) {
      if (!set.has(it.id)) continue;
      prev.set(it.id, [...it.groupIds]);
      let g = replace ? [...replace] : [...it.groupIds];
      for (const a of add) if (!g.includes(a)) g.push(a);
      it.groupIds = g.filter((x) => !remove.includes(x));
    }
    return (s) => {
      for (const it of s.items) if (prev.has(it.id)) it.groupIds = prev.get(it.id).filter((g) => groupExists(s, g));
    };
  });
}
// Move tabs to a group (null = Ungrouped). Tabs that are in `from` just leave that group (so a tab that also
// lives in other groups stays there); tabs that are not in `from`, or when there is no `from`, leave every group.
export function moveItems(ids, gid, from = null) {
  const set = new Set(ids);
  return perform(gid ? 'move to group' : 'move to Ungrouped', (state) => {
    const prev = new Map();
    for (const it of state.items) {
      if (!set.has(it.id)) continue;
      prev.set(it.id, [...it.groupIds]);
      const rest = from && it.groupIds.includes(from) ? it.groupIds.filter((g) => g !== from) : [];
      it.groupIds = gid ? [...new Set([...rest, gid])] : rest;
    }
    return (s) => {
      for (const it of s.items) if (prev.has(it.id)) it.groupIds = prev.get(it.id).filter((g) => groupExists(s, g));
    };
  });
}
export const addToGroups = (ids, gids) => changeMembership(ids, { add: gids }, 'add to group');
export const removeFromGroup = (ids, gid) => changeMembership(ids, { remove: [gid] }, 'remove from group');
export const moveToGroup = (ids, gid) => changeMembership(ids, { replace: gid ? [gid] : [] }, gid ? 'move to group' : 'move to Ungrouped');

// ---------------- groups ----------------

export function createGroup({ name, color, parentId = null }) {
  return perform('create group', (state) => {
    const before = state.groups.length;
    const g = ensureGroup(state, name, color, parentId);
    if (color) g.color = color;
    const created = state.groups.length !== before;
    return {
      result: g.id,
      undo: created
        ? (s) => {
            s.groups = s.groups.filter((x) => x.id !== g.id);
            for (const it of s.items) it.groupIds = it.groupIds.filter((x) => x !== g.id);
          }
        : null,
    };
  });
}

export function updateGroup(id, patch) {
  return perform('edit group', (state) => {
    const g = state.groups.find((x) => x.id === id);
    if (!g) return null;
    const prev = { name: g.name, color: g.color, parentId: g.parentId };
    if ('parentId' in patch && patch.parentId !== g.parentId) {
      const bad = patch.parentId === id || (patch.parentId && descendantIds(state.groups, id).includes(patch.parentId));
      if (bad) delete patch.parentId; // a group cannot go inside itself
    }
    Object.assign(g, patch);
    return (s) => {
      const x = s.groups.find((y) => y.id === id);
      if (x) Object.assign(x, prev);
    };
  });
}

// Subgroups move up to the deleted group's parent; its tabs just lose that membership.
export function deleteGroup(id) {
  return perform('delete group', (state) => {
    const g = state.groups.find((x) => x.id === id);
    if (!g) return null;
    const saved = { ...g };
    const index = state.groups.indexOf(g);
    const kids = state.groups.filter((x) => x.parentId === id);
    const kidIds = kids.map((k) => k.id);
    const members = state.items.filter((i) => i.groupIds.includes(id)).map((i) => i.id);
    const order = state.orders[id];
    for (const k of kids) k.parentId = g.parentId;
    for (const it of state.items) it.groupIds = it.groupIds.filter((x) => x !== id);
    state.groups = state.groups.filter((x) => x.id !== id);
    delete state.orders[id];
    return (s) => {
      s.groups.splice(Math.min(index, s.groups.length), 0, saved);
      for (const k of s.groups) if (kidIds.includes(k.id)) k.parentId = id;
      for (const it of s.items) if (members.includes(it.id) && !it.groupIds.includes(id)) it.groupIds.push(id);
      if (order) s.orders[id] = order;
    };
  }, { snapshot: true });
}

// Reorder / re-nest a group. Put it in `parentId`, before/after a sibling if given.
export function moveGroup(id, { parentId = null, beforeId = null, afterId = null }) {
  return perform('move group', (state) => {
    const g = state.groups.find((x) => x.id === id);
    if (!g) return null;
    if (parentId === id || (parentId && descendantIds(state.groups, id).includes(parentId))) return null;
    const prevOrder = state.groups.map((x) => x.id);
    const prevParent = g.parentId;
    state.groups = state.groups.filter((x) => x !== g);
    g.parentId = parentId;
    let at = state.groups.length;
    if (beforeId) at = state.groups.findIndex((x) => x.id === beforeId);
    else if (afterId) at = state.groups.findIndex((x) => x.id === afterId) + 1 || state.groups.length;
    if (at < 0) at = state.groups.length;
    state.groups.splice(at, 0, g);
    return (s) => {
      const map = new Map(s.groups.map((x) => [x.id, x]));
      const me = map.get(id);
      if (me) me.parentId = prevParent;
      s.groups = [...prevOrder.map((i) => map.get(i)).filter(Boolean), ...s.groups.filter((x) => !prevOrder.includes(x.id))];
    };
  });
}

// Not undoable (pure view state).
export function setGroupFlag(id, key, value) {
  return mutate((state) => {
    const g = state.groups.find((x) => x.id === id);
    if (g) g[key] = value;
  });
}

// ---------------- manual card order ----------------

export function setOrder(key, ids) {
  return perform('reorder', (state) => {
    const had = Object.hasOwn(state.orders, key);
    const prev = state.orders[key];
    state.orders[key] = ids;
    return (s) => {
      if (had) s.orders[key] = prev;
      else delete s.orders[key];
    };
  });
}

// ---------------- items ----------------

export function deleteItems(ids, label = 'delete') {
  const set = new Set(ids);
  return perform(label, (state) => {
    const removed = state.items.filter((i) => set.has(i.id)).map((i) => structuredClone(i));
    state.items = state.items.filter((i) => !set.has(i.id));
    return {
      result: removed.length,
      undo: removed.length
        ? (s) => {
            for (const it of removed) {
              if (s.items.some((x) => x.id === it.id)) continue;
              it.groupIds = it.groupIds.filter((g) => groupExists(s, g));
              s.items.push(it);
            }
          }
        : null,
    };
  }, { snapshot: label === 'delete' && ids.length >= 5 });
}

export function editItem(id, patch) {
  return perform('edit', (state) => {
    const it = state.items.find((x) => x.id === id);
    if (!it) return null;
    const prev = {};
    for (const k of Object.keys(patch)) prev[k] = structuredClone(it[k]);
    Object.assign(it, patch);
    return (s) => {
      const x = s.items.find((y) => y.id === id);
      if (x) Object.assign(x, prev);
    };
  });
}

export function setNote(ids, text, { append = false } = {}) {
  const set = new Set(ids);
  return perform('note', (state) => {
    const prev = new Map();
    for (const it of state.items) {
      if (!set.has(it.id)) continue;
      prev.set(it.id, it.note || '');
      it.note = append && it.note ? `${it.note}\n${text}` : text;
    }
    return (s) => {
      for (const it of s.items) if (prev.has(it.id)) it.note = prev.get(it.id);
    };
  });
}

// Merge links that point at the same page (see dupKey). Keeps the newest, unions groups and notes.
export function removeDuplicates() {
  return perform('remove duplicates', (state) => {
    const buckets = new Map();
    for (const it of state.items) {
      const k = dupKey(it.url);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(it);
    }
    const removed = [];
    const changedKept = new Map();
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.groupIds.length - a.groupIds.length || b.addedAt - a.addedAt);
      const [keep, ...rest] = list;
      changedKept.set(keep.id, { groupIds: [...keep.groupIds], note: keep.note || '' });
      for (const dup of rest) {
        for (const g of dup.groupIds) if (!keep.groupIds.includes(g)) keep.groupIds.push(g);
        if (!keep.note && dup.note) keep.note = dup.note;
        removed.push(structuredClone(dup));
      }
    }
    const gone = new Set(removed.map((r) => r.id));
    state.items = state.items.filter((i) => !gone.has(i.id));
    return {
      result: removed.length,
      undo: removed.length
        ? (s) => {
            for (const it of s.items) if (changedKept.has(it.id)) Object.assign(it, changedKept.get(it.id));
            for (const it of removed) if (!s.items.some((x) => x.id === it.id)) s.items.push(it);
          }
        : null,
    };
  }, { snapshot: true });
}

// A group per site that has 2+ of the given tabs (top level). Memberships are added, not replaced.
export function groupBySite(ids) {
  const set = new Set(ids);
  return perform('group by site', (state) => {
    const counts = new Map();
    for (const it of state.items) if (set.has(it.id)) counts.set(hostOf(it.url), (counts.get(hostOf(it.url)) || 0) + 1);
    const hosts = new Set([...counts].filter(([h, n]) => h && n >= 2).map(([h]) => h));
    if (!hosts.size) return { result: 0, undo: null };
    const groupsBefore = new Set(state.groups.map((g) => g.id));
    const prev = new Map();
    for (const it of state.items) {
      const host = hostOf(it.url);
      if (set.has(it.id) && hosts.has(host)) {
        prev.set(it.id, [...it.groupIds]);
        const g = ensureGroup(state, host);
        if (!it.groupIds.includes(g.id)) it.groupIds.push(g.id);
      }
    }
    const created = state.groups.filter((g) => !groupsBefore.has(g.id)).map((g) => g.id);
    return {
      result: hosts.size,
      undo: (s) => {
        s.groups = s.groups.filter((g) => !created.includes(g.id));
        const alive = new Set(s.groups.map((g) => g.id));
        for (const it of s.items) {
          if (prev.has(it.id)) it.groupIds = prev.get(it.id).filter((g) => alive.has(g));
          else it.groupIds = it.groupIds.filter((g) => alive.has(g));
        }
      },
    };
  });
}

// ---------------- link-check results (not undoable) ----------------

export function saveLinkResults(results) {
  return mutate((state) => {
    for (const it of state.items) if (results[it.id]) it.link = results[it.id];
  });
}
