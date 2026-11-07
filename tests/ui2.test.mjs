// Drag & drop, ask-mode, link checker, snapshots dialog, backup round trip.
import { launch, checker, sleep, serve } from './helpers.mjs';

export default async function () {
  const check = checker('ui2');
  const srv = await serve(8793);
  const h = await launch();
  const mk = (id, url, extra = {}) => ({ id, url, title: 'T ' + id, description: '', ogImage: '', addedAt: Date.now() - Number(id.slice(1)) * 1000, order: 0, note: '', groupIds: [], ...extra });
  const seed = {
    groups: [
      { id: 'A', name: 'Alpha', color: 'blue', parentId: null },
      { id: 'B', name: 'Beta', color: 'orange', parentId: null },
      { id: 'C', name: 'Gamma', color: 'green', parentId: null },
    ],
    items: [
      mk('i1', 'http://127.0.0.1:8793/ok.html', { groupIds: ['A'] }),
      mk('i2', 'http://127.0.0.1:8793/missing.html', { groupIds: ['A'] }),
      mk('i3', 'http://127.0.0.1:8793/plain.html', { groupIds: ['A'] }),
      mk('i4', 'http://127.0.0.1:8793/o1.html', { groupIds: [] }),
    ],
    orders: {},
  };
  const page = await h.stashPage();
  await page.evaluate((s) => chrome.storage.local.set({ state: s, settings: { fetchThumbs: false, openMode: 'ask', snapshots: true } }), seed);
  await page.reload();
  await sleep(700);
  const count = (sel) => page.$$eval(sel, (els) => els.length);
  const st = () => page.evaluate(async () => { const s = await (await import('./common.js')).getState(); return s; });

  // synthetic drag helper (real DragEvents with a DataTransfer)
  const dnd = (fromSel, toSel, opts = {}) =>
    page.evaluate((fromSel, toSel, opts) => {
      const from = document.querySelector(fromSel);
      const to = document.querySelector(toSel);
      const dt = new DataTransfer();
      const rect = to.getBoundingClientRect();
      const pos = { clientX: rect.left + rect.width * (opts.x ?? 0.5), clientY: rect.top + rect.height * (opts.y ?? 0.5), ctrlKey: !!opts.ctrl };
      const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }));
      fire(from, 'dragstart');
      fire(to, 'dragover', pos);
      fire(to, 'drop', pos);
      fire(from, 'dragend');
    }, fromSel, toSel, opts);

  // ---- ask mode: clicking a card shows the choice
  await page.evaluate(() => document.querySelector('.card[data-id="i4"]').click());
  await sleep(300);
  const menu = await page.$$eval('.menu .menu-item', (b) => b.map((x) => x.textContent));
  check('ask mode shows both choices', menu.length === 2 && /remove/.test(menu[0]) && /keep/.test(menu[1]), JSON.stringify(menu) + ' cards=' + (await count('.card')));
  await page.keyboard.press('Escape');
  await page.mouse.click(600, 600); await sleep(200);

  // ---- drag a card to another group in the sidebar = move; with Ctrl = copy
  await dnd('.section[data-key="A"] .card[data-id="i1"]', '#side .nav[data-gid="B"]');
  await sleep(700);
  let s = await st();
  check('drag card onto group moves it', JSON.stringify(s.items.find((i) => i.id === 'i1').groupIds) === '["B"]');
  await dnd('.section[data-key="A"] .card[data-id="i2"]', '#side .nav[data-gid="C"]', { ctrl: true });
  await sleep(700);
  s = await st();
  check('Ctrl+drag copies instead of moving', JSON.stringify(s.items.find((i) => i.id === 'i2').groupIds.sort()) === '["A","C"]');

  // ---- menu: "Move to" leaves other groups, "Add to" keeps them
  await page.evaluate(() => { const a = document.querySelector('.card[data-id="i2"] .chk'); a.click(); });
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('#selbar .tb')].find((b) => /^\s*Move to/.test(b.textContent)).click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.menu-item')].find((b) => /Beta/.test(b.textContent)).click());
  await sleep(700);
  s = await st();
  check('"Move to…" really moves (leaves other groups)', JSON.stringify(s.items.find((i) => i.id === 'i2').groupIds) === '["B"]', JSON.stringify(s.items.find((i) => i.id === 'i2').groupIds));
  await page.evaluate(() => { const a = document.querySelector('.card[data-id="i2"] .chk'); if (!a.checked) a.click(); });
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('#selbar .tb')].find((b) => /Add to/.test(b.textContent)).click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.menu-item')].find((b) => /Alpha/.test(b.textContent)).click());
  await sleep(700);
  s = await st();
  check('"Add to…" keeps the existing groups', JSON.stringify(s.items.find((i) => i.id === 'i2').groupIds.sort()) === '["A","B"]', JSON.stringify(s.items.find((i) => i.id === 'i2').groupIds));
  await page.keyboard.press('Escape'); await sleep(200);
  await page.evaluate(async () => { const m = await import('./model.js'); await m.changeMembership(['i2'], { replace: ['A', 'C'] }); });
  await sleep(500);

  // ---- dragging a selection that spans several sections moves every card, not only the dragged one's group
  await page.evaluate(() => { document.querySelector('.section[data-key="A"] .card[data-id="i3"] .chk').click(); document.querySelector('.section[data-key="B"] .card[data-id="i1"] .chk').click(); });
  await sleep(200);
  await dnd('.section[data-key="A"] .card[data-id="i3"]', '#side .nav[data-gid="C"]');
  await sleep(700);
  s = await st();
  check('dragging a mixed selection moves all of it', JSON.stringify([s.items.find((i) => i.id === 'i3').groupIds, s.items.find((i) => i.id === 'i1').groupIds]) === '[["C"],["C"]]', JSON.stringify(s.items.map((i) => [i.id, i.groupIds])));
  await page.keyboard.press('Escape'); await sleep(200);
  await page.evaluate(async () => { const m = await import('./model.js'); await m.changeMembership(['i3'], { replace: ['A'] }); await m.changeMembership(['i1'], { replace: ['B'] }); });
  await sleep(500);

  // ---- reorder inside a section
  await dnd('.section[data-key="A"] .card[data-id="i3"]', '.section[data-key="A"] .card[data-id="i2"]', { x: 0.2 });
  await sleep(700);
  s = await st();
  check('reorder saves manual order', JSON.stringify(s.orders.A) === '["i3","i2"]', JSON.stringify(s.orders));
  check('reorder switches sort to manual', (await page.$eval('#sort', (e) => e.value)) === 'manual');
  check('cards follow the manual order', (await page.$$eval('.section[data-key="A"] .card', (c) => c.map((x) => x.dataset.id))).join() === 'i3,i2');

  // ---- nest a group by dropping on the middle of another row; reorder with edge zone
  await dnd('#side .nav[data-gid="C"]', '#side .nav[data-gid="B"]', { y: 0.5 });
  await sleep(700);
  s = await st();
  check('drag group onto another nests it', s.groups.find((g) => g.id === 'C').parentId === 'B');
  await dnd('#side .nav[data-gid="C"]', '#side .nav[data-gid="A"]', { y: 0.05 });
  await sleep(700);
  s = await st();
  check('drag group to the top edge reorders it', s.groups.find((g) => g.id === 'C').parentId === null && s.groups.map((g) => g.id).join() === 'C,A,B');

  // ---- undo of the above group moves
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(600);
  s = await st();
  check('undo reverts the last group move', s.groups.find((g) => g.id === 'C').parentId === 'B');

  // ---- link checker against the local server
  await page.evaluate(async () => {
    const a = await import('./actions.js');
    const { getState } = await import('./common.js');
    await a.runLinkCheck((await getState()).items);
  });
  await sleep(500);
  s = await st();
  const link = Object.fromEntries(s.items.map((i) => [i.id, i.link?.status]));
  check('link checker: working page ok', link.i1 === 'ok', JSON.stringify(link));
  check('link checker: 404 is dead', link.i2 === 'dead', JSON.stringify(link));
  await page.bringToFront();
  await sleep(500);
  check('dead badge shown after check', (await count('.card[data-id="i2"] .badge.dead')) >= 1);

  // ---- snapshots dialog
  await page.evaluate(async () => {
    const snaps = await import('./snapshots.js');
    await snaps.takeStashSnapshot('test snapshot');
    const model = await import('./model.js');
    await model.deleteItems(['i3', 'i4']);
    const ui = await import('./snapui.js');
    await ui.openSnapshots('stash');
  });
  await sleep(500);
  const rows = await page.$$eval('#snapRoot .snap-row', (r) => r.map((x) => x.textContent));
  check('snapshots dialog lists snapshots', rows.some((t) => /test snapshot/.test(t)), rows.join(' | '));
  await page.evaluate(() => [...document.querySelectorAll('#snapRoot .snap-row')].find((r) => /test snapshot/.test(r.textContent)).querySelector('button').click());
  await sleep(900);
  s = await st();
  check('"add back what is missing" restores deleted tabs', s.items.some((i) => i.id === 'i3' || i.url.endsWith('plain.html')) && s.items.length === 4, s.items.map((i) => i.id).join());

  // ---- backup round trip (v3 file: subgroups + multi-membership survive)
  const rt = await page.evaluate(async () => {
    const common = await import('./common.js');
    const b = await import('./backup.js');
    const state = await common.getState();
    const file = JSON.stringify(await b.buildBackup(state, state.items, { thumbs: false, allGroups: true }));
    await chrome.storage.local.set({ state: { items: [], groups: [], orders: {} } });
    const data = b.parseBackup(file);
    const res = await b.importBackup(data);
    const after = await common.getState();
    return { res, items: after.items.length, groups: after.groups.map((g) => g.name + ':' + (after.groups.find((p) => p.id === g.parentId)?.name || '')).sort(), multi: after.items.filter((i) => i.groupIds.length > 1).length };
  });
  check('backup round trip keeps items, nesting and multi-membership', rt.items === 4 && rt.groups.includes('Gamma:Beta') && rt.multi === 1, JSON.stringify(rt));
  const old = await page.evaluate(async () => {
    const b = await import('./backup.js');
    const d = b.parseBackup(JSON.stringify({ app: 'tab-stash', version: 2, groups: [{ id: 'g', name: 'Old', color: 'red' }], items: [{ id: 'x', url: 'https://old.example/', title: 'o', groupId: 'g' }] }));
    return { groups: d.groups.length, ids: d.items[0].groupIds };
  });
  check('old (v2) backup files still import', old.groups === 1 && old.ids.length === 1);

  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  srv.close();
  return check.failed();
}
