import {
  COLORS,
  COLOR_HEX,
  DEFAULT_SETTINGS,
  getState,
  getSettings,
  saveSettings,
  mutate,
  ensureGroup,
  uid,
  hostOf,
  faviconFor,
  idbGet,
  idbPut,
  idbDel,
  idbKeys,
  STASH_PAGE,
} from './common.js';
import { restoreItems, enrichMissing, diagnoseThumbnail } from './core.js';
import { mountPicker } from './picker.js';

const $ = (s, r = document) => r.querySelector(s);

/* ---------------------------------------------------------------- helpers */

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); // custom properties need setProperty
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const ICONS = {
  restore: '<path d="M7 17 17 7M8 7h9v9"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
};
function ic(name) {
  const span = h('span', { class: 'ic' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ts) {
  const s = (ts - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  if (a < 86400 * 365) return rtf.format(Math.round(s / 86400 / 30), 'month');
  return rtf.format(Math.round(s / 86400 / 365), 'year');
}

function hueOf(str) {
  let n = 0;
  for (const c of str) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % 360;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ state */

let state = { items: [], groups: [] };
let settings = { ...DEFAULT_SETTINGS };
const ui = { progress: null, view: 'all', query: '', selected: new Set(), anchor: null, order: [], noneCollapsed: false };

const byId = (id) => state.items.find((i) => i.id === id);
const groupOf = (id) => state.groups.find((g) => g.id === id);

const sorters = {
  newest: (a, b) => b.addedAt - a.addedAt || a.order - b.order,
  oldest: (a, b) => a.addedAt - b.addedAt || a.order - b.order,
  title: (a, b) => (a.title || '').localeCompare(b.title || ''),
  domain: (a, b) => hostOf(a.url).localeCompare(hostOf(b.url)) || (a.title || '').localeCompare(b.title || ''),
};

async function refresh() {
  state = await getState();
  scheduleRender();
}
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}

/* -------------------------------------------------------------- thumbnails */

const thumbUrls = new Map(); // item id -> object URL | null
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        io.unobserve(e.target);
        loadThumb(e.target);
      }
    }
  },
  { rootMargin: '900px' }
);

function showImg(img, src) {
  img.onload = () => img.classList.add('ready');
  img.onerror = () => img.classList.remove('ready');
  img.src = src;
}

async function loadThumb(img) {
  const id = img.dataset.id;
  let url = thumbUrls.get(id);
  if (url === undefined) {
    try {
      const blob = await idbGet('thumbs', id);
      url = blob ? URL.createObjectURL(blob) : null;
    } catch {
      url = null;
    }
    thumbUrls.set(id, url);
  }
  if (url) return showImg(img, url);
  const it = byId(id);
  if (it?.ogImage) {
    img.referrerPolicy = 'no-referrer';
    showImg(img, it.ogImage);
  }
}

function pruneThumbUrls() {
  const live = new Set(state.items.map((i) => i.id));
  for (const [id, url] of thumbUrls) {
    if (!live.has(id)) {
      if (url) URL.revokeObjectURL(url);
      thumbUrls.delete(id);
    }
  }
}

async function gcThumbs() {
  try {
    const live = new Set(state.items.map((i) => i.id));
    for (const key of await idbKeys('thumbs')) if (!live.has(key)) await idbDel('thumbs', key);
  } catch {
    /* ignore */
  }
}

function refreshThumb(id) {
  const old = thumbUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  thumbUrls.delete(id);
  const img = document.querySelector(`.card[data-id="${id}"] .shot`);
  if (img) {
    img.classList.remove('ready');
    loadThumb(img);
  }
}

// thumbnails arrive in the background (from the service worker or from this page)
const channel = new BroadcastChannel('tab-stash');
channel.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'thumb') refreshThumb(m.id);
  else if (m.type === 'progress') {
    ui.progress = m.finished ? null : m;
    updateSummary();
  }
};

let enrichTimer;
function scheduleEnrich(delay = 2500) {
  clearTimeout(enrichTimer);
  enrichTimer = setTimeout(() => settings.fetchThumbs && enrichMissing().catch(() => {}), delay);
}

/* ------------------------------------------------------------- menus/toast */

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
function showMenu(anchor, entries) {
  closeMenu();
  const m = h(
    'div',
    { class: 'menu', role: 'menu' },
    entries.map((e) =>
      e.sep
        ? h('hr')
        : e.head
          ? h('div', { class: 'menu-head', text: e.head })
          : h('button', { class: 'menu-item' + (e.danger ? ' danger' : ''), onclick: () => { closeMenu(); e.onClick(); } }, e.label)
    )
  );
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const x = Math.min(r.left, innerWidth - m.offsetWidth - 8);
  let y = r.bottom + 6;
  if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - m.offsetHeight - 6);
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = y + 'px';
  openMenu = m;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
