// Things the user can do on the stash page. Every change goes through model.js, so it can be undone.

import { flattenGroups, getSettings, hostOf, STASH_PAGE, idbGet } from './common.js';
import { restoreItems, enrichMissing, diagnoseThumbnail } from './core.js';
import * as model from './model.js';
import { takeStashSnapshot } from './snapshots.js';
import { buildBackup, parseBackup, importBackup } from './backup.js';
import { checkLinks } from './linkcheck.js';
import * as ab from './autobackup.js';
import { app, byId, groupOf, refresh, done, doUndo, selectedItems } from './app.js';
import { askGroup, askItem, askNote, askGroups, showText } from './dialogs.js';
import { $, h, showMenu, toast, hideToast, plural, setBanner } from './ui.js';

const ui = app.ui;

/* ----------------------------------------------------------------- opening */

async function openNow(items, opts, keep) {
  if (items.length > 25 && !confirm(`Open ${items.length} tabs?`)) return;
  const n = await restoreItems(items, { ...opts, keep: true });
  items.forEach((i) => ui.selected.delete(i.id));
  if (!n) return toast('Could not open that tab');
  if (!keep && n === items.length) {
    await model.deleteItems(items.map((i) => i.id), 'open');
    await done(`Opened ${plural(n, 'tab')} · removed from the stash`);
  } else {
    await refresh();
    toast(`Opened ${plural(n, 'tab')} · still in the stash`);
  }
}

// keep: true / false to force it; undefined = follow the setting (or ask).
export function openItems(items, opts = {}, anchor = null) {
  if (!items.length) return;
  let keep = opts.keep;
  if (keep === undefined) {
    if (app.settings.openMode === 'ask') {
      return showMenu(anchor || { x: innerWidth / 2 - 100, y: innerHeight / 3 }, [
        { head: `Open ${items.length > 1 ? plural(items.length, 'tab') : 'this tab'}` },
        { label: 'Open and remove from the stash', onClick: () => openNow(items, opts, false) },
        { label: 'Open and keep in the stash', onClick: () => openNow(items, opts, true) },
      ]);
    }
    keep = app.settings.openMode === 'keep';
  }
  return openNow(items, opts, keep);
}

// Click on a card. Alt-click does the opposite of the setting.
export function clickOpen(item, e, anchor) {
  const mode = app.settings.openMode;
  if (e?.altKey && mode !== 'ask') return openItems([item], { keep: mode !== 'keep' });
  return openItems([item], {}, anchor);
}

export function openSelected(mode, keep, anchor) {
  const items = selectedItems();
  const gs = new Set(items.map((i) => i.groupIds[0] || ''));
  const g = gs.size === 1 ? groupOf([...gs][0]) : null;
  return openItems(items, { mode, keep, groupTitle: g?.name || 'Restored', groupColor: g?.color || 'blue' }, anchor);
}

export function openMenu(anchor, items, g) {
  const name = g?.name || 'Restored';
  const o = (extra, keep) => () => openItems(items, { ...extra, keep });
  showMenu(anchor, [
    { head: 'Open and remove from the stash' },
    { label: `Open ${items.length === 1 ? 'tab' : 'all ' + items.length}`, onClick: o({}, false) },
    { label: 'As a Chrome tab group', onClick: o({ mode: 'group', groupTitle: name, groupColor: g?.color || 'blue' }, false) },
    { label: 'In a new window', onClick: o({ mode: 'window' }, false) },
    { head: 'Open and keep in the stash' },
    { label: 'Open', onClick: o({}, true) },
    { label: 'As a Chrome tab group', onClick: o({ mode: 'group', groupTitle: name, groupColor: g?.color || 'blue' }, true) },
    { label: 'In a new window', onClick: o({ mode: 'window' }, true) },
  ]);
}

/* ---------------------------------------------------------------- deleting */

