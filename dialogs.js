// Dialogs of the stash page.

import { COLORS, COLOR_HEX, STASH_PAGE, flattenGroups, descendantIds, getSettings, saveSettings } from './common.js';
import { app, byId } from './app.js';
import { $, h, toast, ago, plural, hueOf } from './ui.js';
import * as ab from './autobackup.js';
import { linksFromText } from './bookmarks.js';
import { listTrash, restoreFromTrash, deleteFromTrash, TRASH_DAYS } from './trash.js';

// ---------------- helpers ----------------

function ask(dlg, read) {
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? read() : null), { once: true });
    dlg.showModal();
  });
}

// <option>s for every group, indented by depth.
export function groupOptions(exclude = [], none = 'Top level') {
  const skip = new Set(exclude);
  return [
    h('option', { value: '', text: none }),
    ...flattenGroups(app.state.groups)
      .filter(({ group }) => !skip.has(group.id))
      .map(({ group, depth }) => h('option', { value: group.id, text: '  '.repeat(depth) + (depth ? '↳ ' : '') + group.name })),
  ];
}

// ---------------- group dialog ----------------

const swatchBox = $('#gColors');
for (const c of COLORS) {
  swatchBox.append(h('label', { title: c }, h('input', { type: 'radio', name: 'gcolor', value: c }), h('i', { style: { background: COLOR_HEX[c] } })));
}

// group: existing group (edit) or null; parentId: preselected parent for a new group.
export function askGroup(group, parentId = null) {
  const dlg = $('#dlgGroup');
  $('#gTitle').textContent = group ? 'Edit group' : parentId ? 'New subgroup' : 'New group';
  $('#gName').value = group?.name || '';
  const sel = $('#gParent');
  sel.replaceChildren(...groupOptions(group ? [group.id, ...descendantIds(app.state.groups, group.id)] : []));
  sel.value = (group ? group.parentId : parentId) || '';
  const palette = ['blue', 'green', 'orange', 'purple', 'pink', 'cyan', 'yellow', 'red'];
  const color = group?.color || palette[app.state.groups.length % palette.length];
  swatchBox.querySelector(`input[value="${color}"]`).checked = true;
  const p = ask(dlg, () => ({
    name: $('#gName').value.trim(),
    color: swatchBox.querySelector('input:checked')?.value || 'blue',
    parentId: sel.value || null,
  }));
  $('#gName').focus();
  $('#gName').select();
  return p;
}

// ---------------- item / note dialogs ----------------

export function askItem(item) {
  $('#iTitle').value = item.title || '';
  $('#iNote').value = item.note || '';
  $('#iUrl').textContent = item.url;
  return ask($('#dlgItem'), () => ({ title: $('#iTitle').value.trim(), note: $('#iNote').value.trim() }));
}

// ids: the tabs getting the note. Resolves to { text, append } or null.
export function askNote(ids) {
  const items = ids.map(byId).filter(Boolean);
  const withNotes = items.filter((i) => i.note).length;
  $('#nTitle').textContent = items.length === 1 ? (items[0].note ? 'Edit note' : 'Add a note') : `Add a note to ${plural(items.length, 'tab')}`;
  $('#nText').value = items.length === 1 ? items[0].note || '' : '';
  $('#nAppendRow').hidden = items.length < 2 || !withNotes;
  $('#nAppend').checked = true;
  const p = ask($('#dlgNote'), () => ({ text: $('#nText').value.trim(), append: !$('#nAppendRow').hidden && $('#nAppend').checked }));
  $('#nText').focus();
  return p;
}

// ---------------- reminder dialog ----------------

const pad2 = (n) => String(n).padStart(2, '0');
export const toLocalInput = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// Quick choices relative to `now` (pure, so it can be tested).
export function reminderPresets(now = new Date()) {
  const at = (days, hour) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    ['In 3 hours', now.getTime() + 3 * 3600000],
    ['Tomorrow morning', at(1, 9)],
    ['This weekend', at(((6 - now.getDay()) + 7) % 7 || 7, 10)],
    ['Next Monday', at(toMonday, 9)],
    ['In a week', at(7, 9)],
  ];
}