addEventListener('scroll', closeMenu, { passive: true });

let toastTimer;
function hideToast() {
  $('#toast').hidden = true;
}
function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(
    h('span', { text: msg }),
    action && h('button', { class: 'link', text: action.label, onclick: () => { hideToast(); action.onClick(); } })
  );
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 9000 : 3500);
}

/* ---------------------------------------------------------------- dialogs */

const swatchBox = $('#gColors');
for (const c of COLORS) {
  swatchBox.append(
    h('label', { title: c }, h('input', { type: 'radio', name: 'gcolor', value: c }), h('i', { style: { background: COLOR_HEX[c] } }))
  );
}

function askGroup(group) {
  return new Promise((resolve) => {
    const dlg = $('#dlgGroup');
    $('#gTitle').textContent = group ? 'Edit group' : 'New group';
    $('#gName').value = group?.name || '';
    const color = group?.color || ['blue', 'green', 'orange', 'purple', 'pink', 'cyan', 'yellow', 'red'][state.groups.length % 8];
    swatchBox.querySelector(`input[value="${color}"]`).checked = true;
    dlg.returnValue = '';
    dlg.addEventListener(
      'close',
      () => {
        if (dlg.returnValue !== 'ok') return resolve(null);
        resolve({ name: $('#gName').value.trim(), color: swatchBox.querySelector('input:checked')?.value || 'blue' });
      },
      { once: true }
    );
    dlg.showModal();
    $('#gName').focus();
    $('#gName').select();
  });
}

function askItem(item) {
  return new Promise((resolve) => {
    const dlg = $('#dlgItem');
    $('#iTitle').value = item.title || '';
    $('#iNote').value = item.note || '';
    $('#iUrl').textContent = item.url;
    const sel = $('#iGroup');
    sel.replaceChildren(
      h('option', { value: '', text: 'Ungrouped' }),
      state.groups.map((g) => h('option', { value: g.id, text: g.name }))
    );
    sel.value = item.groupId && groupOf(item.groupId) ? item.groupId : '';
    dlg.returnValue = '';
    dlg.addEventListener(
      'close',
      () => resolve(dlg.returnValue === 'ok' ? { title: $('#iTitle').value.trim(), note: $('#iNote').value.trim(), groupId: sel.value || null } : null),
      { once: true }
    );
    dlg.showModal();
  });
}

