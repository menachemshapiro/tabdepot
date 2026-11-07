// Data model: migration, groups/subgroups, multi-membership, undo for every operation, duplicate
// detection, snapshots. Runs the real modules inside an extension page.
import { launch, checker } from './helpers.mjs';

export default async function () {
  const check = checker('model');
  const h = await launch();
  const page = await h.browser.newPage();
  h.watch(page, 'page');
  await page.goto(`chrome-extension://${h.extId}/popup.html`);

  const r = await page.evaluate(async () => {
    const common = await import('./common.js');
    const model = await import('./model.js');
    const snaps = await import('./snapshots.js');
    const out = {};
    const get = async () => (await common.getState());
    const mk = (id, url, extra = {}) => ({ id, url, title: id, description: '', ogImage: '', addedAt: Date.now(), order: 0, note: '', ...extra });

    // ---- migration from the pre-1.3 shape (single groupId, no parentId)
    await chrome.storage.local.set({ state: { items: [mk('a', 'https://a.com/x', { groupId: 'g1' }), mk('b', 'https://b.com/', { groupId: 'gone' }), mk('c', 'https://c.com/')], groups: [{ id: 'g1', name: 'Old', color: 'blue', collapsed: false }] } });
    let s = await get();
    out.migrated = { a: s.items[0].groupIds, b: s.items[1].groupIds, parent: s.groups[0].parentId, hasOld: 'groupId' in s.items[0], orders: typeof s.orders };

    // ---- groups and subgroups
    const A = await model.createGroup({ name: 'A', color: 'red' });
    const A1 = await model.createGroup({ name: 'A1', parentId: A });
    const A2 = await model.createGroup({ name: 'A2', parentId: A });
    s = await get();
    out.tree = common.flattenGroups(s.groups).map((x) => `${'-'.repeat(x.depth)}${x.group.name}`);
    out.path = common.groupPath(s.groups, A2);
    out.desc = common.descendantIds(s.groups, A).length;
    await model.updateGroup(A, { parentId: A1 }); // would create a cycle -> ignored
    s = await get();
    out.cycleBlocked = s.groups.find((g) => g.id === A).parentId === null;

    // ---- an item in several groups; add/remove/move + undo
    await model.addToGroups(['a'], [A1, A2]);
    s = await get();
    out.multi = s.items[0].groupIds.length; // g1, A1, A2
    await model.removeFromGroup(['a'], A1);
    out.afterRemove = (await get()).items[0].groupIds.includes(A1);
    await model.undoLast();
    out.undoRemove = (await get()).items[0].groupIds.includes(A1);
    await model.moveToGroup(['a'], A2);
    out.moved = (await get()).items[0].groupIds.join();
    await model.undoLast();
    out.undoMove = (await get()).items[0].groupIds.length;

    // ---- delete a group that has subgroups, then undo
    await model.deleteGroup(A);
    s = await get();
    out.afterDelGroup = { names: s.groups.map((g) => g.name).sort().join(), a1Parent: s.groups.find((g) => g.id === A1).parentId, aHasA1: s.items[0].groupIds.includes(A) };
    await model.undoLast();
    s = await get();
    out.undoDelGroup = { names: s.groups.map((g) => g.name).sort().join(), a1Parent: s.groups.find((g) => g.id === A1).parentId === A };

    // ---- reorder groups
    await model.moveGroup(A2, { parentId: A, beforeId: A1 });
    out.orderAfter = common.flattenGroups((await get()).groups).map((x) => x.group.name).join();
    await model.undoLast();
    out.orderUndo = common.flattenGroups((await get()).groups).map((x) => x.group.name).join();
    await model.moveGroup(A, { parentId: A2 }); // into own child -> refused
    out.moveIntoChild = (await get()).groups.find((g) => g.id === A).parentId;

    // ---- manual card order
    await model.setOrder(A, ['c', 'a']);
    out.order = (await get()).orders[A];
    await model.undoLast();
    out.orderGone = A in (await get()).orders;

    // ---- delete + undo, notes + undo
    await model.deleteItems(['c']);
    out.deleted = (await get()).items.length;
    await model.undoLast();
    out.undeleted = (await get()).items.length;
    await model.setNote(['a', 'b'], 'hello');
    await model.setNote(['a'], 'more', { append: true });
    out.note = (await get()).items.find((i) => i.id === 'a').note;
    await model.undoLast(); await model.undoLast();
    out.noteUndone = (await get()).items.find((i) => i.id === 'a').note;

    // ---- smarter duplicate detection
    const keys = [
      ['https://www.example.com/page/?utm_source=x&b=2&a=1#top', 'http://example.com/page?a=1&b=2'],
      ['https://youtu.be/dQw4w9WgXcQ?t=42', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&si=abc'],
      ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
      ['https://example.com/a', 'https://example.com/b'],
      ['https://example.com/?q=1', 'https://example.com/?q=2'],
      ['https://app.example.com/#/inbox', 'https://app.example.com/#/sent'],
    ].map(([x, y]) => common.dupKey(x) === common.dupKey(y));
    out.dupKeys = keys; // true,true,true,false,false,false
    await chrome.storage.local.set({ state: { items: [
      mk('d1', 'https://www.example.com/p?utm_source=n', { groupIds: [A1], addedAt: 1, note: 'keep me' }),
      mk('d2', 'http://example.com/p', { groupIds: [A2], addedAt: 2 }),
      mk('d3', 'https://youtu.be/dQw4w9WgXcQ?t=5', { addedAt: 3 }),
      mk('d4', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', { addedAt: 4 }),
      mk('d5', 'https://other.com/', { addedAt: 5 }),
    ], groups: (await get()).groups, orders: {} } });
    const n = await model.removeDuplicates();
    s = await get();
    const kept = s.items.find((i) => i.url.includes('example.com/p'));
    out.dedupe = { removed: n, left: s.items.length, mergedGroups: kept.groupIds.length, note: kept.note };
    await model.undoLast();
    out.dedupeUndo = (await get()).items.length;

    // ---- group by site + undo
    await chrome.storage.local.set({ state: { items: [mk('s1', 'https://news.com/1'), mk('s2', 'https://news.com/2'), mk('s3', 'https://solo.com/')], groups: [], orders: {} } });
    const made = await model.groupBySite(['s1', 's2', 's3']);
    s = await get();
    out.bySite = { made, names: s.groups.map((g) => g.name), s1: s.items[0].groupIds.length, s3: s.items[2].groupIds.length };
    await model.undoLast();
    s = await get();
    out.bySiteUndo = { groups: s.groups.length, s1: s.items[0].groupIds.length };

    // ---- snapshots: take, change, restore (merge + replace)
    await chrome.storage.local.set({ state: { items: [mk('p1', 'https://one.com/'), mk('p2', 'https://two.com/')], groups: [], orders: {} } });
    const id1 = await snaps.takeStashSnapshot('test');
    out.snapTwice = await snaps.takeStashSnapshot('same state again'); // null: unchanged
    await model.deleteItems(['p1']);
    await chrome.storage.local.get('state');
    await snaps.restoreStashSnapshot(id1, 'merge');
    out.merge = (await get()).items.map((i) => i.url).sort();
    await chrome.storage.local.set({ state: { items: [mk('z', 'https://zzz.com/')], groups: [], orders: {} } });
    await snaps.restoreStashSnapshot(id1, 'replace');
    out.replace = (await get()).items.map((i) => i.url).sort();
    out.snapList = (await snaps.listSnapshots('stash')).length;
    return out;
  });

  check('old single-group data migrates to groupIds / parentId', JSON.stringify(r.migrated.a) === '["g1"]' && r.migrated.b.length === 0 && r.migrated.parent === null && !r.migrated.hasOld && r.migrated.orders === 'object', JSON.stringify(r.migrated));
  check('subgroups form a tree (A > A1, A2)', r.tree.join() === 'Old,A,-A1,-A2' && r.path === 'A / A2' && r.desc === 2, JSON.stringify(r.tree));
  check('a group cannot be moved under its own child', r.cycleBlocked && r.moveIntoChild === null);
  check('one item can be in several groups', r.multi === 3, r.multi);
  check('remove from one group leaves the others; undo restores', r.afterRemove === false && r.undoRemove === true);
  check('move replaces memberships; undo restores them', r.moved.length > 0 && !r.moved.includes(',') && r.undoMove === 3, `${r.moved} / ${r.undoMove}`);
  check('deleting a group re-parents its subgroups and drops memberships', r.afterDelGroup.names === 'A1,A2,Old' && r.afterDelGroup.a1Parent === null && !r.afterDelGroup.aHasA1, JSON.stringify(r.afterDelGroup));
  check('undo of group deletion brings back group, subgroups and members', r.undoDelGroup.names === 'A,A1,A2,Old' && r.undoDelGroup.a1Parent, JSON.stringify(r.undoDelGroup));
  check('reordering groups works and undoes', r.orderAfter === 'Old,A,A2,A1' && r.orderUndo === 'Old,A,A1,A2', `${r.orderAfter} | ${r.orderUndo}`);
  check('manual card order saves and undoes', JSON.stringify(r.order) === '["c","a"]' && r.orderGone === false);
  check('delete and undo items', r.deleted === 2 && r.undeleted === 3);
  check('notes: replace, append, undo', r.note === 'hello\nmore' && r.noteUndone === '', r.note);
  check('duplicate keys: tracking params, www, http/https, order, trailing slash, YouTube variants', JSON.stringify(r.dupKeys) === '[true,true,true,false,false,false]', JSON.stringify(r.dupKeys));
  check('remove duplicates merges groups and notes; undo restores', r.dedupe.removed === 2 && r.dedupe.left === 3 && r.dedupe.mergedGroups === 2 && r.dedupe.note === 'keep me' && r.dedupeUndo === 5, JSON.stringify(r.dedupe));
  check('group by site creates one group for 2+ tabs; undo removes it', r.bySite.made === 1 && r.bySite.names.join() === 'news.com' && r.bySite.s1 === 1 && r.bySite.s3 === 0 && r.bySiteUndo.groups === 0 && r.bySiteUndo.s1 === 0, JSON.stringify([r.bySite, r.bySiteUndo]));
  check('snapshot is skipped when nothing changed', r.snapTwice === null);
  check('restore snapshot (merge) re-adds missing tabs', r.merge.join() === 'https://one.com/,https://two.com/', r.merge.join());
  check('restore snapshot (replace) makes the stash match', r.replace.join() === 'https://one.com/,https://two.com/', r.replace.join());
  check('safety snapshots are listed', r.snapList >= 2, r.snapList);
  check('no JS errors', h.errors.length === 0, h.errors.join(' | '));
  await h.close();
  return check.failed();
}