export async function deleteIds(ids) {
  ids = ids.filter((id) => byId(id));
  if (!ids.length) return;
  ids.forEach((id) => ui.selected.delete(id));
  const n = await model.deleteItems(ids);
  await done(`Deleted ${plural(n ?? ids.length, 'tab')}`);
}

/* ------------------------------------------------------------------ groups */

export async function moveTo(ids, gid, { from = null, copy = false } = {}) {
  if (!ids.length) return;
  const name = gid ? groupOf(gid)?.name || 'group' : 'Ungrouped';
  if (copy && gid) await model.addToGroups(ids, [gid]);
  else if (!gid) await model.changeMembership(ids, from ? { remove: [from] } : { replace: [] }, 'move to Ungrouped');
  else if (from && from !== gid) await model.changeMembership(ids, { add: [gid], remove: [from] }, 'move to group');
  else await model.addToGroups(ids, [gid]);
  await done(`${copy ? 'Added' : 'Moved'} ${plural(ids.length, 'tab')} ${copy ? 'to' : 'to'} ${name}`);
}

export async function newGroup(parentId = null, thenAdd = null) {
  const res = await askGroup(null, parentId);
  if (!res?.name) return null;
  const gid = await model.createGroup(res);
  if (thenAdd?.length) await model.addToGroups(thenAdd, [gid]);
  await done(thenAdd?.length ? `Added ${plural(thenAdd.length, 'tab')} to ${res.name}` : `Created ${res.name}`);
  return gid;
}

export async function editGroup(g) {
  const res = await askGroup(g);
  if (!res?.name) return;
  await model.updateGroup(g.id, res);
  await done();
}

export async function removeGroup(g) {
  const members = app.state.items.filter((i) => i.groupIds.includes(g.id)).length;
  const subs = app.state.groups.filter((x) => x.parentId === g.id).length;
  const lines = [`Delete the group “${g.name}”?`];
  if (members) lines.push(`Its ${plural(members, 'tab')} stay in the stash (and in their other groups).`);
  if (subs) lines.push(`Its ${plural(subs, 'subgroup')} move up one level.`);
  if (!confirm(lines.join('\n\n'))) return;
  if (ui.view === g.id) ui.view = 'all';
  await model.deleteGroup(g.id);
  await done(`Deleted group ${g.name}`);
}

export async function groupsDialog(ids) {
  ids = ids.filter((id) => byId(id));
  if (!ids.length) return;
  const res = await askGroups(ids);
  if (!res || (!res.add.length && !res.remove.length)) return;
  await model.changeMembership(ids, res, 'change groups');
  await done('Groups updated');
}

export function moveMenu(anchor, ids) {
  showMenu(anchor, [
    { head: 'Move to' },
    { label: 'Ungrouped', onClick: () => moveTo(ids, null) },
    ...flattenGroups(app.state.groups).map(({ group, depth }) => ({
      label: '  '.repeat(depth) + (depth ? '↳ ' : '') + group.name,
      onClick: () => moveTo(ids, group.id),
    })),
    { sep: true },
    { label: 'New group…', onClick: () => newGroup(null, ids) },
  ]);
}

export async function autoGroupBySite() {
  const pool = ui.selected.size ? selectedItems() : app.state.items.filter((i) => !i.groupIds.length);
  const n = await model.groupBySite(pool.map((i) => i.id));
  if (!n) return toast('No site has two or more tabs to group');
  await done(`Created ${plural(n, 'group')} by site`);
}

/* ------------------------------------------------------------------- items */

export async function editItemDialog(item) {
  const res = await askItem(item);
  if (!res) return;
  await model.editItem(item.id, { title: res.title || item.title, note: res.note });
  await done();
}

export async function noteDialog(ids) {
  ids = ids.filter((id) => byId(id));
  if (!ids.length) return;
  const res = await askNote(ids);
  if (!res) return;
  await model.setNote(ids, res.text, { append: res.append });
  await done(res.text ? 'Note saved' : 'Note removed');
}