async function openSettings() {
  settings = await getSettings();
  $('#sIncludePinned').checked = settings.includePinned;
  $('#sPreserve').checked = settings.preserveChromeGroups;
  $('#sDedupe').checked = settings.dedupe;
  $('#sFetch').checked = settings.fetchThumbs;
  $('#sCapture').checked = settings.flipCapture;
  $('#sKeep').checked = settings.keepOnOpen;
  $('#sLazy').checked = settings.lazyRestore;
  $('#sAuto').value = settings.autoStashDays;
  $('#homeUrl').value = STASH_PAGE;
  $('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const dlg = $('#dlgSettings');
  dlg.returnValue = '';
  dlg.addEventListener(
    'close',
    async () => {
      if (dlg.returnValue !== 'ok') return;
      settings = await saveSettings({
        includePinned: $('#sIncludePinned').checked,
        preserveChromeGroups: $('#sPreserve').checked,
        dedupe: $('#sDedupe').checked,
        fetchThumbs: $('#sFetch').checked,
        flipCapture: $('#sCapture').checked,
        keepOnOpen: $('#sKeep').checked,
        lazyRestore: $('#sLazy').checked,
        autoStashDays: Math.max(0, Math.min(365, parseInt($('#sAuto').value, 10) || 0)),
      });
      toast('Settings saved');
    },
    { once: true }
  );
  dlg.showModal();
}

/* ---------------------------------------------------------------- actions */

async function deleteItems(ids) {
  const set = new Set(ids);
  let removed = [];
  await mutate((s) => {
    removed = s.items.filter((i) => set.has(i.id));
    s.items = s.items.filter((i) => !set.has(i.id));
  });
  ids.forEach((id) => ui.selected.delete(id));
  await refresh();
  if (!removed.length) return;
  toast(`Deleted ${plural(removed.length, 'tab')}`, {
    label: 'Undo',
    onClick: async () => {
      await mutate((s) => {
        for (const it of removed) {
          if (s.items.some((x) => x.id === it.id)) continue;
          if (it.groupId && !s.groups.some((g) => g.id === it.groupId)) it.groupId = null;
          s.items.push(it);
        }
      });
      await refresh();
    },
  });
}

async function moveItems(ids, groupId) {
  const set = new Set(ids);
  await mutate((s) => {
    for (const it of s.items) if (set.has(it.id)) it.groupId = groupId;
  });
  await refresh();
  toast(`Moved ${plural(ids.length, 'tab')} to ${groupId ? groupOf(groupId)?.name || 'group' : 'Ungrouped'}`);
}

async function moveToNewGroup(ids) {
  const res = await askGroup(null);
  if (!res) return;
  let gid;
  await mutate((s) => {
    const g = ensureGroup(s, res.name, res.color);
    g.color = res.color;
    gid = g.id;
    const set = new Set(ids);
    for (const it of s.items) if (set.has(it.id)) it.groupId = gid;
  });
  await refresh();
  toast(`Moved ${plural(ids.length, 'tab')} to ${res.name}`);
}

function moveMenu(anchor, ids) {
  showMenu(anchor, [
    { head: 'Move to' },
    { label: 'Ungrouped', onClick: () => moveItems(ids, null) },
    ...state.groups.map((g) => ({ label: g.name, onClick: () => moveItems(ids, g.id) })),
    { sep: true },
    { label: 'New group…', onClick: () => moveToNewGroup(ids) },
  ]);
}

async function restore(items, opts = {}) {
  if (items.length > 25 && !confirm(`Open ${items.length} tabs?`)) return;
  const n = await restoreItems(items, opts);
  items.forEach((i) => ui.selected.delete(i.id));
  await refresh();
  if (n) toast(`Restored ${plural(n, 'tab')}`);
}

function restoreSelected(mode) {
  const items = [...ui.selected].map(byId).filter(Boolean);
  const groups = new Set(items.map((i) => i.groupId));
  const g = groups.size === 1 ? groupOf([...groups][0]) : null;
  return restore(items, { mode, groupTitle: g?.name || 'Restored', groupColor: g?.color || 'blue' });
}

function copyLinks(items) {
  const md = items.map((i) => `- [${(i.title || i.url).replace(/[\[\]]/g, '')}](${i.url})`).join('\n');
  navigator.clipboard.writeText(md).then(() => toast(`Copied ${plural(items.length, 'link')} as Markdown`));
}

async function editItem(item) {
  const res = await askItem(item);
  if (!res) return;
  await mutate((s) => {
    const it = s.items.find((x) => x.id === item.id);
    if (it) Object.assign(it, { title: res.title || it.title, note: res.note, groupId: res.groupId });
  });
  await refresh();
}

async function editGroup(g) {
  const res = await askGroup(g);
  if (!res) return;
  await mutate((s) => {
    const x = s.groups.find((y) => y.id === g.id);
    if (x) Object.assign(x, { name: res.name, color: res.color });
  });
  await refresh();
}

async function deleteGroup(g) {
  const n = state.items.filter((i) => i.groupId === g.id).length;
  if (!confirm(`Delete the group "${g.name}"?${n ? `\n\nIts ${plural(n, 'tab')} will move to Ungrouped.` : ''}`)) return;
  await mutate((s) => {
    s.groups = s.groups.filter((x) => x.id !== g.id);
    for (const it of s.items) if (it.groupId === g.id) it.groupId = null;
  });
  if (ui.view === g.id) ui.view = 'all';
  await refresh();
}

async function toggleCollapse(g) {
  if (!g) {
    ui.noneCollapsed = !ui.noneCollapsed;
    return scheduleRender();
  }
  await mutate((s) => {
    const x = s.groups.find((y) => y.id === g.id);
    if (x) x.collapsed = !x.collapsed;
  });
  await refresh();
}

async function newGroup() {
  const res = await askGroup(null);
  if (!res) return;
  await mutate((s) => {
    const g = ensureGroup(s, res.name, res.color);
    g.color = res.color;
  });
  await refresh();
}

async function autoGroupByDomain() {
  const pool = ui.selected.size ? [...ui.selected].map(byId).filter(Boolean) : state.items.filter((i) => !i.groupId || !groupOf(i.groupId));
  const counts = new Map();
  for (const it of pool) {
    const host = hostOf(it.url);
    if (host) counts.set(host, (counts.get(host) || 0) + 1);
  }
  const hosts = new Set([...counts].filter(([, n]) => n >= 2).map(([host]) => host));
  if (!hosts.size) return toast('No site has two or more tabs to group');
  const ids = new Set(pool.map((i) => i.id));
  await mutate((s) => {
    for (const it of s.items) {
      const host = hostOf(it.url);
      if (ids.has(it.id) && hosts.has(host)) it.groupId = ensureGroup(s, host).id;
    }
  });
  await refresh();
  toast(`Created ${plural(hosts.size, 'group')} by site`);
}

async function fetchThumbsNow() {
  const res = await enrichMissing({ retry: true });
  if (res?.skipped) toast('Already fetching thumbnails…');
  else toast(res?.total ? `Fetched ${res.fetched} of ${res.total} missing thumbnails` : 'No thumbnails are missing');
}

async function removeDuplicates() {
  let removed = [];
  await mutate((s) => {
    const best = new Map();
    for (const it of s.items) {
      const cur = best.get(it.url);
      const better = !cur || (!!it.groupId && !cur.groupId) || (!!it.groupId === !!cur.groupId && it.addedAt > cur.addedAt);
      if (better) best.set(it.url, it);
    }
    const keep = new Set([...best.values()].map((i) => i.id));
    removed = s.items.filter((i) => !keep.has(i.id));
    s.items = s.items.filter((i) => keep.has(i.id));
  });
  await refresh();
  if (!removed.length) return toast('No duplicates found');
  toast(`Removed ${plural(removed.length, 'duplicate')}`, {
    label: 'Undo',
    onClick: async () => {
      await mutate((s) => s.items.push(...removed));
      await refresh();
    },
  });
}

/* ----------------------------------------------------------- import/export */

function download(name, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const FILE_TYPES = [{ description: 'Tab Stash backup', accept: { 'application/json': ['.json'] } }];
const slug = (str) => str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'tabs';

// Opens a "Save as" dialog (starting at your Desktop) and writes a backup including thumbnails.
async function saveBackup(items = state.items, label = 'all') {
  if (!items.length) return toast('Nothing to back up yet');
  const name = `tab-stash-${slug(label)}-${new Date().toISOString().slice(0, 10)}.json`;
  let handle = null;
  // The picker must be opened straight from the click, before any slow work.
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, startIn: 'desktop', types: FILE_TYPES });
    } catch (e) {
      if (e.name === 'AbortError') return;
      handle = null; // fall back to a normal download
    }
  }
  toast('Preparing backup…');
  const gids = new Set(items.map((i) => i.groupId).filter(Boolean));
  const out = [];
  for (const it of items) {
    let thumb = '';
    try {
      const blob = await idbGet('thumbs', it.id);
      if (blob) thumb = await blobToDataUrl(blob);
    } catch {
      /* no thumbnail */
    }
    out.push({ ...it, thumb });
  }
  const data = {
    app: 'tab-stash',
    version: 2,
    exportedAt: new Date().toISOString(),
    groups: state.groups.filter((g) => gids.has(g.id)),
    items: out,
  };
  const text = JSON.stringify(data);
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

