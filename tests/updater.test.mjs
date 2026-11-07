// In-extension updater: version compare, release check, zip reading, writing into a folder
// (an OPFS folder stands in for the one the user picks), backup, rollback, wrong-folder rejection.
import { launch, checker, sleep, serve, ROOT } from './helpers.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export default async function () {
  const check = checker('updater');
  const work = path.join(ROOT, 'tests', '.tmp', 'upd');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'tab-stash'), { recursive: true });
  execSync(`cd "${ROOT}" && tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=tests -cf - . | tar -xf - -C "${work}/tab-stash"`);
  const mp = path.join(work, 'tab-stash', 'manifest.json');
  fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
  fs.writeFileSync(path.join(work, 'tab-stash', 'brand-new.js'), '// new in 9.9.9\n');
  fs.mkdirSync(path.join(work, 'tab-stash', 'tests'));
  fs.writeFileSync(path.join(work, 'tab-stash', 'tests', 'x.js'), 'not shipped');
  execSync(`cd "${work}" && zip -rq tab-stash-9.9.9.zip tab-stash`);
  const size = fs.statSync(path.join(work, 'tab-stash-9.9.9.zip')).size;
  const siteDir = path.join(ROOT, 'tests', 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  fs.copyFileSync(path.join(work, 'tab-stash-9.9.9.zip'), path.join(siteDir, 'tab-stash-9.9.9.zip'));
  fs.writeFileSync(path.join(siteDir, 'latest.json'), JSON.stringify({ tag_name: 'v9.9.9', body: 'Test notes', html_url: 'http://127.0.0.1:8794/rel', assets: [{ name: 'tab-stash-9.9.9.zip', size, browser_download_url: 'http://127.0.0.1:8794/tab-stash-9.9.9.zip' }] }));

  const srv = await serve(8794);
  const h = await launch();
  const page = await h.stashPage();
  await page.evaluate(() => chrome.storage.local.set({ settings: { fetchThumbs: false, snapshots: false, checkUpdates: false } }));

  const r = await page.evaluate(async () => {
    const up = await import('./updater.js');
    const out = {};
    out.cmp = [up.compareVersions('2.0.1', '2.0.0'), up.compareVersions('2.0.0', '2.0.0'), up.compareVersions('1.9.9', '2.0.0'), up.compareVersions('v2.10.0', '2.9.0')];
    const info = await up.checkForUpdate({ api: 'http://127.0.0.1:8794/latest.json' });
    out.info = { available: info.available, latest: info.latest, hasZip: !!info.zipUrl, current: info.current };

    // a folder that looks like the installed extension
    const root = await navigator.storage.getDirectory();
    for await (const k of root.keys()) await root.removeEntry(k, { recursive: true });
    const put = async (name, data) => { const w = await (await root.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close(); };
    for (const f of ['manifest.json', 'common.js', 'stash.js']) await put(f, await (await fetch(chrome.runtime.getURL(f))).text());
    await put('obsolete.js', '// removed in the new version');
    await put('.newtab', '');
    const oldVersion = chrome.runtime.getManifest().version;
    const progress = [];
    const version = await up.installUpdate(info, root, { onProgress: (d, t, l) => progress.push(l) });
    const read = async (path) => { let dir = root; const parts = path.split('/'); const f = parts.pop(); for (const p of parts) dir = await dir.getDirectoryHandle(p); return (await (await dir.getFileHandle(f)).getFile()).text(); };
    const exists = async (path) => { try { await read(path); return true; } catch { return false; } };
    out.version = version;
    out.manifest = JSON.parse(await read('manifest.json')).version;
    out.backup = JSON.parse(await read('previous-version/manifest.json')).version;
    out.oldVersion = oldVersion;
    out.newFile = await exists('brand-new.js');
    out.nestedFile = await exists('icons/icon48.png');
    out.obsoleteGone = !(await exists('obsolete.js'));
    out.flagKept = await exists('.newtab');
    out.testsSkipped = !(await exists('tests/x.js'));
    out.phases = [...new Set(progress)];
    out.sameContent = (await read('stash.js')).length > 1000;

    // rollback
    out.rolled = await up.rollback(root);
    out.afterRollback = JSON.parse(await read('manifest.json')).version;

    // wrong folder
    const other = await root.getDirectoryHandle('other', { create: true });
    const w = await (await other.getFileHandle('manifest.json', { create: true })).createWritable();
    await w.write(JSON.stringify({ name: 'Something else', version: '1.0.0' }));
    await w.close();
    out.wrong = await up.verifyFolder(other).then(() => 'accepted', (e) => e.message);
    const empty = await root.getDirectoryHandle('empty', { create: true });
    out.empty = await up.verifyFolder(empty).then(() => 'accepted', (e) => e.message);
    // not newer
    out.notNewer = await up.installUpdate({ ...info, latest: '9.9.8' }, root).then(() => 'installed', (e) => e.message);
    return out;
  });
  check('version comparison', JSON.stringify(r.cmp) === '[1,0,-1,1]', JSON.stringify(r.cmp));
  check('release check finds the new version', r.info.available && r.info.latest === '9.9.9' && r.info.hasZip, JSON.stringify(r.info));
  check('update installs the new version', r.version === '9.9.9' && r.manifest === '9.9.9', JSON.stringify([r.version, r.manifest]));
  check('files from the zip are written (including sub-folders)', r.newFile && r.nestedFile && r.sameContent);
  check('old version is saved in previous-version/', r.backup === r.oldVersion, `${r.backup} vs ${r.oldVersion}`);
  check('removed files are deleted, .newtab flag is kept, tests are not written', r.obsoleteGone && r.flagKept && r.testsSkipped, JSON.stringify(r));
  check('progress is reported', r.phases.length >= 2, r.phases.join());
  check('rollback restores the previous version', r.rolled === r.oldVersion && r.afterRollback === r.oldVersion, JSON.stringify([r.rolled, r.afterRollback]));
  check('wrong folder is rejected', /not look like/.test(r.wrong), r.wrong);
  check('folder without manifest is rejected', /no manifest/.test(r.empty), r.empty);
  check('a zip that is not the announced version is refused', /not v9\.9\.8/.test(r.notNewer), r.notNewer);

  // banner from a stored update
  await page.evaluate(() => chrome.storage.local.set({ settings: { fetchThumbs: false, snapshots: false, checkUpdates: true }, updateInfo: { current: '2.0.0', latest: '9.9.9', available: true, zipUrl: 'http://x/y.zip', size: 1, notes: '', url: 'http://127.0.0.1:8794/rel', checkedAt: Date.now() } }));
  await page.reload();
  await sleep(900);
  const banner = await page.$$eval('#banner .banner', (b) => b.map((x) => x.textContent));
  check('banner offers the update', banner.some((t) => /9\.9\.9 is available/.test(t) && /Update now/.test(t)), banner.join('|'));
  await page.evaluate(() => [...document.querySelectorAll('#banner .btn')].find((b) => b.textContent === 'Later').click());
  await sleep(200);
  check('"Later" hides it', (await page.$$eval('#banner .banner', (b) => b.length)) === 0);

  // stale-page detection
  const stale = await page.evaluate(async () => {
    const m = await import('./stale.js');
    const out = {};
    out.pure = [m.staleState({ loaded: '1', running: '1', disk: '1', alive: true }), m.staleState({ loaded: '1', running: '2', disk: '2', alive: true }), m.staleState({ loaded: '2', running: '2', disk: '3', alive: true }), m.staleState({ loaded: '1', running: null, disk: null, alive: false })];
    out.fresh = await m.checkStale();
    out.freshBanner = document.querySelectorAll('#banner .banner').length;
    out.disk = await m.checkStale({ read: async () => '99.0.0' });
    out.diskText = document.querySelector('#banner .banner')?.textContent || '';
    out.page = await m.checkStale({ loaded: '0.0.1' });
    out.pageText = document.querySelector('#banner .banner')?.textContent || '';
    await m.checkStale();
    out.cleared = document.querySelectorAll('#banner .banner').length;
    return out;
  });
  check('staleState decisions', JSON.stringify(stale.pure) === '["ok","page","extension","page"]', JSON.stringify(stale.pure));
  check('no banner when up to date', stale.fresh === 'ok');
  check('new files on disk -> "Reload extension" banner', stale.disk === 'extension' && /still running/.test(stale.diskText), stale.diskText);
  check('page older than extension -> "Reload this page" banner', stale.page === 'page' && /old code/.test(stale.pageText), stale.pageText);
  check('banner disappears when up to date again', stale.cleared === 0, String(stale.cleared));

  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();
  srv.close();
  return check.failed();
}