export function copyLinks(items) {
  const md = items.map((i) => `- [${(i.title || i.url).replace(/[\[\]]/g, '')}](${i.url})`).join('\n');
  navigator.clipboard.writeText(md).then(() => toast(`Copied ${plural(items.length, 'link')} as Markdown`));
}

export async function diagnose(item) {
  toast('Checking…');
  showText('Thumbnail diagnosis', await diagnoseThumbnail(item));
  hideToast();
}

export async function refreshThumbnails(ids) {
  toast('Refreshing…');
  await enrichMissing({ ids, force: true });
  toast(ids.length === 1 ? 'Thumbnail refreshed' : 'Thumbnails refreshed');
}

export async function fetchThumbsNow() {
  const res = await enrichMissing({ retry: true });
  if (res?.skipped) toast('Already fetching thumbnails…');
  else toast(res?.total ? `Fetched ${res.fetched} of ${res.total} missing thumbnails` : 'No thumbnails are missing');
}

export async function mergeDuplicates() {
  const n = await model.removeDuplicates();
  if (!n) return toast('No duplicates found');
  await done(`Merged ${plural(n, 'duplicate')} (groups and notes were combined)`);
}

/* ------------------------------------------------------------ file backups */

function download(name, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

const slug = (str) => str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'tabs';

// Opens a "Save as" dialog (starting at your Desktop) and writes a backup including thumbnails.
export async function saveBackup(items = app.state.items, label = 'all') {
  if (!items.length) return toast('Nothing to back up yet');
  const name = `tab-stash-${slug(label)}-${new Date().toISOString().slice(0, 10)}.json`;
  let handle = null;
  // The picker must be opened straight from the click, before any slow work.
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, startIn: 'desktop', types: ab.FILE_TYPES });
    } catch (e) {
      if (e.name === 'AbortError') return;
      handle = null;
    }
  }
  toast('Preparing backup…');
  const whole = items === app.state.items;
  const text = JSON.stringify(await buildBackup(app.state, items, { thumbs: true, allGroups: whole }));
  if (handle) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    toast(`Saved ${plural(items.length, 'tab')} to ${handle.name}`);
  } else {
    download(name, text);
    toast(`Saved ${plural(items.length, 'tab')} to your Downloads folder as ${name}`);
  }
}