async function restoreBackup() {
  if (window.showOpenFilePicker) {
    try {
      const [fh] = await window.showOpenFilePicker({ startIn: 'desktop', types: FILE_TYPES, multiple: false });
      return importFile(await fh.getFile());
    } catch (e) {
      if (e.name === 'AbortError') return;
      /* otherwise fall through to the classic file input */
    }
  }
  $('#importFile').click();
}

function exportMarkdown() {
  const lines = [];
  const line = (i) => `- [${(i.title || i.url).replace(/[\[\]]/g, '')}](${i.url})`;
  for (const g of state.groups) {
    const list = state.items.filter((i) => i.groupId === g.id);
    if (list.length) lines.push(`## ${g.name}`, ...list.map(line), '');
  }
  const rest = state.items.filter((i) => !i.groupId || !groupOf(i.groupId));
  if (rest.length) lines.push('## Ungrouped', ...rest.map(line), '');
  download('tab-stash.md', lines.join('\n'), 'text/markdown');
}

async function importFile(file) {
  const text = await file.text();
  let incoming = [];
  let incomingGroups = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.items)) {
      incoming = data.items;
      incomingGroups = Array.isArray(data.groups) ? data.groups : [];
    }
  } catch {
    const urls = text.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
    incoming = [...new Set(urls)].map((url) => ({ url, title: url }));
  }
  incoming = incoming.filter((i) => i && typeof i.url === 'string' && /^[a-z-]+:/i.test(i.url));
  if (!incoming.length) return toast('Nothing to import in that file');
  let added = 0;
  await mutate(async (s) => {
    const have = new Set(s.items.map((i) => i.url));
    const gmap = new Map();
    for (const g of incomingGroups) gmap.set(g.id, ensureGroup(s, g.name, g.color).id);
    let n = 0;
    for (const i of incoming) {
      n++;
      if (have.has(i.url)) continue;
      have.add(i.url);
      const id = uid();
      s.items.push({
        id,
        url: i.url,
        title: String(i.title || i.url),
        description: String(i.description || ''),
        ogImage: String(i.ogImage || ''),
        addedAt: Number(i.addedAt) || Date.now(),
        order: n,
        groupId: gmap.get(i.groupId) || null,
        note: String(i.note || ''),
      });
      added++;
      if (typeof i.thumb === 'string' && i.thumb.startsWith('data:image/')) {
        try {
          await idbPut('thumbs', id, await (await fetch(i.thumb)).blob());
        } catch {
          /* skip bad thumbnail */
        }
      }
    }
  });
  await refresh();
  toast(`Restored ${plural(added, 'tab')} from file${added < incoming.length ? ` (${incoming.length - added} already in your stash)` : ''}`);
}

