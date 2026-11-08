// Regenerates the pictures used by docs/HELP.md:  node tests/screenshots.mjs
// Loads the extension in Chrome with made-up sample data and saves PNGs to docs/images/.
import { launch, sleep, ROOT } from './helpers.mjs';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(ROOT, 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });
const DAY = 86400000;
const now = Date.now();
const mk = (id, title, url, groupIds, ago, extra = {}) => ({ id, title, url, description: '', ogImage: '', addedAt: now - ago * DAY, order: 0, note: '', groupIds, ...extra });

const seed = {
  groups: [
    { id: 'read', name: 'Reading list', color: 'blue', parentId: null },
    { id: 'work', name: 'Work', color: 'orange', parentId: null },
    { id: 'proj', name: 'Project X', color: 'red', parentId: 'work' },
    { id: 'trip', name: 'Trip planning', color: 'green', parentId: null },
  ],
  items: [
    mk('a1', 'How tab hoarding quietly slows your browser', 'https://blog.example.com/tab-hoarding', ['read'], 2, { description: 'Why hundreds of open tabs cost memory even when you are not looking at them.' }),
    mk('a2', 'A beginner’s guide to sourdough baking', 'https://recipes.example.org/sourdough', ['read'], 5, { note: 'Try this weekend' }),
    mk('a3', 'Quarterly planning template', 'https://docs.example.net/planning-template', ['work'], 9, { description: 'A one-page template for quarterly goals and owners.' }),
    mk('a4', 'Project X: design review notes', 'https://wiki.example.com/project-x/design-review', ['proj'], 1, { note: 'Send feedback before Friday', remindAt: now + 2 * DAY }),
    mk('a5', 'Project X: API reference', 'https://api.example.com/docs', ['proj', 'work'], 3),
    mk('a6', 'Flights to Lisbon in May', 'https://travel.example.com/flights/lisbon', ['trip'], 4, { remindAt: now - 3600000, remindFired: true }),
    mk('a7', 'Where to stay in Alfama', 'https://stays.example.com/lisbon/alfama', ['trip'], 6, { description: 'Neighbourhood guide with a map of the best-rated places to stay.' }),
    mk('a8', 'Old forum thread about a keyboard', 'https://forum.example.com/thread/4411', [], 40, { link: { status: 'dead', code: 404, detail: 'Not found', checkedAt: now - DAY } }),
    mk('a9', 'Ten habits of calm inboxes', 'https://blog.example.com/calm-inbox', ['read'], 12),
    mk('b1', 'Weekly team update', 'https://docs.example.net/weekly', ['work'], 1),
    mk('b2', 'Tide times for the coast', 'https://tides.example.org/coast', [], 15),
    mk('b3', 'Bicycle maintenance basics', 'https://howto.example.com/bike-maintenance', ['read'], 20, { note: 'Chain and brakes first' }),
  ],
  orders: {},
};