export async function restoreBackup() {
  if (window.showOpenFilePicker) {
    try {
      const [fh] = await window.showOpenFilePicker({ startIn: 'desktop', types: ab.FILE_TYPES, multiple: false });
      return importFile(await fh.getFile());
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  $('#importFile').click();
}

export async function importFile(file) {
  const data = parseBackup(await file.text());
  if (!data?.items.length) return toast('Nothing to import in that file');
  await takeStashSnapshot('before importing a file').catch(() => {});
  const { added, skipped } = await importBackup(data);
  await refresh();
  toast(`Imported ${plural(added, 'tab')}${skipped ? ` (${skipped} were already in your stash; their groups were merged)` : ''}`);
}

export function exportMarkdown() {
  const lines = [];
  const line = (i) => `- [${(i.title || i.url).replace(/[\[\]]/g, '')}](${i.url})${i.note ? ` — ${i.note.replace(/\s+/g, ' ')}` : ''}`;
  for (const { group, depth } of flattenGroups(app.state.groups)) {
    const list = app.state.items.filter((i) => i.groupIds.includes(group.id));
    if (list.length) lines.push(`${'#'.repeat(Math.min(6, depth + 2))} ${group.name}`, ...list.map(line), '');
  }
  const rest = app.state.items.filter((i) => !i.groupIds.length);
  if (rest.length) lines.push('## Ungrouped', ...rest.map(line), '');
  download('tab-stash.md', lines.join('\n'), 'text/markdown');
}

/* ------------------------------------------------------------- auto-backup */

let abTimer = 0;
let abDirty = false;

export function backupSoon() {
  if (!ab.supported()) return;
  abDirty = true;
  clearTimeout(abTimer);
  abTimer = setTimeout(() => runAutobackup(), 90_000);
}

export async function runAutobackup({ click = false, force = false } = {}) {
  if (!ab.supported()) return;
  const handle = await ab.getHandle().catch(() => null);
  if (!handle) return setBanner('ab', null);
  if (!abDirty && !force) return;
  let perm = 'prompt';
  try {
    perm = await ab.permission(handle, click);
  } catch {
    /* handle no longer valid */
  }
  if (perm !== 'granted') {
    setBanner(
      'ab',
      h('div', { class: 'banner' }, h('span', { text: `Automatic backup to “${handle.name}” needs your permission again after the browser restarted.` }),
        h('button', { class: 'btn small', text: 'Allow', onclick: () => runAutobackup({ click: true, force: true }) }),
        h('button', { class: 'btn small', text: 'Turn off', onclick: turnOffBackup }))
    );
    return;
  }
  setBanner('ab', null);
  await navigator.locks.request('tab-stash-autobackup', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    try {
      const text = JSON.stringify(await buildBackup(app.state, app.state.items, { thumbs: false, allGroups: true }));
      await ab.writeBackup(handle, text);
      abDirty = false;
    } catch (e) {
      console.warn('auto-backup failed', e);
      toast('Automatic backup failed: ' + (e.message || e));
    }
  });
}

export async function chooseBackupFile() {
  try {
    await ab.chooseFile();
  } catch (e) {
    if (e.name === 'AbortError') return;
    return toast('Could not choose that file');
  }
  await runAutobackup({ force: true, click: true });
}

export async function turnOffBackup() {
  await ab.turnOff();
  setBanner('ab', null);
}

export function startBackupTimers() {
  setInterval(() => abDirty && runAutobackup(), 10 * 60_000);
  // after a restart: write once if nothing was saved recently
  setTimeout(async () => {
    const ts = await ab.lastRun().catch(() => 0);
    if (Date.now() - (ts || 0) > 10 * 60_000) {
      abDirty = true;
      runAutobackup();
    }
  }, 6000);
}

/* ------------------------------------------------------------ link checker */

let linkRun = null;

export function isChecking() {
  return !!linkRun;
}

export async function runLinkCheck(items) {
  if (linkRun) return toast('Already checking links');
  items = items.filter((i) => /^https?:/i.test(i.url));
  if (!items.length) return toast('Nothing to check');
  if (items.length > 150 && !confirm(`Check ${items.length} links? It runs in the background and can take a few minutes.`)) return;
  const ctrl = new AbortController();
  linkRun = ctrl;
  const tally = { ok: 0, dead: 0, blocked: 0, error: 0 };
  const bar = h('span', { text: `Checking links… 0/${items.length}` });
  setBanner('links', h('div', { class: 'banner' }, bar, h('button', { class: 'btn small', text: 'Stop', onclick: () => ctrl.abort() })));
  try {
    const res = await checkLinks(items, {
      signal: ctrl.signal,
      onProgress: (d, t) => (bar.textContent = `Checking links… ${d}/${t}`),
      onResults: async (r) => {
        for (const v of Object.values(r)) tally[v.status]++;
        await model.saveLinkResults(r);
      },
    });
    setBanner('links', null);
    if (res.offline) return toast('Almost every link failed to connect, so you may be offline. Nothing was marked as dead.');
    const bad = tally.dead + tally.blocked + tally.error;
    toast(
      `${res.aborted ? 'Stopped. ' : ''}Checked ${res.done}: ${tally.dead} dead, ${tally.blocked} restricted, ${tally.error} unreachable`,
      bad ? { label: 'Show them', onClick: () => { ui.filters.link = 'bad'; app.syncFilters(); } } : undefined
    );
  } finally {
    linkRun = null;
    setBanner('links', null);
    await refresh();
  }
}