/* --------------------------------------------------------------- rendering */

function visibleItems() {
  const toks = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return state.items;
  const gname = new Map(state.groups.map((g) => [g.id, g.name]));
  return state.items.filter((it) => {
    const hay = `${it.title} ${it.url} ${it.description} ${it.note || ''} ${gname.get(it.groupId) || ''}`.toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}

function render() {
  for (const id of [...ui.selected]) if (!byId(id)) ui.selected.delete(id);
  if (ui.view !== 'all' && ui.view !== 'none' && !groupOf(ui.view)) ui.view = 'all';
  pruneThumbUrls();
  renderSide();
  renderMain();
  renderSelbar();
  updateSummary();
}

function updateSummary() {
  const p = ui.progress;
  $('#summary').textContent =
    `${plural(state.items.length, 'tab')} stashed · ${plural(state.groups.length, 'group')}` +
    (p ? ` · fetching thumbnails ${p.done}/${p.total}` : '');
}

function renderSide() {
  const side = $('#side');
  const inGroup = new Set(state.groups.map((g) => g.id));
  const ungrouped = state.items.filter((i) => !i.groupId || !inGroup.has(i.groupId)).length;
  const nav = (view, label, n, color, drop) =>
    h(
      'button',
      { class: 'nav' + (ui.view === view ? ' active' : ''), dataset: drop ? { drop } : {}, onclick: () => { ui.view = view; render(); } },
      h('span', { class: 'dot', style: { background: color || 'transparent', border: color ? '' : '2px solid var(--muted)' } }),
      h('span', { class: 'label', text: label }),
      h('span', { class: 'n', text: n })
    );
  side.replaceChildren(
    nav('all', 'All tabs', state.items.length, null),
    nav('none', 'Ungrouped', ungrouped, '#9aa0a6', 'none'),
    h('div', { class: 'side-sep' }),
    ...state.groups.map((g) => nav(g.id, g.name, state.items.filter((i) => i.groupId === g.id).length, COLOR_HEX[g.color], g.id)),
    h('button', { class: 'nav side-add', onclick: newGroup }, h('span', { class: 'label', text: '+ New group' }))
  );
}

function renderMain() {
  const y = window.scrollY;
  const main = $('#main');
  main.replaceChildren();
  ui.order = [];

  if (!state.items.length) {
    main.append(
      h(
        'div',
        { class: 'welcome' },
        h('h2', { text: 'Your stash is empty' }),
        h('p', {}, 'Click the Tab Stash button in the toolbar to stash the current tab, a whole window, or everything at once. Or press ', h('kbd', { text: 'Alt+Shift+S' }), ' to stash the tab you are on.'),
        h('p', {}, 'Stashed tabs are closed, so they use no memory at all. Come back here to search, group and reopen them.'),
        h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } },
          h('button', { class: 'btn primary', onclick: openPicker }, 'Choose tabs to stash…'),
          h('button', { class: 'btn', onclick: restoreBackup }, 'Restore from backup file…'))
      )
    );
    return;
  }

  const list = visibleItems().slice().sort(sorters[settings.sort] || sorters.newest);
  const buckets = new Map();
  for (const it of list) {
    const k = it.groupId && groupOf(it.groupId) ? it.groupId : 'none';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }

  const sections = [];
  if (ui.view === 'all') {
    for (const g of state.groups) {
      const items = buckets.get(g.id) || [];
      if (items.length || !ui.query) sections.push({ g, items });
    }
    const none = buckets.get('none') || [];
    if (none.length) sections.push({ g: null, items: none });
  } else if (ui.view === 'none') {
    sections.push({ g: null, items: buckets.get('none') || [] });
  } else {
    sections.push({ g: groupOf(ui.view), items: buckets.get(ui.view) || [] });
  }

  if (!list.length && ui.query) {
    main.append(h('div', { class: 'empty-hint', text: `No tabs match “${ui.query}”.` }));
  }
  for (const sec of sections) main.append(sectionEl(sec));
  window.scrollTo(0, y);
}

