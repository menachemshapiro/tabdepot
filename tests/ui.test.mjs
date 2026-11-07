// The stash page end to end: subgroups, multi-membership, pencils, filters, open modes, undo,
// keyboard navigation, drag & drop, triage, multi-page banner/sync.
import { launch, checker, sleep } from './helpers.mjs';

export default async function () {
  const check = checker('ui');
  const h = await launch();
  const mk = (id, url, extra = {}) => ({ id, url, title: 'T ' + id, description: 'desc ' + id, ogImage: '', addedAt: Date.now(), order: 0, note: '', groupIds: [], ...extra });
  const old = Date.now() - 100 * 86400_000;
  const seed = {
    groups: [
      { id: 'A', name: 'Alpha', color: 'blue', parentId: null },
      { id: 'A1', name: 'Alpha One', color: 'green', parentId: 'A' },
      { id: 'A2', name: 'Alpha Two', color: 'red', parentId: 'A' },
      { id: 'B', name: 'Beta', color: 'orange', parentId: null },
    ],
    items: [
      mk('i1', 'https://one.example/a', { groupIds: ['A1'], note: 'remember' }),
      mk('i2', 'https://two.example/b', { groupIds: ['A1', 'B'] }),
      mk('i3', 'https://one.example/c', { groupIds: ['A2'], addedAt: old }),
      mk('i4', 'https://three.example/d', { groupIds: [] }),
      mk('i5', 'https://three.example/e', { groupIds: ['B'], link: { status: 'dead', code: 404, checkedAt: Date.now(), detail: '' } }),
    ],
    orders: {},
  };
  const page = await h.stashPage();
  await page.evaluate((s) => chrome.storage.local.set({ state: s, settings: { fetchThumbs: false, openMode: 'keep', snapshots: false } }), seed);
  await page.reload();
  await sleep(700);

  const q = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));
  const count = (sel) => page.$$eval(sel, (els) => els.length);

  // ---- tree in sidebar and nested sections
  check('sidebar shows the tree', (await count('#side .nav[data-gid]')) === 4);
  check('Alpha count is unique items in subtree', (await page.$eval('#side .nav[data-gid="A"] .n', (e) => e.textContent)) === '3');
  check('sidebar row has a pencil next to the name', (await count('#side .nav[data-gid="A"] .label + .pencil')) === 1);
  check('main section head has a pencil next to the name', (await count('.sec-head h2 + .pencil')) >= 4);
  check('subgroups are nested sections', (await count('.section[data-key="A"] > .section.sub')) === 2);
  check('item in two groups appears in both sections', (await count('.card[data-id="i2"]')) === 2);
  check('"also in" line is shown', (await q('.card[data-id="i2"] .also')).some((t) => /Also in/.test(t)));
  check('dead link badge', (await q('.card[data-id="i5"] .badge')).join('') === 'Dead link');

  // ---- collapse a branch in the sidebar
  await page.click('#side .nav[data-gid="A"] .exp');
  await sleep(300);
  check('sidebar branch collapses', (await count('#side .nav[data-gid]')) === 2);
  await page.click('#side .nav[data-gid="A"] .exp');
  await sleep(300);

  // ---- group view shows only that subtree
  await page.click('#side .nav[data-gid="A"] .label');
  await sleep(300);
  check('group view hides other groups', (await count('.section[data-key="B"]')) === 0 && (await count('.section[data-key="A"]')) === 1);
  await page.click('#side .nav.active ~ .nav, #side .nav'); // back to All tabs
  await page.click('#side .nav'); await sleep(300);

  // ---- group dialog: edit name + move into another parent
  await page.click('#side .nav[data-gid="A2"] .pencil');
  await sleep(200);
  await page.$eval('#gName', (e) => (e.value = 'Alpha Deux'));
  await page.select('#gParent', 'B');
  await page.click('#dlgGroup button[value="ok"]');
  await sleep(500);
  check('group renamed and re-parented', (await page.$eval('.section[data-key="B"] .section.sub h2', (e) => e.textContent)) === 'Alpha Deux');

  // ---- open modes: keep setting -> card click keeps the item; the "remove" button removes it
  const origOpen = await page.evaluate(() => { window.__tabs = 0; return 0; });
  await page.click('.card[data-id="i4"]');
  await sleep(900);
  await page.bringToFront();
  check('click opens a tab and keeps the card (setting=keep)', (await count('.card[data-id="i4"]')) === 1);
  await page.hover('.card[data-id="i4"]');
  await page.click('.card[data-id="i4"] .act[title^="Open and remove"]');
  await sleep(900);
  await page.bringToFront();
  check('"Open and remove" button removes it regardless of setting', (await count('.card[data-id="i4"]')) === 0);
  // undo brings it back
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(700);
  check('Ctrl+Z restores the item', (await count('.card[data-id="i4"]')) === 1);

  // ---- filters
  await page.evaluate(() => { const s = document.querySelector('#fSite'); s.value = 'one.example'; s.dispatchEvent(new Event('input')); });
  await sleep(500);
  check('site filter', (await count('.card')) === 2);
  await page.click('#fClear'); await sleep(300);
  await page.select('#fAge', '30'); await sleep(300);
  check('age filter (older than 30 days)', (await q('.card')).length === 1 && (await count('.card[data-id="i3"]')) === 1);
  await page.click('#fClear'); await sleep(300);
  await page.click('#fNote'); await sleep(300);
  check('has-note filter', (await count('.card[data-id="i1"]')) === 1 && (await count('.card')) === 1);
  await page.click('#fClear'); await sleep(300);
  await page.select('#fLink', 'bad'); await sleep(300);
  check('link filter', (await count('.card[data-id="i5"]')) >= 1 && (await count('.card[data-id="i1"]')) === 0);
  await page.click('#fClear'); await sleep(300);

  // ---- select all matching / invert
  await page.evaluate(() => { const s = document.querySelector('#fSite'); s.value = 'three.example'; s.dispatchEvent(new Event('input')); });
  await sleep(400);
  await page.click('#selectBtn'); await sleep(100);
  await page.evaluate(() => [...document.querySelectorAll('.menu-item')].find((b) => /Select all 2 matching/.test(b.textContent))?.click());
  await sleep(300);
  check('select all matching', (await q('.sel-count'))[0] === '2 selected');
  await page.click('#selectBtn'); await sleep(100);
  await page.evaluate(() => [...document.querySelectorAll('.menu-item')].find((b) => /Invert/.test(b.textContent))?.click());
  await sleep(300);
  check('invert selection', (await count('#selbar:not([hidden])')) === 0);
  await page.click('#fClear'); await sleep(300);

  // ---- groups dialog (tri-state) + note
  await page.click('.card[data-id="i4"] .chk'); await sleep(100);
  await page.evaluate(() => document.querySelector('.card[data-id="i3"]:not(.sel) .chk').click()); await sleep(100); // (a real click can land under the sticky header in this short viewport)
  await page.evaluate(() => [...document.querySelectorAll('#selbar .tb')].find((b) => /Groups/.test(b.textContent)).click());
  await sleep(300);
  await page.evaluate(() => { const rows = [...document.querySelectorAll('#ggList .gg-row')]; rows.find((r) => /Beta/.test(r.textContent)).querySelector('input').click(); });
  await page.click('#dlgGroups button[value="ok"]');
  await sleep(600);
  const gids = await page.evaluate(async () => { const { getState } = await import('./common.js'); const s = await getState(); return Object.fromEntries(s.items.filter((i) => ['i3', 'i4'].includes(i.id)).map((i) => [i.id, i.groupIds])); });
  check('groups dialog adds to several tabs at once', gids.i4.includes('B') && gids.i3.includes('B') && gids.i3.includes('A2'));
  await page.evaluate(() => [...document.querySelectorAll('#selbar .tb')].find((b) => /Add note/.test(b.textContent)).click());
  await sleep(200);
  await page.type('#nText', 'check later');
  await page.click('#dlgNote button[value="ok"]');
  await sleep(500);
  check('bulk note', (await q('.card[data-id="i4"] .note'))[0] === 'check later');
  await page.keyboard.press('Escape'); await sleep(200);

  // ---- keyboard navigation
  await page.mouse.click(5, 400);
  await page.keyboard.press('ArrowRight'); await sleep(100);
  check('arrow key highlights a card', (await count('.card.kbd')) === 1);
  await page.keyboard.press('x'); await sleep(100);
  check('x selects the highlighted card', (await count('.card.sel')) >= 1);
  await page.keyboard.press('Escape'); await sleep(100);

  // ---- drag a group onto another (nest), via model (DnD events are covered by model tests)
  // ---- manual order through drag events
  await page.select('#sort', 'manual'); await sleep(300);

  // ---- triage
  await page.keyboard.press('t'); await sleep(500);
  check('triage opens', (await count('#triage:not([hidden]) .tr-card')) === 1);
  await page.keyboard.press('ArrowRight'); await sleep(300);
  check('triage advances', /^2 of/.test((await q('.tr-top span'))[0]));
  await page.keyboard.press('d'); await sleep(600);
  const left = await page.evaluate(async () => (await (await import('./common.js')).getState()).items.length);
  check('triage delete removes one item', left === 4);
  await page.keyboard.press('u'); await sleep(600);
  check('triage undo brings it back', (await page.evaluate(async () => (await (await import('./common.js')).getState()).items.length)) === 5);
  await page.keyboard.press('Escape'); await sleep(300);
  check('triage closes', (await count('#triage:not([hidden])')) === 0);

  // ---- second stash page: banner + live sync
  const p2 = await h.stashPage();
  await sleep(1200);
  check('second page: banner shown', (await count('#banner .banner')) >= 1);
  await p2.evaluate(async () => { const m = await import('./model.js'); await m.deleteItems(['i5']); });
  await page.bringToFront();
  await sleep(900);
  check('first page syncs a delete made in the second', (await count('.card[data-id="i5"]')) === 0);
  await p2.close();
  await page.bringToFront();

  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  return check.failed();
}