const h = await launch({ width: 1240, height: 820 });
const page = await h.stashPage();
await page.evaluate(async (seed) => {
  const { idbPut } = await import('./common.js');
  const hues = [210, 25, 150, 340, 265, 45, 190, 0, 300, 100, 60, 230];
  let n = 0;
  for (const it of seed.items) {
    const c = new OffscreenCanvas(640, 360);
    const g = c.getContext('2d');
    const hue = hues[n++ % hues.length];
    const grad = g.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, `hsl(${hue} 60% 62%)`);
    grad.addColorStop(1, `hsl(${(hue + 40) % 360} 55% 38%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.font = 'bold 150px sans-serif';
    g.textAlign = 'center';
    g.fillText(it.title[0], 320, 230);
    await idbPut('thumbs', it.id, await c.convertToBlob({ type: 'image/png' }));
  }
  await chrome.storage.local.set({ state: seed, settings: { fetchThumbs: false, openMode: 'remove', snapshots: true, cardSize: 215, checkUpdates: false } });
}, seed);
await page.reload();
await sleep(1200);

const shot = (name, opts = {}) => (console.log('shot', name), page.screenshot({ path: path.join(OUT, name + '.png'), captureBeyondViewport: false, ...opts }));
const clickText = async (sel, text, mark = false) => {
  const el = await page.evaluateHandle((sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text)), sel, text);
  if (mark) await el.asElement().evaluate((e) => (e.id = 'tmpAnchor'));
  await el.asElement().click();
};
const closeAll = async () => {
  await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close('cancel')); document.querySelector('.menu')?.remove(); scrollTo(0, 0); });
  await sleep(150);
};
// picture of a menu together with the thing that opened it
const around = async (name, anchorSel, pad = 14) => {
  const r = await page.evaluate((sel) => {
    const a = document.querySelector(sel).getBoundingClientRect();
    const m = document.querySelector('.menu').getBoundingClientRect();
    const x = Math.min(a.left, m.left), y = Math.min(a.top, m.top);
    return { x, y, w: Math.max(a.right, m.right) - x, h: Math.max(a.bottom, m.bottom) - y };
  }, anchorSel);
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  await shot(name, { clip: { x, y, width: Math.min(1240 - x, r.w + pad * 2), height: Math.min(820 - y, r.h + pad * 2) } });
};
const dialog = async (name, sel) => { await sleep(300); await (await page.$(sel)).screenshot({ path: path.join(OUT, name + '.png') }); };

// ---- overview
await shot('overview');
// ---- header menus
await page.click('#stashBtn'); await sleep(200); await around('stash-menu', '#stashBtn'); await closeAll();
await page.click('#toolsBtn'); await sleep(200); await around('tools-menu', '#toolsBtn');
await page.click('.menu-toggle-all'); await sleep(200); await around('tools-menu-expanded', '#toolsBtn');
await page.click('.menu-toggle-all'); await sleep(200); await around('tools-menu-collapsed', '#toolsBtn'); await closeAll();
// ---- filters (with a couple active)
await page.type('#fSite', 'example.com'); await page.click('#fNote'); await sleep(400);
await shot('filters', { clip: { x: 0, y: 0, width: 1240, height: 150 } });
await page.click('#fClear'); await sleep(300);
await page.click('#selectBtn'); await sleep(200); await around('select-menu', '#selectBtn'); await closeAll();
// ---- sort + search
await page.type('#q', 'project'); await sleep(400);
await shot('search', { clip: { x: 0, y: 0, width: 1240, height: 420 } });
await page.$eval('#q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); }); await sleep(300);
// ---- sidebar + group menu
await page.evaluate(() => { const r = document.querySelector('.nav[data-gid="work"]').getBoundingClientRect(); document.querySelector('.nav[data-gid="work"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 60, clientY: r.top + 10 })); });
await sleep(200);
await shot('group-menu', { clip: { x: 0, y: 120, width: 420, height: 420 } }); await closeAll();
// ---- section header
await shot('section-header', { clip: { x: 230, y: 150, width: 1010, height: 90 } });
// ---- card menu
await page.evaluate(() => { const c = document.querySelector('.card[data-id="a1"]'); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 90, clientY: r.top + 80 })); });
await sleep(250);
await around('card-menu', '.card[data-id="a1"]', 10); await closeAll();
// card with hover buttons
await page.hover('.card[data-id="a4"]'); await sleep(250);
const cr = await page.$eval('.card[data-id="a4"]', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
await shot('card', { clip: { x: cr.x - 8, y: cr.y - 8, width: cr.w + 16, height: cr.h + 16 } });
// ---- selection bar
await page.evaluate(() => { scrollTo(0, 0); document.querySelectorAll('.card .chk').forEach((c, i) => i < 3 && c.click()); scrollTo(0, 0); });
await sleep(300);
await shot('selection-bar', { clip: { x: 0, y: 100, width: 1240, height: 130 } });
await clickText('#selbar button', 'More', true); await sleep(250); await around('selection-more', '#tmpAnchor'); await closeAll();
await page.evaluate(() => document.querySelector('#tmpAnchor')?.removeAttribute('id'));
await clickText('#selbar button', 'Open', true); await sleep(250); await around('open-menu', '#tmpAnchor'); await closeAll();
await page.evaluate(() => document.querySelector('#tmpAnchor')?.removeAttribute('id'));
await page.evaluate(() => document.querySelector('#selbar .tb.x').click()); await sleep(200);
// ---- dialogs
await page.evaluate(() => document.querySelector('#toolsBtn').click()); await sleep(150); await closeAll();
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.down('Shift'); await page.keyboard.press('Slash'); await page.keyboard.up('Shift'); await sleep(400);
const helpOpen = await page.evaluate(() => document.querySelector('#dlgHelp').open);
if (!helpOpen) throw new Error('? did not open the shortcuts');
await dialog('shortcuts', '#dlgHelp'); await closeAll();
await page.evaluate(() => import('./actions.js').then((a) => { window.__p = a.reminderDialog(['a4']); })); await dialog('reminder-dialog', '#dlgRemind'); await closeAll();
await page.evaluate(async () => { const a = await import('./actions.js'); window.__p = a.pasteLinks(); });
await sleep(200);
await page.evaluate(() => { const t = document.querySelector('#pText'); t.value = 'Reading later:\nhttps://news.example.com/story-one\n[Great article](https://blog.example.com/great-article)\nhttps://shop.example.com/item | A thing I want'; t.dispatchEvent(new Event('input')); });
await dialog('paste-dialog', '#dlgPaste'); await closeAll();
await page.evaluate(async () => { (await import('./actions.js')).editGroup((await import('./app.js')).app.state.groups[1]); }); await dialog('group-dialog', '#dlgGroup'); await closeAll();
await page.evaluate(async () => { const a = await import('./actions.js'); a.editItemDialog((await import('./app.js')).app.state.items[3]); }); await dialog('edit-dialog', '#dlgItem'); await closeAll();
// recently deleted (turn the setting on, delete two cards)
await page.evaluate(async () => {
  const { saveSettings } = await import('./common.js');
  await saveSettings({ keepDeleted: true });
  const a = await import('./actions.js');
  await a.deleteIds(['b2']); await a.deleteIds(['a8']);
  window.__t = (await import('./dialogs.js')).openTrash();
});
await dialog('recently-deleted', '#dlgTrash'); await closeAll();
await page.evaluate(async () => { const { listTrash, restoreFromTrash } = await import('./trash.js'); await restoreFromTrash((await listTrash()).map((e) => e.item.id)); });
// safety snapshots
await page.evaluate(async () => { const s = await import('./snapshots.js'); await s.takeStashSnapshot('before: bulk delete'); await s.takeTabsSnapshot('window closed', [{ id: 1, tabs: [{ url: 'https://news.example.com/', title: 'News', pinned: false, group: '' }, { url: 'https://mail.example.com/', title: 'Mail', pinned: true, group: '' }] }]); });
await page.evaluate(() => document.querySelector('#toolsBtn').click()); await sleep(150);
await page.click('.menu-toggle-all'); await sleep(150);
await clickText('.menu-item', 'Safety snapshots'); await sleep(500);
await dialog('snapshots', '#dlgSnap').catch(async () => shot('snapshots'));
await closeAll();
// ---- settings
await page.evaluate(async () => (await import('./dialogs.js')).openSettings()); await sleep(400);
await dialog('settings', '#dlgSettings');
await page.click('#sToggleAll'); await sleep(250);
await page.setViewport({ width: 1240, height: 1900 });
await dialog('settings-expanded', '#dlgSettings');
await page.setViewport({ width: 1240, height: 820 });
await closeAll();
// ---- picker
await page.click('#stashBtn'); await sleep(200); await clickText('.menu-item', 'Choose tabs'); await sleep(800);
await shot('picker'); await closeAll();
// ---- triage
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('t'); await sleep(800);
await shot('triage');
await page.keyboard.press('Escape'); await sleep(300);
// ---- toolbar popup
const pop = await h.browser.newPage();
await pop.setViewport({ width: 380, height: 640 });
await pop.goto(`chrome-extension://${h.extId}/popup.html`);
await sleep(800);
await pop.evaluate(() => { const l = document.querySelector('#siteLabel'); if (l) l.textContent = 'Stash tabs from blog.example.com'; });
await pop.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
await h.close();
console.log('saved to', OUT, fs.readdirSync(OUT).length, 'files');