function sectionEl({ g, items }) {
  const collapsed = ui.view === 'all' && (g ? g.collapsed : ui.noneCollapsed);
  const name = g ? g.name : 'Ungrouped';
  const ids = items.map((i) => i.id);

  const actions = h('div', { class: 'sec-actions' });
  if (items.length) {
    actions.append(
      h('button', { class: 'sbtn', title: 'Select all in this section', onclick: () => {
        const all = ids.every((id) => ui.selected.has(id));
        ids.forEach((id) => (all ? ui.selected.delete(id) : ui.selected.add(id)));
        syncSelection();
      } }, ic('select'), 'Select'),
      h('button', { class: 'sbtn', onclick: (e) => showMenu(e.currentTarget, [
        { label: `Restore all ${items.length}`, onClick: () => restore(items) },
        { label: 'Restore as a Chrome tab group', onClick: () => restore(items, { mode: 'group', groupTitle: name, groupColor: g?.color || 'grey' }) },
        { label: 'Restore in a new window', onClick: () => restore(items, { mode: 'window' }) },
        { sep: true },
        { label: 'Copy links as Markdown', onClick: () => copyLinks(items) },
        { label: 'Save these to a file…', onClick: () => saveBackup(items, name) },
      ]) }, ic('restore'), 'Restore ▾')
    );
  }
  if (g) {
    actions.append(
      h('button', { class: 'sbtn', title: 'Rename / recolour', onclick: () => editGroup(g) }, ic('edit')),
      h('button', { class: 'sbtn danger', title: 'Delete group (tabs move to Ungrouped)', onclick: () => deleteGroup(g) }, ic('trash'))
    );
  } else if (items.length > 1) {
    actions.append(h('button', { class: 'sbtn', title: 'Create a group for every site that has 2+ tabs', onclick: autoGroupByDomain }, ic('folder'), 'Group by site'));
  }

  const head = h(
    'div',
    { class: 'sec-head', dataset: { drop: g ? g.id : 'none' } },
    h('button', { class: 'sec-toggle', title: 'Collapse / expand', onclick: () => ui.view === 'all' && toggleCollapse(g) }, ic('chevron')),
    h('span', { class: 'dot', style: { background: g ? COLOR_HEX[g.color] : '#9aa0a6' } }),
    h('h2', { text: name, onclick: () => ui.view === 'all' && toggleCollapse(g) }),
    h('span', { class: 'count', text: items.length }),
    actions
  );

  const sec = h('section', { class: 'section' + (collapsed ? ' collapsed' : '') }, head);
  if (collapsed) return sec;
  if (!items.length) {
    sec.append(h('div', { class: 'empty-hint', text: 'No tabs here yet. Drag cards onto this group, or use “Move to…”.' }));
    return sec;
  }
  ui.order.push(...ids);
  sec.append(h('div', { class: 'grid' }, items.map(cardEl)));
  return sec;
}