// Resolves to { at } (a timestamp, or null to clear) or null when cancelled.
export function askReminder(ids) {
  const items = ids.map(byId).filter(Boolean);
  const dlg = $('#dlgRemind');
  $('#rTitle').textContent = items.length === 1 ? 'Remind me about this tab' : `Remind me about ${plural(items.length, 'tab')}`;
  const current = items.length === 1 ? items[0].remindAt : 0;
  $('#rWhen').value = toLocalInput(current || reminderPresets()[1][1]);
  $('#rClear').hidden = !items.some((i) => i.remindAt);
  $('#rQuick').replaceChildren(
    ...reminderPresets().map(([label, ms]) => h('button', { type: 'button', class: 'btn', text: label, onclick: () => ($('#rWhen').value = toLocalInput(ms)) }))
  );
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener(
      'close',
      () => {
        if (dlg.returnValue === 'clear') return resolve({ at: null });
        const at = new Date($('#rWhen').value).getTime();
        resolve(dlg.returnValue === 'ok' && at ? { at } : null);
      },
      { once: true }
    );
    dlg.showModal();
  });
}

// ---------------- paste links dialog ----------------

// Resolves to { text, groupId } or null.
export function askPaste() {
  const dlg = $('#dlgPaste');
  $('#pText').value = '';
  $('#pGroup').replaceChildren(...groupOptions([], 'Ungrouped'));
  const update = () => {
    const n = linksFromText($('#pText').value).length;
    $('#pCount').textContent = n ? `${plural(n, 'link')} found.` : 'No links found yet.';
    $('#pOk').disabled = !n;
  };
  $('#pText').oninput = update;
  update();
  const p = ask(dlg, () => ({ text: $('#pText').value, groupId: $('#pGroup').value || null }));
  $('#pText').focus();
  return p;
}

// ---------------- recently deleted ----------------

export async function openTrash(onChange) {
  const dlg = $('#dlgTrash');
  const list = $('#tList');
  const boxes = new Map();
  const build = async () => {
    const entries = await listTrash();
    boxes.clear();
    $('#tHint').textContent = (await getSettings()).keepDeleted
      ? `Deleted tabs are kept for ${TRASH_DAYS} days, then removed for good. Thumbnails are fetched again after a restore.`
      : `This is switched off, so new deletions are not kept. Turn it on in Settings. What is listed here was kept earlier and still expires after ${TRASH_DAYS} days.`;
    list.replaceChildren();
    if (!entries.length) list.append(h('p', { class: 'hint', text: 'Nothing here.' }));
    for (const { item, deletedAt } of entries) {
      const cb = h('input', { type: 'checkbox' });
      boxes.set(item.id, cb);
      list.append(h('label', { class: 'row trash-row' }, cb, h('span', { class: 'trash-title', text: item.title || item.url }), h('span', { class: 'hint', text: `${item.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50)} · deleted ${ago(deletedAt)}` })));
    }
  };
  const chosen = () => {
    const ids = [...boxes].filter(([, cb]) => cb.checked).map(([id]) => id);
    return ids.length ? ids : null;
  };
  $('#tRestore').onclick = async () => {
    const n = await restoreFromTrash(chosen() || [...boxes.keys()]);
    toast(`Restored ${plural(n, 'tab')}`);
    await onChange?.();
    await build();
  };
  $('#tForever').onclick = async () => {
    const ids = chosen();
    if (!ids) return toast('Tick the tabs to delete for good');
    await deleteFromTrash(ids);
    await build();
  };
  await build();
  dlg.showModal();
}

// ---------------- groups dialog (tri-state) ----------------

// Resolves to { add: [...], remove: [...] } or null.
export function askGroups(ids) {
  const dlg = $('#dlgGroups');
  const items = ids.map(byId).filter(Boolean);
  $('#ggTitle').textContent = items.length === 1 ? 'Groups for this tab' : `Groups for ${plural(items.length, 'tab')}`;
  const initial = new Map(); // group id -> 'all' | 'some' | 'none'
  const boxes = new Map();
  const list = $('#ggList');

  const build = () => {
    const prev = new Map([...boxes].map(([id, cb]) => [id, { c: cb.checked, i: cb.indeterminate }]));
    list.replaceChildren();
    boxes.clear();
    for (const { group, depth } of flattenGroups(app.state.groups)) {
      const n = items.filter((i) => i.groupIds.includes(group.id)).length;
      if (!initial.has(group.id)) initial.set(group.id, n === 0 ? 'none' : n === items.length ? 'all' : 'some');
      const cb = h('input', { type: 'checkbox' });
      const st = initial.get(group.id);
      cb.checked = prev.has(group.id) ? prev.get(group.id).c : st === 'all';
      cb.indeterminate = prev.has(group.id) ? prev.get(group.id).i : st === 'some';
      boxes.set(group.id, cb);
      list.append(
        h('label', { class: 'gg-row', style: { paddingLeft: 8 + depth * 20 + 'px' } }, cb, h('i', { class: 'dot', style: { background: COLOR_HEX[group.color] } }), h('span', { text: group.name }))
      );
    }
    if (!app.state.groups.length) list.append(h('p', { class: 'hint', text: 'No groups yet. Create one below.' }));
  };
  build();

  $('#ggNew').onclick = async () => {
    const res = await askGroupNested();
    if (res) build();
  };

  return ask(dlg, () => {
    const add = [];
    const remove = [];
    for (const [id, cb] of boxes) {
      const was = initial.get(id);
      if (cb.indeterminate) continue;
      if (cb.checked && was !== 'all') add.push(id);
      if (!cb.checked && was !== 'none') remove.push(id);
    }
    return { add, remove };
  });
}

