// 2.2.0: text/bookmarks import and export, reminders, recently deleted, open destination, settings.
import { launch, checker, sleep } from './helpers.mjs';

export default async function () {
  const check = checker('v22');
  const h = await launch();
  const mk = (id, url, extra = {}) => ({ id, url, title: 'T ' + id, description: '', ogImage: '', addedAt: 1700000000000, order: 0, note: '', groupIds: [], ...extra });

  // ---------------- pure / module level (popup page has no stash DOM)
  const page = await h.browser.newPage();
  h.watch(page, 'popup');
  await page.goto(`chrome-extension://${h.extId}/popup.html`);
  const r = await page.evaluate(async () => {
    const bm = await import('./bookmarks.js');
    const bk = await import('./backup.js');
    const common = await import('./common.js');
    const model = await import('./model.js');
    const rem = await import('./reminders.js');
    const trash = await import('./trash.js');
    const out = {};
    const mkItem = (id, url, extra = {}) => ({ id, url, title: 'T ' + id, description: '', ogImage: '', addedAt: 1700000000000, order: 0, note: '', groupIds: [], ...extra });

    // links in free text
    const text = [
      'See https://a.example.com/one, and (https://b.example.com/two).',
      '[Named](https://c.example.com/three)',
      'https://d.example.com/four | OneTab title',
      '<a href="https://e.example.com/five">Anchor text</a>',
      'again https://a.example.com/one',
    ].join('\n');
    const links = bm.linksFromText(text);
    out.linkUrls = links.map((l) => l.url);
    out.titles = Object.fromEntries(links.map((l) => [l.url, l.title]));
    out.noJunk = bm.linksFromText('no links here, just words. example').length;

    // plain text through parseBackup
    out.plain = bk.parseBackup('https://x.example.com/a\nhttps://y.example.com/b').items.length;
    out.json = bk.parseBackup(JSON.stringify({ items: [{ url: 'https://j.example.com/', title: 'J' }], groups: [] })).items.length;

    // bookmarks round trip (nested folders, a link in two folders, an ungrouped link, special characters)
    const state = {
      groups: [
        { id: 'g1', name: 'Work & "Play"', color: 'blue', parentId: null },
        { id: 'g2', name: 'Sub', color: 'red', parentId: 'g1' },
      ],
      items: [
        mkItem('a', 'https://a.example.com/?x=1&y=2', { title: 'A <b>', groupIds: ['g1'] }),
        mkItem('b', 'https://b.example.com/', { groupIds: ['g1', 'g2'] }),
        mkItem('c', 'https://c.example.com/', { groupIds: [] }),
      ],
      orders: {},
    };
    const html = bm.buildBookmarksHtml(state);
    out.htmlLooksRight = bm.looksLikeBookmarksHtml(html);
    const back = bk.parseBackup(html);
    out.backItems = back.items.length; // b appears in two folders -> two entries in the file
    out.backUrls = back.items.map((i) => i.url).sort();
    out.backGroups = back.groups.map((g) => `${g.name}<${back.groups.find((p) => p.id === g.parentId)?.name || '-'}`).sort();
    out.addedKept = back.items.every((i) => i.addedAt === 1700000000000);
    const merged = { items: [], groups: [], orders: {} };
    bk.mergeData(merged, back);
    out.mergedItems = merged.items.length; // duplicates merged by URL
    out.bInTwo = merged.items.find((i) => i.url === 'https://b.example.com/').groupIds.length;

    // Chrome-style export (folders nested inside <DT>, Firefox adds extra attributes, javascript: skipped)
    const chromeFile = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
      <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
      <DL><p>
        <DT><A HREF="https://one.example.com/" ADD_DATE="1600000000" ICON="data:image/png;base64,AAAA">One</A>
        <DT><A HREF="javascript:alert(1)">bad</A>
        <DT><H3>Inner</H3>
        <DL><p><DT><A HREF="https://two.example.com/">Two</A></DL><p>
      </DL><p>
      <DT><A HREF="https://three.example.com/">Three</A>
    </DL><p>`;
    const c = bk.parseBackup(chromeFile);
    out.chromeItems = c.items.map((i) => `${i.title}@${c.groups.find((g) => g.id === i.groupIds[0])?.name || '-'}`).sort();

    // reminders: set, undo, due detection
    await chrome.storage.local.set({ state: { items: [mkItem('r1', 'https://r1.example.com/'), mkItem('r2', 'https://r2.example.com/')], groups: [], orders: {} }, settings: {} });
    const soon = Date.now() - 1000;
    await model.setReminder(['r1', 'r2'], soon);
    let s = await common.getState();
    out.set = s.items.map((i) => i.remindAt === soon);
    out.next = rem.nextReminder(s.items) === soon;
    const due = await rem.fireDueReminders();
    s = await common.getState();
    out.fired = [due.length, s.items.every((i) => i.remindFired)];
    out.nextAfter = rem.nextReminder(s.items);
    out.stillDue = rem.isDue(s.items[0]);
    await model.undoLast();
    s = await common.getState();
    out.undo = s.items.every((i) => i.remindAt === undefined && i.remindFired === undefined);
    await model.setReminder(['r1'], Date.now() + 99999);
    await model.setReminder(['r1'], null);
    out.cleared = (await common.getState()).items[0].remindAt === undefined;

    // recently deleted: off by default, on when asked, undo hides it, restore brings it back
    await model.deleteItems(['r1']);
    out.trashOff = (await trash.listTrash()).length;
    await chrome.storage.local.set({ settings: { keepDeleted: true } });
    await model.deleteItems(['r2']);
    out.trashOn = (await trash.listTrash()).map((e) => e.item.id);
    await model.undoLast();
    out.trashAfterUndo = (await trash.listTrash()).length;
    await model.deleteItems(['r2']);
    const n = await trash.restoreFromTrash(['r2']);
    out.restored = [n, (await common.getState()).items.map((i) => i.id), (await trash.listTrash()).length];
    // expiry
    await model.deleteItems(['r2']);
    out.purged = (await trash.purgeTrash(Date.now() + 31 * 86400000)).length;
    return out;
  });
  check('links found in text, without duplicates or trailing punctuation', JSON.stringify(r.linkUrls) === JSON.stringify(['https://c.example.com/three', 'https://e.example.com/five', 'https://d.example.com/four', 'https://a.example.com/one', 'https://b.example.com/two']) || (r.linkUrls.length === 5 && !r.linkUrls.some((u) => /[,.)]$/.test(u))), JSON.stringify(r.linkUrls));
  check('titles taken from Markdown, OneTab and HTML', r.titles['https://c.example.com/three'] === 'Named' && r.titles['https://d.example.com/four'] === 'OneTab title' && r.titles['https://e.example.com/five'] === 'Anchor text', JSON.stringify(r.titles));
  check('text without links gives nothing', r.noJunk === 0);
  check('plain list and JSON still import', r.plain === 2 && r.json === 1);
  check('bookmarks file is recognised', r.htmlLooksRight);
  check('bookmarks round trip keeps links, folders and dates', r.backItems === 4 && r.backUrls.includes('https://a.example.com/?x=1&y=2') && r.backGroups.join('|') === 'Sub<Work & "Play"|Work & "Play"<-' && r.addedKept, JSON.stringify([r.backItems, r.backUrls, r.backGroups]));
  check('importing it merges the link that was in two folders', r.mergedItems === 3 && r.bInTwo === 2, JSON.stringify([r.mergedItems, r.bInTwo]));
  check('Chrome-style bookmarks: nesting, titles, javascript: skipped', JSON.stringify(r.chromeItems) === JSON.stringify(['One@Bookmarks bar', 'Three@-', 'Two@Inner']), JSON.stringify(r.chromeItems));
  check('reminder set on several tabs', r.set.every(Boolean) && r.next);
  check('due reminders are announced once and stay marked due', r.fired[0] === 2 && r.fired[1] && r.nextAfter === 0 && r.stillDue, JSON.stringify([r.fired, r.nextAfter, r.stillDue]));
  check('reminder undo and clear', r.undo && r.cleared);
  check('deleted tabs are not kept unless the setting is on', r.trashOff === 0);
  check('deleted tab is kept when on, hidden after Undo', r.trashOn.join() === 'r2' && r.trashAfterUndo === 0, JSON.stringify([r.trashOn, r.trashAfterUndo]));
  check('restore from recently deleted', r.restored[0] === 1 && r.restored[1].includes('r2') && r.restored[2] === 0, JSON.stringify(r.restored));
  check('entries expire after 30 days', r.purged === 0, String(r.purged));

  // ---------------- stash page: dialogs, settings, open destination
  const seed = {
    groups: [{ id: 'A', name: 'Alpha', color: 'blue', parentId: null }],
    items: [mk('i1', 'https://one.example.com/', { groupIds: ['A'] }), mk('i2', 'https://two.example.com/', { groupIds: ['A'] }), mk('i3', 'https://three.example.com/')],
    orders: {},
  };
  const sp = await h.stashPage();
  await sp.evaluate((s) => chrome.storage.local.set({ state: s, settings: { fetchThumbs: false, openMode: 'keep', snapshots: false } }), seed);
  await sp.reload();
  await sleep(700);

  // settings dialog carries the new options and saves them
  await sp.evaluate(async () => (await import('./dialogs.js')).openSettings());
  await sleep(200);
  const vals = await sp.evaluate(() => ({ dest: document.querySelector('#sOpenDest').value, notify: document.querySelector('#sNotify').checked, keep: document.querySelector('#sKeepDeleted').checked }));
  check('settings show the defaults', vals.dest === 'tabs' && vals.notify === true && vals.keep === false, JSON.stringify(vals));
  await sp.evaluate(() => {
    document.querySelector('#sOpenDest').value = 'window';
    document.querySelector('#sNotify').checked = false;
    document.querySelector('#sKeepDeleted').checked = true;
    document.querySelector('#dlgSettings button[value=ok]').click();
  });
  await sleep(400);
  const saved = await sp.evaluate(async () => { const s = (await chrome.storage.local.get('settings')).settings; return [s.openDest, s.notifications, s.keepDeleted]; });
  check('new settings are saved', saved.join() === 'window,false,true', saved.join());

  // several tabs open in a new window by default now
  const winsBefore = await sp.evaluate(async () => (await chrome.windows.getAll()).length);
  await sp.evaluate(async () => {
    const act = await import('./actions.js');
    const { getState } = await import('./common.js');
    const s = await getState();
    window.__open = act.openItems(s.items.filter((i) => i.groupIds.includes('A')), { keep: true });
  });
  await sleep(1500);
  const winsAfter = await sp.evaluate(async () => (await chrome.windows.getAll()).length);
  check('opening several tabs follows the "new window" setting', winsAfter === winsBefore + 1, `${winsBefore} -> ${winsAfter}`);
  // a single card still opens as a plain tab
  const tabsBefore = await sp.evaluate(async () => (await chrome.tabs.query({})).length);
  await sp.evaluate(async () => (await import('./actions.js')).openItems([(await (await import('./common.js')).getState()).items[2]], { keep: true }));
  await sleep(800);
  const tabsAfter = await sp.evaluate(async () => (await chrome.tabs.query({})).length);
  const winsSingle = await sp.evaluate(async () => (await chrome.windows.getAll()).length);
  check('one tab opens as a plain tab', tabsAfter === tabsBefore + 1 && winsSingle === winsAfter, `${tabsBefore} -> ${tabsAfter}, windows ${winsSingle}`);

  await sp.bringToFront();
  await sleep(300);
  // reminder dialog: quick choice + save, shows on the card, filter finds it, clear
  await sp.evaluate(async () => { window.__p = (await import('./actions.js')).reminderDialog(['i3']); });
  await sleep(300);
  const quick = await sp.$$eval('#rQuick button', (b) => b.length);
  await sp.click('#rQuick button:nth-child(2)');
  const picked = await sp.$eval('#rWhen', (e) => new Date(e.value).getTime());
  check('reminder dialog has quick choices and fills the time', quick === 5 && picked > Date.now(), `${quick} ${picked}`);
  await sp.click('#dlgRemind button[value=ok]');
  await sleep(600);
  const line = await sp.$$eval('.card .remind', (els) => els.map((e) => e.textContent));
  check('reminder shows on the card', line.length === 1 && line[0].startsWith('⏰'), JSON.stringify(line));
  await sp.click('#fRemind');
  await sleep(300);
  check('"Has a reminder" filter', (await sp.$$eval('.card', (c) => c.length)) === 1);
  await sp.click('#fRemind');
  await sp.evaluate(async () => { window.__p = (await import('./actions.js')).reminderDialog(['i3']); });
  await sleep(300);
  await sp.click('#rClear');
  await sleep(500);
  check('reminder can be cleared', (await sp.$$eval('.card .remind', (e) => e.length)) === 0);

  // paste links into a group
  await sp.evaluate(async () => { window.__p = (await import('./actions.js')).pasteLinks(); });
  await sleep(300);
  await sp.evaluate(() => {
    const t = document.querySelector('#pText');
    t.value = 'read https://paste1.example.com/a and [Two](https://paste2.example.com/b)';
    t.dispatchEvent(new Event('input'));
    document.querySelector('#pGroup').value = 'A';
  });
  const countText = await sp.$eval('#pCount', (e) => e.textContent);
  await sp.click('#pOk');
  await sleep(700);
  const st = await sp.evaluate(async () => (await (await import('./common.js')).getState()).items.filter((i) => /paste/.test(i.url)).map((i) => [i.title, i.groupIds.join()]));
  check('pasted text is counted and imported into the chosen group', /2 links found/.test(countText) && st.length === 2 && st.every((x) => x[1] === 'A'), `${countText} ${JSON.stringify(st)}`);

  // recently deleted dialog
  await sp.evaluate(async () => { await (await import('./actions.js')).deleteIds(['i3']); });
  await sleep(400);
  await sp.evaluate(async () => (await import('./dialogs.js')).openTrash());
  await sleep(400);
  const rows = await sp.$$eval('#tList .trash-row', (r) => r.length);
  await sp.click('#tList input');
  await sp.click('#tRestore');
  await sleep(500);
  const back = await sp.evaluate(async () => (await (await import('./common.js')).getState()).items.some((i) => i.id === 'i3'));
  check('recently deleted lists the tab and restores it', rows === 1 && back, `${rows} ${back}`);

  check('no page errors', h.errors.length === 0, h.errors.join(' | '));
  await h.close();
  return check.failed();
}