function cardEl(it) {
  const host = hostOf(it.url) || it.url.split(':')[0];
  const sel = ui.selected.has(it.id);

  const img = h('img', { class: 'shot', alt: '', draggable: 'false', dataset: { id: it.id } });
  const cached = thumbUrls.get(it.id);
  if (cached) showImg(img, cached);
  else io.observe(img);

  const fav = h('img', { src: faviconFor(it.url), alt: '', onerror: (e) => e.currentTarget.remove() });

  const card = h(
    'article',
    { class: 'card' + (sel ? ' sel' : ''), draggable: 'true', dataset: { id: it.id }, title: it.url },
    h('input', { class: 'chk', type: 'checkbox', checked: sel, title: 'Select (Shift-click for a range)', onclick: (e) => { e.stopPropagation(); toggleSelect(it.id, e.shiftKey, e.currentTarget.checked); } }),
    h(
      'div',
      { class: 'acts' },
      h('button', { class: 'act', title: 'Restore tab', onclick: (e) => { e.stopPropagation(); restore([it]); } }, ic('restore')),
      h('button', { class: 'act', title: 'More', onclick: (e) => { e.stopPropagation(); cardMenu(e.currentTarget, it); } }, ic('more')),
      h('button', { class: 'act danger', title: 'Delete', onclick: (e) => { e.stopPropagation(); deleteItems([it.id]); } }, ic('x'))
    ),
    h(
      'div',
      { class: 'thumb' },
      h('div', { class: 'ph', style: { '--h': hueOf(host) } }, (host[0] || '?')),
      img,
      h('div', { class: 'chip' }, fav, h('span', { text: host }))
    ),
    h(
      'div',
      { class: 'body' },
      h('h3', { class: 'title', text: it.title || it.url }),
      it.description && h('p', { class: 'desc', text: it.description }),
      it.note && h('p', { class: 'note', text: it.note }),
      h('div', { class: 'meta', text: `Stashed ${ago(it.addedAt)}` })
    )
  );

  card.addEventListener('click', (e) => {
    if (e.target.closest('.act, .chk')) return;
    if (ui.selected.size || e.shiftKey || e.ctrlKey || e.metaKey) {
      toggleSelect(it.id, e.shiftKey);
    } else {
      restore([it]);
    }
  });
  card.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      restore([it], { background: true });
    }
  });
  card.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
  });
  card.addEventListener('dragstart', (e) => {
    const ids = ui.selected.has(it.id) ? [...ui.selected] : [it.id];
    e.dataTransfer.setData('application/x-tab-stash', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

function cardMenu(anchor, it) {
  showMenu(anchor, [
    { label: 'Open (keep in stash)', onClick: () => restore([it], { keep: true }) },
    { label: 'Open in new window', onClick: () => restore([it], { mode: 'window' }) },
    { label: 'Copy link', onClick: () => navigator.clipboard.writeText(it.url).then(() => toast('Link copied')) },
    { label: 'Edit title / note…', onClick: () => editItem(it) },
    { label: 'Diagnose thumbnail…', onClick: () => diagnose(it) },
    { label: 'Refresh thumbnail', onClick: () => enrichMissing({ ids: [it.id], force: true }).then(() => toast('Thumbnail refreshed')) },
    { sep: true },
    { head: 'Move to' },
    { label: 'Ungrouped', onClick: () => moveItems([it.id], null) },
    ...state.groups.map((g) => ({ label: g.name, onClick: () => moveItems([it.id], g.id) })),
    { label: 'New group…', onClick: () => moveToNewGroup([it.id]) },
    { sep: true },
    { label: 'Delete', danger: true, onClick: () => deleteItems([it.id]) },
  ]);
}

/* ---------------------------------------------------------------- selection */

function toggleSelect(id, range, forceOn) {
  if (range && ui.anchor && ui.order.includes(ui.anchor)) {
    const a = ui.order.indexOf(ui.anchor);
    const b = ui.order.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (const x of ui.order.slice(lo, hi + 1)) ui.selected.add(x);
  } else if (forceOn === true || (forceOn === undefined && !ui.selected.has(id))) {
    ui.selected.add(id);
  } else {
    ui.selected.delete(id);
  }
  ui.anchor = id;
  syncSelection();
}

function syncSelection() {
  for (const card of document.querySelectorAll('.card')) {
    const on = ui.selected.has(card.dataset.id);
    card.classList.toggle('sel', on);
    card.querySelector('.chk').checked = on;
  }
  renderSelbar();
}

function clearSelection() {
  ui.selected.clear();
  ui.anchor = null;
  syncSelection();
}

function renderSelbar() {
  const bar = $('#selbar');
  const n = ui.selected.size;
  document.body.classList.toggle('selecting', n > 0);
  bar.hidden = n === 0;
  if (!n) return;
  const tb = (label, icon, onclick, cls = '') => h('button', { class: 'tb ' + cls, onclick }, ic(icon), h('span', { text: label }));
  const items = () => [...ui.selected].map(byId).filter(Boolean);
  bar.replaceChildren(
    h('span', { class: 'sel-count', text: `${n} selected` }),
    tb('Restore', 'restore', () => restoreSelected('tabs')),
    tb('As tab group', 'folder', () => restoreSelected('group')),
    tb('New window', 'window', () => restoreSelected('window')),
    tb('Move to…', 'folder', (e) => moveMenu(e.currentTarget, [...ui.selected])),
    tb('Copy links', 'link', () => copyLinks(items())),
    tb('Save to file', 'folder', () => saveBackup(items(), 'selection')),
    tb('Delete', 'trash', () => deleteItems([...ui.selected]), 'danger'),
    h('button', { class: 'tb x', title: 'Clear selection (Esc)', onclick: clearSelection }, ic('x'))
  );
}

/* ---------------------------------------------------------- header + events */

async function openPicker() {
  const dlg = $('#dlgPick');
  const close = () => dlg.open && dlg.close();
  await mountPicker($('#pickRoot'), {
    groups: state.groups,
    onCancel: close,
    onDone: (res) => {
      close();
      toast(res?.count ? `Stashed ${plural(res.count, 'tab')}` : 'Nothing to stash');
    },
  });
  dlg.showModal();
}

function stashMenu(anchor) {
  const go = async (scope) => {
    toast('Stashing…');
    const res = await chrome.runtime.sendMessage({ type: 'stash', scope });
    toast(res?.count ? `Stashed ${plural(res.count, 'tab')}` : 'No other tabs to stash');
  };
  showMenu(anchor, [
    { label: 'Choose tabs to stash…', onClick: openPicker },
    { sep: true },
    { label: 'Stash all tabs in this window', onClick: () => go('window') },
    { label: 'Stash every tab in every window', onClick: () => go('all') },
  ]);
}

function toolsMenu(anchor) {
  showMenu(anchor, [
    { label: 'Group ungrouped tabs by site', onClick: autoGroupByDomain },
    { label: 'Remove duplicate links', onClick: removeDuplicates },
    { label: 'Fetch missing thumbnails now', onClick: fetchThumbsNow },
    { label: 'Select all (Ctrl/⌘ A)', onClick: () => { ui.order.forEach((id) => ui.selected.add(id)); syncSelection(); } },
    { sep: true },
    { label: 'Back up stash to a file…', onClick: () => saveBackup() },
    { label: 'Restore from a backup file…', onClick: restoreBackup },
    { label: 'Export as Markdown', onClick: exportMarkdown },
    { label: 'Import a plain list of links…', onClick: () => $('#importFile').click() },
    { sep: true },
    { label: 'Settings…', onClick: openSettings },
  ]);
}

let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    ui.query = e.target.value.trim();
    scheduleRender();
  }, 120);
});
$('#sort').addEventListener('change', async (e) => {
  settings = await saveSettings({ sort: e.target.value });
  scheduleRender();
});
$('#size').addEventListener('input', (e) => document.documentElement.style.setProperty('--card', e.target.value + 'px'));
$('#size').addEventListener('change', async (e) => {
  settings = await saveSettings({ cardSize: Number(e.target.value) });
});
$('#stashBtn').addEventListener('click', (e) => stashMenu(e.currentTarget));
$('#toolsBtn').addEventListener('click', (e) => toolsMenu(e.currentTarget));
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await importFile(f);
});