// Creating a group from inside another dialog: ask, create, and rebuild the caller's list.
async function askGroupNested() {
  const { createGroup } = await import('./model.js');
  const { refresh } = await import('./app.js');
  const res = await askGroup(null);
  if (!res?.name) return null;
  await createGroup(res);
  await refresh();
  return res;
}

// ---------------- plain text dialog ----------------

export function showText(title, text) {
  $('#changesTitle').textContent = title;
  $('#changesText').textContent = text;
  $('#dlgChanges').showModal();
}

// ---------------- settings ----------------

export async function refreshAutobackupStatus() {
  const status = $('#abStatus');
  if (!ab.supported()) {
    status.textContent = 'Automatic backup to a file needs the File System Access API, which this browser does not have. Use “Back up stash to a file…” in the ⋯ menu.';
    $('#abChoose').hidden = $('#abNow').hidden = $('#abOff').hidden = true;
    return;
  }
  const handle = await ab.getHandle().catch(() => null);
  const ts = await ab.lastRun().catch(() => null);
  $('#abOff').hidden = $('#abNow').hidden = !handle;
  $('#abChoose').textContent = handle ? 'Change file…' : 'Choose backup file…';
  status.textContent = handle
    ? `Saving automatically to “${handle.name}” a minute after each change${ts ? ` · last saved ${ago(ts)}` : ''}. Thumbnails are not included (they are re-fetched).`
    : 'Not set up. Pick a file (for example on your Desktop) and TabDepot keeps it up to date while a stash page is open.';
}

// "Expand all / Collapse all" for the sections of the settings dialog.
function wireToggleAll() {
  const secs = [...document.querySelectorAll('#dlgSettings details.sec')];
  const btn = $('#sToggleAll');
  const refresh = () => (btn.textContent = secs.every((d) => d.open) ? 'Collapse all' : 'Expand all');
  secs.forEach((d) => (d.ontoggle = refresh));
  btn.onclick = () => {
    const open = !secs.every((d) => d.open);
    secs.forEach((d) => (d.open = open));
    refresh();
  };
  refresh();
}

export async function openSettings(hooks = {}) {
  const s = (app.settings = await getSettings());
  $('#sIncludePinned').checked = s.includePinned;
  $('#sPreserve').checked = s.preserveChromeGroups;
  $('#sDedupe').checked = s.dedupe;
  $('#sFetch').checked = s.fetchThumbs;
  $('#sCapture').checked = s.flipCapture;
  $('#sOpenMode').value = s.openMode;
  $('#sLazy').checked = s.lazyRestore;
  $('#sSnap').checked = s.snapshots;
  wireToggleAll();
  $('#sOpenDest').value = s.openDest;
  $('#sNotify').checked = s.notifications;
  $('#sKeepDeleted').checked = s.keepDeleted;
  $('#sUpdates').checked = s.checkUpdates;
  $('#sAuto').value = s.autoStashDays;
  $('#homeUrl').value = STASH_PAGE;
  $('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
  await refreshAutobackupStatus();
  const dlg = $('#dlgSettings');
  dlg.returnValue = '';
  dlg.addEventListener(
    'close',
    async () => {
      if (dlg.returnValue !== 'ok') return;
      app.settings = await saveSettings({
        includePinned: $('#sIncludePinned').checked,
        preserveChromeGroups: $('#sPreserve').checked,
        dedupe: $('#sDedupe').checked,
        fetchThumbs: $('#sFetch').checked,
        flipCapture: $('#sCapture').checked,
        openMode: $('#sOpenMode').value,
        lazyRestore: $('#sLazy').checked,
        snapshots: $('#sSnap').checked,
        openDest: $('#sOpenDest').value,
        notifications: $('#sNotify').checked,
        keepDeleted: $('#sKeepDeleted').checked,
        checkUpdates: $('#sUpdates').checked,
        autoStashDays: Math.max(0, Math.min(365, parseInt($('#sAuto').value, 10) || 0)),
      });
      toast('Settings saved');
      hooks.onSaved?.();
    },
    { once: true }
  );
  dlg.showModal();
}

export { hueOf };
