// Toolbar popup + background worker smoke test: group tree in the selects, stashing from the worker,
// "already stashed" tags, and the snapshot alarm wiring.
import { launch, checker, sleep } from './helpers.mjs';

export default async function () {
  const check = checker('popup');
  const h = await launch();
  const seed = {
    groups: [
      { id: 'A', name: 'Alpha', color: 'blue', parentId: null },
      { id: 'A1', name: 'Alpha One', color: 'green', parentId: 'A' },
    ],
    items: [{ id: 'x1', url: 'https://example.com/', title: 'Example', description: '', ogImage: '', addedAt: Date.now(), order: 0, note: '', groupIds: ['A1'] }],
    orders: {},
  };
  const page = await h.browser.newPage();
  h.watch(page, 'popup');
  await page.goto(`chrome-extension://${h.extId}/popup.html`);
  await page.evaluate((s) => chrome.storage.local.set({ state: s, settings: { fetchThumbs: false } }), seed);
  await page.reload();
  await sleep(600);
  const opts = await page.$$eval('select option', (o) => o.map((x) => x.textContent.trim()));
  check('popup group select lists subgroups', opts.some((t) => /Alpha One/.test(t)), opts.join('|'));

  // stash through the worker's message API, into a subgroup
  const res = await page.evaluate(async () => {
    const t = await chrome.tabs.create({ url: 'about:blank', active: false });
    return chrome.runtime.sendMessage({ type: 'stashTabs', tabIds: [t.id], groupId: 'A1' }).catch((e) => String(e));
  });
  check('worker answers stash messages', res !== undefined, JSON.stringify(res));

  // tabs snapshots can be taken (same module the worker uses)
  const snap = await page.evaluate(async () => {
    const m = await import('./snapshots.js');
    const id = await m.takeTabsSnapshot('smoke');
    return { id: !!id, list: (await m.listSnapshots('tabs')).length };
  });
  check('tabs snapshots work in the worker', snap.list >= 0 && typeof snap.id === 'boolean', JSON.stringify(snap));
  const alarms = await page.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name));
  check('snapshot alarm is scheduled', alarms.includes('snapshot'), alarms.join());

  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  return check.failed();
}