// drag & drop onto sidebar entries / section headers
document.addEventListener('dragover', (e) => {
  const t = e.target.closest?.('[data-drop]');
  document.querySelectorAll('.drop-over').forEach((el) => el !== t && el.classList.remove('drop-over'));
  if (t && e.dataTransfer.types.includes('application/x-tab-stash')) {
    e.preventDefault();
    t.classList.add('drop-over');
  }
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
});
document.addEventListener('drop', (e) => {
  const t = e.target.closest?.('[data-drop]');
  document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
  const raw = e.dataTransfer.getData('application/x-tab-stash');
  if (!t || !raw) return;
  e.preventDefault();
  const target = t.dataset.drop === 'none' ? null : t.dataset.drop;
  moveItems(JSON.parse(raw), target);
});

// keyboard
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.key === '/' && !typing(e)) {
    e.preventDefault();
    $('#q').focus();
  } else if (e.key === 'Escape') {
    closeMenu();
    if (document.activeElement === $('#q')) $('#q').blur();
    else clearSelection();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing(e) && ui.selected.size) {
    e.preventDefault();
    deleteItems([...ui.selected]);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !typing(e)) {
    e.preventDefault();
    ui.order.forEach((id) => ui.selected.add(id));
    syncSelection();
  }
});

// live updates when the background worker (or another stash tab) changes the data
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.state) {
    refresh();
    scheduleEnrich();
  }
  if (changes.settings) getSettings().then((s) => { settings = s; applySettings(); scheduleRender(); });
});

function applySettings() {
  document.documentElement.style.setProperty('--card', settings.cardSize + 'px');
  $('#size').value = settings.cardSize;
  $('#sort').value = settings.sort;
}

$('#copyHome').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  navigator.clipboard.writeText(STASH_PAGE).then(() => {
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = 'Copy'), 2000);
  });
});
$('#openStartup').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/onStartup' }));
$('#openAppearance').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/appearance' }));
$('#homeUrl').addEventListener('focus', (e) => e.target.select());

function showText(title, text) {
  $('#changesTitle').textContent = title;
  $('#changesText').textContent = text;
  $('#dlgChanges').showModal();
}

async function diagnose(item) {
  toast('Checking…');
  showText('Thumbnail diagnosis', await diagnoseThumbnail(item));
  hideToast();
}

async function showChanges() {
  let text = 'Could not load the changelog.';
  try {
    text = await (await fetch(chrome.runtime.getURL('CHANGELOG.md'))).text();
  } catch {
    /* keep fallback */
  }
  showText("What's new", text);
}
$('#whatsNew').addEventListener('click', showChanges);
$('#reloadExt').addEventListener('click', () => chrome.runtime.reload());

function checkHash() {
  if (location.hash === '#settings') {
    history.replaceState(null, '', location.pathname);
    openSettings();
  }
}
addEventListener('hashchange', checkHash);

/* -------------------------------------------------------------------- boot */

(async function boot() {
  settings = await getSettings();
  applySettings();
  state = await getState();
  render();
  gcThumbs();
  checkHash();
  announceUpdate();
  scheduleEnrich(600);
})();

// After an update, tell the user once and offer the changelog.
async function announceUpdate() {
  const { updatedFrom } = await chrome.storage.local.get('updatedFrom');
  if (!updatedFrom) return;
  await chrome.storage.local.remove('updatedFrom');
  const now = chrome.runtime.getManifest().version;
  toast(`Tab Stash updated ${updatedFrom} → ${now}`, { label: "What's new", onClick: showChanges });
}
