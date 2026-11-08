import {
  COLOR_HEX,
  getState,
  getSettings,
  saveSettings,
  hostOf,
  faviconFor,
  idbGet,
  idbPut,
  idbDel,
  idbKeys,
  childGroups,
  descendantIds,
  groupPath,
  STASH_PAGE,
} from './common.js';
import { restoreItems, enrichMissing } from './core.js';
import { mountPicker } from './picker.js';
import * as model from './model.js';
import { listSnapshots, getSnapshot } from './snapshots.js';
import { app, byId, groupOf, refresh, done, doUndo, selectedItems } from './app.js';
import { $, h, ic, ago, hueOf, plural, showMenu, closeMenu, toast, hideToast, setBanner } from './ui.js';
import * as act from './actions.js';
import { REPO } from './updater.js';
import { openSettings, openTrash, showText, refreshAutobackupStatus } from './dialogs.js';
import { openSnapshots } from './snapui.js';
import { startTriage } from './triage.js';
import { initUpdates, checkNow, rollbackNow } from './updateui.js';
import { watchStale } from './stale.js';

const ui = app.ui;
const DAY = 86400_000;

/* ----------------------------------------------------------- data selection */

const sorters = {
  newest: (a, b) => b.addedAt - a.addedAt || a.order - b.order,
  oldest: (a, b) => a.addedAt - b.addedAt || a.order - b.order,
  title: (a, b) => (a.title || '').localeCompare(b.title || ''),
  domain: (a, b) => hostOf(a.url).localeCompare(hostOf(b.url)) || (a.title || '').localeCompare(b.title || ''),
};

const filtersActive = () => !!(ui.query || ui.filters.site || ui.filters.age || ui.filters.note || ui.filters.link || ui.filters.remind);

function passes(it, toks, names) {
  const f = ui.filters;
  if (toks.length) {
    const hay = `${it.title} ${it.url} ${it.description} ${it.note || ''} ${it.groupIds.map((g) => names.get(g) || '').join(' ')}`.toLowerCase();
    if (!toks.every((t) => hay.includes(t))) return false;
  }
  if (f.site && !hostOf(it.url).includes(f.site.toLowerCase().replace(/^www\./, ''))) return false;
  if (f.age && Date.now() - it.addedAt < f.age * DAY) return false;
  if (f.note && !it.note) return false;
  if (f.remind && !it.remindAt) return false;
  if (f.link) {
    const st = it.link?.status;
    if (f.link === 'unchecked' ? !!it.link : f.link === 'bad' ? !(st === 'dead' || st === 'error') : st !== f.link) return false;
  }
  return true;
}

// ids of every item that passes the search + filters (whole stash, whatever the current view)
function matching() {
  const toks = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  const names = new Map(app.state.groups.map((g) => [g.id, groupPath(app.state.groups, g.id)]));
  return new Set(app.state.items.filter((it) => passes(it, toks, names)).map((i) => i.id));
}
let match = new Set();

const inSection = (it, key) => (key === 'none' ? !it.groupIds.length : it.groupIds.includes(key));

function sortSection(list, key) {
  const mode = app.settings.sort;
  if (mode === 'manual') {
    const pos = new Map((app.state.orders[key] || []).map((id, n) => [id, n]));
    return list.slice().sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : -1) - (pos.has(b.id) ? pos.get(b.id) : -1) || sorters.newest(a, b));
  }
  return list.slice().sort(sorters[mode] || sorters.newest);
}

// all: ignore search and filters (used when saving a manual order)
const itemsOf = (key, all = false) => sortSection(app.state.items.filter((it) => inSection(it, key) && (all || match.has(it.id))), key);

const subtreeIds = (gid) => {
  const set = new Set([gid, ...descendantIds(app.state.groups, gid)]);
  return new Set(app.state.items.filter((i) => i.groupIds.some((g) => set.has(g))).map((i) => i.id));
};

// items belonging to the current view and matching search/filters (collapsed sections included)
function viewIds() {
  const v = ui.view;
  const scope = v === 'all' ? null : v === 'none' ? new Set(app.state.items.filter((i) => !i.groupIds.length).map((i) => i.id)) : subtreeIds(v);
  return [...match].filter((id) => !scope || scope.has(id));
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

function refreshThumb(id) {
  const old = thumbUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  thumbUrls.delete(id);
  for (const img of document.querySelectorAll(`.card[data-id="${id}"] .shot`)) {
    img.classList.remove('ready');
    loadThumb(img);
  }
}

function pruneThumbUrls() {
  const live = new Set(app.state.items.map((i) => i.id));
  for (const [id, url] of thumbUrls) {
    if (!live.has(id)) {
      if (url) URL.revokeObjectURL(url);
      thumbUrls.delete(id);
    }
  }
}

// Once a day: drop stored thumbnails of tabs that are neither in the stash nor in a stash snapshot.
async function gcThumbs() {
  try {
    const last = await idbGet('meta', 'thumbGc');
    if (last && Date.now() - last < DAY) return;
    const live = new Set(app.state.items.map((i) => i.id));
    for (const s of await listSnapshots('stash')) {
      const snap = await getSnapshot(s.id);
      snap?.data?.items?.forEach((i) => live.add(i.id));
    }
    for (const key of await idbKeys('thumbs')) if (!live.has(key)) await idbDel('thumbs', key);
    await idbPut('meta', 'thumbGc', Date.now());
  } catch {
    /* ignore */
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
  enrichTimer = setTimeout(() => app.settings.fetchThumbs && enrichMissing().catch(() => {}), delay);
}

/* ---------------------------------------------------------------- rendering */

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}
app.render = scheduleRender;

function render() {
  const { state } = app;
  for (const id of [...ui.selected]) if (!byId(id)) ui.selected.delete(id);
  if (ui.view !== 'all' && ui.view !== 'none' && !groupOf(ui.view)) ui.view = 'all';
  match = matching();
  pruneThumbUrls();
  renderSide();
  renderMain();
  renderSelbar();
  renderFilters();
  updateSummary();
  applyCursor(false);
}

function updateSummary() {
  const p = ui.progress;
  const { state } = app;
  $('#summary').textContent =
    `${plural(state.items.length, 'tab')} stashed · ${plural(state.groups.length, 'group')}` + (p ? ` · fetching thumbnails ${p.done}/${p.total}` : '');
}

/* ------------------------------------------------------------------ sidebar */

let drag = null; // { kind: 'items', ids, from, sectionKey } | { kind: 'group', id }

function navRow({ label, count, color, active, onclick, drop, indent = 0, g = null }) {
  const row = h('div', {
    class: 'nav' + (active ? ' active' : ''),
    role: 'button',
    tabindex: '0',
    style: { paddingLeft: 8 + indent * 16 + 'px' },
    dataset: { ...(drop ? { drop } : {}), ...(g ? { gid: g.id } : {}) },
    draggable: g ? 'true' : null,
    onclick,
    onkeydown: (e) => {
      if (e.key === 'Enter' && e.target === row) onclick();
    },
  });
  const kids = g ? childGroups(app.state.groups, g.id) : [];
  row.append(
    ...[
    g
      ? kids.length
        ? h('button', { class: 'exp' + (g.treeCollapsed ? ' closed' : ''), title: g.treeCollapsed ? 'Show subgroups' : 'Hide subgroups', onclick: (e) => { e.stopPropagation(); model.setGroupFlag(g.id, 'treeCollapsed', !g.treeCollapsed).then(refresh); } }, ic('chevron'))
        : h('span', { class: 'exp-spacer' })
      : null,
    h('span', { class: 'dot', style: { background: color || 'transparent', border: color ? '' : '2px solid var(--muted)' } }),
    h('span', { class: 'label', text: label }),
    g && h('button', { class: 'pencil', title: 'Rename, recolour or move this group', onclick: (e) => { e.stopPropagation(); act.editGroup(g); } }, ic('edit')),
    h('span', { class: 'n', text: count })
    ].filter(Boolean)
  );
  if (g) {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      groupMenu({ x: e.clientX, y: e.clientY }, g);
    });
  }
  return row;
}

function groupMenu(anchor, g) {
  showMenu(anchor, [
    { label: 'Rename / recolour / move…', onClick: () => act.editGroup(g) },
    { label: 'New subgroup…', onClick: () => act.newGroup(g.id) },
    { sep: true },
    { label: 'Open all tabs in this group…', onClick: () => act.openMenu(anchor, app.state.items.filter((i) => i.groupIds.includes(g.id)), g) },
    { label: 'Delete group…', danger: true, onClick: () => act.removeGroup(g) },
  ]);
}

function renderSide() {
  const { state } = app;
  const side = $('#side');
  const ungrouped = state.items.filter((i) => !i.groupIds.length).length;
  const tree = [];
  const walk = (pid, depth) => {
    for (const g of childGroups(state.groups, pid)) {
      tree.push(navRow({ label: g.name, count: subtreeIds(g.id).size, color: COLOR_HEX[g.color], active: ui.view === g.id, onclick: () => setView(g.id), drop: g.id, indent: depth, g }));
      if (!g.treeCollapsed) walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  side.replaceChildren(
    navRow({ label: 'All tabs', count: state.items.length, active: ui.view === 'all', onclick: () => setView('all') }),
    navRow({ label: 'Ungrouped', count: ungrouped, color: '#9aa0a6', active: ui.view === 'none', onclick: () => setView('none'), drop: 'none' }),
    h('div', { class: 'side-sep' }),
    ...tree,
    h('button', { class: 'nav side-add', onclick: () => act.newGroup(ui.view !== 'all' && ui.view !== 'none' ? ui.view : null) }, h('span', { class: 'label', text: ui.view !== 'all' && ui.view !== 'none' ? '+ New subgroup here' : '+ New group' })),
    h('div', { class: 'side-root-drop', dataset: { rootDrop: '1' }, text: 'Drop a group here to make it top-level' })
  );
}

function setView(v) {
  ui.view = v;
  render();
  window.scrollTo(0, 0);
}

/* --------------------------------------------------------------------- main */

function renderMain() {
  const { state } = app;
  const y = window.scrollY;
  const main = $('#main');
  main.replaceChildren();
  ui.order = [];
  const seen = new Set();
  const note = (ids) => ids.forEach((id) => !seen.has(id) && (seen.add(id), ui.order.push(id)));

  if (!state.items.length && !state.groups.length) {
    main.append(
      h('div', { class: 'welcome' },
        h('h2', { text: 'Your stash is empty' }),
        h('p', {}, 'Click the TabDepot button in the toolbar to stash the current tab, a whole window, or everything at once. Or press ', h('kbd', { text: 'Alt+Shift+S' }), ' to stash the tab you are on.'),
        h('p', {}, 'Stashed tabs are closed, so they use no memory at all. Come back here to search, group and reopen them.'),
        h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } },
          h('button', { class: 'btn primary', onclick: openPicker }, 'Choose tabs to stash…'),
          h('button', { class: 'btn', onclick: act.restoreBackup }, 'Restore from backup file…')))
    );
    return;
  }

  const sectionEl = (g, depth) => {
    const key = g ? g.id : 'none';
    const own = itemsOf(key);
    const kidEls = g ? childGroups(state.groups, g.id).map((c) => sectionEl(c, depth + 1)).filter(Boolean) : [];
    if (filtersActive() && !own.length && !kidEls.length) return null;
    const rootOfView = g && ui.view === g.id && depth === 0;
    const collapsed = !rootOfView && (g ? g.collapsed : ui.noneCollapsed);
    const name = g ? g.name : 'Ungrouped';
    const toggle = () => {
      if (rootOfView) return;
      if (g) model.setGroupFlag(g.id, 'collapsed', !g.collapsed).then(refresh);
      else {
        ui.noneCollapsed = !ui.noneCollapsed;
        render();
      }
    };

    const ids = own.map((i) => i.id);
    const actions = h('div', { class: 'sec-actions' });
    if (own.length) {
      actions.append(
        h('button', { class: 'sbtn', title: 'Select all in this section', onclick: () => {
          const all = ids.every((id) => ui.selected.has(id));
          ids.forEach((id) => (all ? ui.selected.delete(id) : ui.selected.add(id)));
          syncSelection();
        } }, ic('select'), 'Select'),
        h('button', { class: 'sbtn', onclick: (e) => act.openMenu(e.currentTarget, own, g) }, ic('restore'), 'Open ▾')
      );
    }
    if (g) {
      actions.append(
        h('button', { class: 'sbtn', title: 'Add a subgroup', onclick: () => act.newGroup(g.id) }, ic('plus'), 'Subgroup'),
        h('button', { class: 'sbtn danger', title: 'Delete group', onclick: () => act.removeGroup(g) }, ic('trash'))
      );
    } else if (own.length > 1) {
      actions.append(h('button', { class: 'sbtn', title: 'Create a group for every site that has 2+ tabs', onclick: act.autoGroupBySite }, ic('folder'), 'Group by site'));
    }

    const head = h(
      'div',
      { class: 'sec-head', dataset: { drop: key } },
      h('button', { class: 'sec-toggle', title: 'Collapse / expand', onclick: toggle }, ic('chevron')),
      h('span', { class: 'dot', style: { background: g ? COLOR_HEX[g.color] : '#9aa0a6' } }),
      h('h2', { text: name, onclick: toggle }),
      g && h('button', { class: 'pencil', title: 'Rename, recolour or move this group', onclick: () => act.editGroup(g) }, ic('edit')),
      h('span', { class: 'count', text: own.length }),
      actions
    );

    const sec = h('section', { class: 'section' + (collapsed ? ' collapsed' : '') + (depth ? ' sub' : ''), dataset: { key } }, head);
    if (collapsed) return sec;
    if (own.length) {
      note(ids);
      sec.append(h('div', { class: 'grid' }, own.map((it) => cardEl(it, key))));
    } else if (!kidEls.length && !filtersActive()) {
      sec.append(h('div', { class: 'empty-hint', dataset: { drop: key }, text: 'No tabs here yet. Drag cards onto this group, or use “Move to…”.' }));
    }
    sec.append(...kidEls);
    return sec;
  };

  const roots = ui.view === 'all' ? childGroups(state.groups, null) : ui.view === 'none' ? [] : [groupOf(ui.view)];
  const els = roots.map((g) => sectionEl(g, 0)).filter(Boolean);
  if (ui.view === 'all' || ui.view === 'none') {
    const none = sectionEl(null, 0);
    if (none && (ui.view === 'none' || itemsOf('none').length)) els.push(none);
  }
  if (filtersActive() && !match.size) main.append(h('div', { class: 'empty-hint', text: ui.query ? `No tabs match “${ui.query}”${Object.values(ui.filters).some(Boolean) ? ' with these filters' : ''}.` : 'No tabs match these filters.' }));
  main.append(...els);
  window.scrollTo(0, y);
}

function linkBadge(it) {
  const st = it.link?.status;
  if (!st || st === 'ok') return null;
  const text = st === 'dead' ? 'Dead link' : st === 'blocked' ? 'Restricted' : 'Unreachable';
  const tip = `${it.link.detail || ''} (HTTP ${it.link.code || 'no response'}), checked ${ago(it.link.checkedAt)}`.trim();
  return h('span', { class: 'badge ' + st, title: tip, text });
}

function reminderLine(it) {
  if (!it.remindAt) return null;
  const due = it.remindAt <= Date.now();
  const when = new Date(it.remindAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return h('p', { class: 'remind' + (due ? ' due' : ''), title: 'Click to change or clear this reminder', onclick: (e) => { e.stopPropagation(); act.reminderDialog([it.id]); } }, due ? `⏰ Due · ${when}` : `⏰ ${when}`);
}

function cardEl(it, key) {
  const host = hostOf(it.url) || it.url.split(':')[0];
  const sel = ui.selected.has(it.id);

  const img = h('img', { class: 'shot', alt: '', draggable: 'false', dataset: { id: it.id } });
  const cached = thumbUrls.get(it.id);
  if (cached) showImg(img, cached);
  else io.observe(img);

  const fav = h('img', { src: faviconFor(it.url), alt: '', onerror: (e) => e.currentTarget.remove() });
  const others = it.groupIds.filter((g) => g !== key && groupOf(g)).map((g) => groupPath(app.state.groups, g));

  const card = h(
    'article',
    { class: 'card' + (sel ? ' sel' : ''), draggable: 'true', dataset: { id: it.id, key, k: `${it.id}|${key}` }, title: it.url },
    h('input', { class: 'chk', type: 'checkbox', checked: sel, title: 'Select (Shift-click for a range)', onclick: (e) => { e.stopPropagation(); toggleSelect(it.id, e.shiftKey, e.currentTarget.checked); } }),
    h('div', { class: 'acts' },
      h('button', { class: 'act', title: 'Open and remove from the stash', onclick: (e) => { e.stopPropagation(); act.openItems([it], { keep: false }); } }, ic('restore')),
      h('button', { class: 'act', title: 'Open and keep in the stash', onclick: (e) => { e.stopPropagation(); act.openItems([it], { keep: true }); } }, ic('keep')),
      h('button', { class: 'act', title: 'More', onclick: (e) => { e.stopPropagation(); cardMenu(e.currentTarget, it, key); } }, ic('more')),
      h('button', { class: 'act danger', title: 'Delete', onclick: (e) => { e.stopPropagation(); act.deleteIds([it.id]); } }, ic('x'))),
    h('div', { class: 'thumb' },
      h('div', { class: 'ph', style: { '--h': hueOf(host) } }, host[0] || '?'),
      img,
      linkBadge(it),
      h('div', { class: 'chip' }, fav, h('span', { text: host }))),
    h('div', { class: 'body' },
      h('h3', { class: 'title', text: it.title || it.url }),
      it.description && h('p', { class: 'desc', text: it.description }),
      it.note && h('p', { class: 'note', text: it.note }),
      reminderLine(it),
      others.length > 0 && h('p', { class: 'also', title: others.join('\n') }, ic('tag'), h('span', { text: 'Also in ' + others.join(', ') })),
      h('div', { class: 'meta', text: `Stashed ${ago(it.addedAt)}` }))
  );

  card.addEventListener('click', (e) => {
    if (e.target.closest('.act, .chk')) return;
    setCursor(card.dataset.k, false);
    if (ui.selected.size || e.shiftKey || e.ctrlKey || e.metaKey) toggleSelect(it.id, e.shiftKey);
    else act.clickOpen(it, e, card);
  });
  card.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      act.openItems([it], { background: true });
    }
  });
  card.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cardMenu({ x: e.clientX, y: e.clientY }, it, key);
  });
  card.addEventListener('dragstart', (e) => {
    const ids = ui.selected.has(it.id) ? [...ui.selected] : [it.id];
    drag = { kind: 'items', ids, from: key === 'none' ? null : key, sectionKey: key };
    e.dataTransfer.setData('application/x-tab-stash', '1');
    e.dataTransfer.effectAllowed = 'copyMove';
    card.classList.add('dragging');
  });
  return card;
}

function cardMenu(anchor, it, key) {
  const from = key === 'none' ? null : key;
  showMenu(anchor, [
    { head: 'Open' },
    { label: 'Open and remove from the stash', onClick: () => act.openItems([it], { keep: false }) },
    { label: 'Open and keep in the stash', onClick: () => act.openItems([it], { keep: true }) },
    { label: 'Open in new window', onClick: () => act.openItems([it], { mode: 'window' }, anchor) },
    { sep: true },
    { label: 'Move to…', onClick: () => act.moveMenu(anchor, ui.selected.has(it.id) ? [...ui.selected] : [it.id]) },
    { label: 'Add to…', onClick: () => act.moveMenu(anchor, ui.selected.has(it.id) ? [...ui.selected] : [it.id], true) },
    { label: 'Groups…', onClick: () => act.groupsDialog(ui.selected.has(it.id) ? [...ui.selected] : [it.id]) },
    from && { label: `Remove from “${groupOf(from)?.name}”`, onClick: () => model.removeFromGroup([it.id], from).then(() => done('Removed from group')) },
    { label: it.note ? 'Edit note…' : 'Add note…', onClick: () => act.noteDialog([it.id]) },
    { label: it.remindAt ? 'Change reminder…' : 'Remind me…', onClick: () => act.reminderDialog(ui.selected.has(it.id) ? [...ui.selected] : [it.id]) },
    { label: 'Edit title…', onClick: () => act.editItemDialog(it) },
    { sep: true },
    { label: 'Copy link', onClick: () => navigator.clipboard.writeText(it.url).then(() => toast('Link copied')) },
    { label: 'Check this link', onClick: () => act.runLinkCheck([it]) },
    { label: 'Refresh thumbnail', onClick: () => act.refreshThumbnails([it.id]) },
    { label: 'Diagnose thumbnail…', onClick: () => act.diagnose(it) },
    { sep: true },
    { label: 'Delete', danger: true, onClick: () => act.deleteIds([it.id]) },
  ]);
}

/* ------------------------------------------------------------------ filters */

function renderFilters() {
  const f = ui.filters;
  if (document.activeElement !== $('#fSite')) $('#fSite').value = f.site;
  $('#fAge').value = String(f.age);
  $('#fNote').checked = f.note;
  $('#fRemind').checked = f.remind;
  $('#fLink').value = f.link;
  $('#fClear').hidden = !(f.site || f.age || f.note || f.link || f.remind);
  // sites for autocomplete, most common first
  const counts = new Map();
  for (const it of app.state.items) counts.set(hostOf(it.url), (counts.get(hostOf(it.url)) || 0) + 1);
  const hosts = [...counts].filter(([hh]) => hh).sort((a, b) => b[1] - a[1]).slice(0, 80);
  $('#siteList').replaceChildren(...hosts.map(([hh, n]) => h('option', { value: hh, label: `${n} tabs` })));
}

app.syncFilters = () => render();

function bindFilters() {
  let t;
  $('#fSite').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { ui.filters.site = e.target.value.trim(); scheduleRender(); }, 150);
  });
  $('#fAge').addEventListener('change', (e) => { ui.filters.age = Number(e.target.value); render(); });
  $('#fNote').addEventListener('change', (e) => { ui.filters.note = e.target.checked; render(); });
  $('#fRemind').addEventListener('change', (e) => { ui.filters.remind = e.target.checked; render(); });
  $('#fLink').addEventListener('change', (e) => { ui.filters.link = e.target.value; render(); });
  $('#fClear').addEventListener('click', () => { ui.filters = { site: '', age: 0, note: false, link: '', remind: false }; render(); });
  $('#selectBtn').addEventListener('click', (e) => {
    const shown = viewIds();
    const everything = [...match];
    showMenu(e.currentTarget, [
      { label: `Select all shown (${shown.length})`, onClick: () => { shown.forEach((id) => ui.selected.add(id)); syncSelection(); } },
      everything.length !== shown.length || filtersActive()
        ? { label: `Select all ${everything.length} matching ${filtersActive() ? 'this search / these filters' : 'in the stash'}`, onClick: () => { everything.forEach((id) => ui.selected.add(id)); syncSelection(); } }
        : null,
      { label: 'Invert selection', onClick: () => { for (const id of shown) ui.selected.has(id) ? ui.selected.delete(id) : ui.selected.add(id); syncSelection(); } },
      { label: 'Select none', onClick: clearSelection },
    ]);
  });
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
  const ids = () => [...ui.selected];
  bar.replaceChildren(
    h('span', { class: 'sel-count', text: `${n} selected` }),
    tb('Open ▾', 'restore', (e) => act.openMenu(e.currentTarget, selectedItems(), commonGroup(selectedItems()))),
    tb('Move to…', 'folder', (e) => act.moveMenu(e.currentTarget, ids())),
    tb('Add to…', 'plus', (e) => act.moveMenu(e.currentTarget, ids(), true)),
    tb('Groups…', 'tag', () => act.groupsDialog(ids())),
    tb('Add note…', 'note', () => act.noteDialog(ids())),
    tb('Delete', 'trash', () => act.deleteIds(ids()), 'danger'),
    tb('More ▾', 'more', (e) => showMenu(e.currentTarget, [
      { label: 'Remind me…', onClick: () => act.reminderDialog(ids()) },
      { label: 'Copy links (one per line)', onClick: () => act.copyPlainLinks(selectedItems()) },
      { label: 'Copy links as Markdown', onClick: () => act.copyLinks(selectedItems()) },
      { label: 'Save these to a file…', onClick: () => act.saveBackup(selectedItems(), 'selection') },
      { label: 'Check these links', onClick: () => act.runLinkCheck(selectedItems()) },
      { label: 'Refresh thumbnails', onClick: () => act.refreshThumbnails(ids()) },
      { label: 'Group by site', onClick: act.autoGroupBySite },
      { label: 'Triage these…', onClick: () => triage(ids()) },
    ])),
    h('button', { class: 'tb x', title: 'Clear selection (Esc)', onclick: clearSelection }, ic('x'))
  );
}

function commonGroup(items) {
  const gs = new Set(items.map((i) => i.groupIds[0] || ''));
  return gs.size === 1 ? groupOf([...gs][0]) : null;
}

/* ----------------------------------------------------------- keyboard cursor */

function setCursor(k, scroll = true) {
  ui.cursor = k;
  applyCursor(scroll);
}

function applyCursor(scroll) {
  for (const c of document.querySelectorAll('.card.kbd')) c.classList.remove('kbd');
  if (!ui.cursor) return;
  const card = [...document.querySelectorAll('.card')].find((c) => c.dataset.k === ui.cursor);
  if (!card) return;
  card.classList.add('kbd');
  if (scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function moveCursor(dir) {
  const cards = [...document.querySelectorAll('.card')];
  if (!cards.length) return;
  const cur = cards.find((c) => c.dataset.k === ui.cursor);
  if (!cur) return setCursor(cards[0].dataset.k);
  const i = cards.indexOf(cur);
  if (dir === 'left' || dir === 'right') return setCursor(cards[Math.max(0, Math.min(cards.length - 1, i + (dir === 'right' ? 1 : -1)))].dataset.k);
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  let best = null;
  let bestScore = Infinity;
  for (const c of cards) {
    if (c === cur) continue;
    const b = c.getBoundingClientRect();
    const dy = b.top - r.top;
    if (dir === 'down' ? dy <= 5 : dy >= -5) continue;
    const score = Math.abs(dy) * 1000 + Math.abs(b.left + b.width / 2 - cx);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) setCursor(best.dataset.k);
}

const cursorItem = () => byId((ui.cursor || '').split('|')[0]);
const targetIds = () => (ui.selected.size ? [...ui.selected] : cursorItem() ? [cursorItem().id] : []);

/* --------------------------------------------------------------- drag & drop */

function clearMarks() {
  for (const el of document.querySelectorAll('.drop-over, .drop-before, .drop-after, .zone-before, .zone-after, .zone-inside')) {
    el.classList.remove('drop-over', 'drop-before', 'drop-after', 'zone-before', 'zone-after', 'zone-inside');
  }
}

const zoneOf = (e, el) => {
  const r = el.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
};

document.addEventListener('dragover', (e) => {
  if (!drag) return;
  clearMarks();
  if (drag.kind === 'items') {
    const card = e.target.closest?.('.card');
    if (card && card.dataset.key === drag.sectionKey && !drag.ids.includes(card.dataset.id)) {
      const r = card.getBoundingClientRect();
      card.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
      e.preventDefault();
      return;
    }
    const t = e.target.closest?.('[data-drop]');
    if (t) {
      t.classList.add('drop-over');
      e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move';
      e.preventDefault();
    }
  } else if (drag.kind === 'group') {
    const row = e.target.closest?.('.nav[data-gid]');
    if (row && row.dataset.gid !== drag.id && !descendantIds(app.state.groups, drag.id).includes(row.dataset.gid)) {
      row.classList.add('zone-' + zoneOf(e, row));
      e.preventDefault();
    } else if (e.target.closest?.('[data-root-drop]')) {
      e.target.closest('[data-root-drop]').classList.add('drop-over');
      e.preventDefault();
    }
  }
});

document.addEventListener('drop', async (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  const copy = e.ctrlKey || e.altKey;
  const markedCard = document.querySelector('.card.drop-before, .card.drop-after');
  const markedRow = document.querySelector('.nav[class*="zone-"]');
  const zone = markedRow && ['before', 'after', 'inside'].find((z) => markedRow.classList.contains('zone-' + z));
  const rootDrop = e.target.closest?.('[data-root-drop]');
  const target = e.target.closest?.('[data-drop]');
  clearMarks();
  if (d.kind === 'items') {
    if (markedCard) {
      e.preventDefault();
      return reorder(d, markedCard.dataset.id, markedCard.classList.contains('drop-after'));
    }
    if (target) {
      e.preventDefault();
      const gid = target.dataset.drop === 'none' ? null : target.dataset.drop;
      return act.moveTo(d.ids, gid, { from: d.from, copy });
    }
  } else if (d.kind === 'group') {
    e.preventDefault();
    if (markedRow) {
      const t = groupOf(markedRow.dataset.gid);
      if (!t) return;
      const op = zone === 'inside' ? { parentId: t.id } : zone === 'before' ? { parentId: t.parentId, beforeId: t.id } : { parentId: t.parentId, afterId: t.id };
      await model.moveGroup(d.id, op);
      return done();
    }
    if (rootDrop) {
      await model.moveGroup(d.id, { parentId: null });
      return done();
    }
  }
});

document.addEventListener('dragend', () => {
  drag = null;
  document.body.classList.remove('dragging-group');
  clearMarks();
  document.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
});

// Group rows in the sidebar start group drags.
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.nav[data-gid]');
  if (!row) return;
  drag = { kind: 'group', id: row.dataset.gid };
  document.body.classList.add('dragging-group');
  e.dataTransfer.setData('application/x-tab-stash-group', row.dataset.gid);
  e.dataTransfer.effectAllowed = 'move';
});

async function reorder(d, targetId, after) {
  const key = d.sectionKey;
  const moving = new Set(d.ids.filter((id) => inSection(byId(id) || { groupIds: [] }, key)));
  if (!moving.size) return;
  const order = itemsOf(key, true).map((i) => i.id);
  const movingInOrder = order.filter((id) => moving.has(id));
  const rest = order.filter((id) => !moving.has(id));
  let at = rest.indexOf(targetId);
  if (at < 0) return;
  if (after) at++;
  rest.splice(at, 0, ...movingInOrder);
  if (app.settings.sort !== 'manual') {
    app.settings = await saveSettings({ sort: 'manual' });
    $('#sort').value = 'manual';
  }
  await model.setOrder(key, rest);
  await done('Order changed');
}

/* ------------------------------------------------------------ header & menus */

async function openPicker() {
  const dlg = $('#dlgPick');
  const close = () => dlg.open && dlg.close();
  await mountPicker($('#pickRoot'), {
    groups: app.state.groups,
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

function triage(ids) {
  startTriage(ids?.length ? ids : ui.selected.size ? [...ui.selected] : ui.order.slice(), {
    open: async (it, keep) => {
      await restoreItems([it], { keep: true });
      if (!keep) await model.deleteItems([it.id], 'open');
    },
    note: (id) => act.noteDialog([id]),
  });
}

function toolsMenu(anchor) {
  showMenu(anchor, [
    { head: 'Tidy up' },
    { label: 'Undo last change (Ctrl+Z)', onClick: doUndo },
    { label: 'Triage: go through tabs one by one', onClick: () => triage() },
    { label: 'Group ungrouped tabs by site', onClick: act.autoGroupBySite },
    { label: 'Merge duplicate links', onClick: act.mergeDuplicates },
    { head: 'Check' },
    { label: ui.selected.size ? 'Check links of selected tabs' : 'Check all links for dead pages', onClick: () => act.runLinkCheck(ui.selected.size ? selectedItems() : app.state.items) },
    { label: 'Fetch missing thumbnails now', onClick: act.fetchThumbsNow },
    { section: 'Import and export', items: [
      { head: 'Import' },
      { label: 'Import links from pasted text…', onClick: act.pasteLinks },
      { label: 'Import links or bookmarks from a file…', onClick: () => $('#importFile').click() },
      { head: 'Export' },
      { label: 'Export as Markdown', onClick: act.exportMarkdown },
      { label: 'Export links as plain text', onClick: act.exportPlainLinks },
      { label: 'Export as a bookmarks file (HTML)', onClick: act.exportBookmarks },
    ] },
    { head: 'Backup and safety' },
    { label: 'Back up stash to a file…', onClick: () => act.saveBackup() },
    { label: 'Restore from a backup file…', onClick: act.restoreBackup },
    { label: 'Safety snapshots…', onClick: () => openSnapshots() },
    { label: 'Recently deleted…', onClick: () => openTrash(refresh) },
    { head: 'Help' },
    { label: 'Keyboard shortcuts (?)', onClick: () => $('#dlgHelp').showModal() },
    { label: 'Help guide (opens GitHub)', onClick: () => window.open(`https://github.com/${REPO}/blob/main/docs/HELP.md`, '_blank', 'noopener') },
    { label: 'Settings…', onClick: () => openSettings({ onSaved: () => { applySettings(); scheduleRender(); } }) },
  ]);
}

function bindHeader() {
  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      ui.query = e.target.value.trim();
      scheduleRender();
    }, 120);
  });
  $('#sort').addEventListener('change', async (e) => {
    app.settings = await saveSettings({ sort: e.target.value });
    scheduleRender();
  });
  $('#size').addEventListener('input', (e) => document.documentElement.style.setProperty('--card', e.target.value + 'px'));
  $('#size').addEventListener('change', async (e) => {
    app.settings = await saveSettings({ cardSize: Number(e.target.value) });
  });
  $('#stashBtn').addEventListener('click', (e) => stashMenu(e.currentTarget));
  $('#toolsBtn').addEventListener('click', (e) => toolsMenu(e.currentTarget));
  $('#triageBtn').addEventListener('click', () => triage());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await act.importFile(f);
  });
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
  $('#whatsNew').addEventListener('click', showChanges);
  $('#reloadExt').addEventListener('click', () => chrome.runtime.reload());
  $('#checkUpdate').addEventListener('click', checkNow);
  $('#rollbackUpdate').addEventListener('click', rollbackNow);
  $('#abChoose').addEventListener('click', async () => { await act.chooseBackupFile(); refreshAutobackupStatus(); });
  $('#abNow').addEventListener('click', async () => { await act.runAutobackup({ force: true, click: true }); refreshAutobackupStatus(); });
  $('#abOff').addEventListener('click', async () => { await act.turnOffBackup(); refreshAutobackupStatus(); });
  $('#snapOpen').addEventListener('click', () => { $('#dlgSettings').close('cancel'); openSnapshots(); });
  $('#trashOpen').addEventListener('click', () => { $('#dlgSettings').close('cancel'); openTrash(refresh); });
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

function applySettings() {
  document.documentElement.style.setProperty('--card', app.settings.cardSize + 'px');
  $('#size').value = app.settings.cardSize;
  $('#sort').value = app.settings.sort;
}

/* ------------------------------------------------------------------ keyboard */

const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || document.body.classList.contains('triaging')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (typing(e)) {
    if (e.key === 'Escape' && e.target.id === 'q') e.target.blur();
    return;
  }
  const k = e.key;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
  else if (mod && k.toLowerCase() === 'a') { e.preventDefault(); viewIds().forEach((id) => ui.selected.add(id)); syncSelection(); }
  else if (mod || e.altKey) return;
  else if (k === '/') { e.preventDefault(); $('#q').focus(); }
  else if (k === '?') $('#dlgHelp').showModal();
  else if (k === 'Escape') { closeMenu(); if (ui.selected.size) clearSelection(); else { ui.cursor = null; applyCursor(false); } }
  else if (k === 'ArrowLeft') { e.preventDefault(); moveCursor('left'); }
  else if (k === 'ArrowRight') { e.preventDefault(); moveCursor('right'); }
  else if (k === 'ArrowUp') { e.preventDefault(); moveCursor('up'); }
  else if (k === 'ArrowDown') { e.preventDefault(); moveCursor('down'); }
  else if (k === 'Enter') {
    const it = cursorItem();
    if (!it) return;
    e.preventDefault();
    const mode = app.settings.openMode;
    act.openItems([it], e.shiftKey && mode !== 'ask' ? { keep: mode !== 'keep' } : {}, document.querySelector('.card.kbd'));
  }
  else if (k === 'x' || k === ' ') { const it = cursorItem(); if (it) { e.preventDefault(); toggleSelect(it.id); } }
  else if (k === 'Delete' || k === 'Backspace') { const ids = targetIds(); if (ids.length) { e.preventDefault(); act.deleteIds(ids); } }
  else if (k === 'm') { const ids = targetIds(); if (ids.length) act.moveMenu(document.querySelector('.card.kbd') || document.body, ids); }
  else if (k === 'a') { const ids = targetIds(); if (ids.length) act.moveMenu(document.querySelector('.card.kbd') || document.body, ids, true); }
  else if (k === 'g') act.groupsDialog(targetIds());
  else if (k === 'n') { e.preventDefault(); act.noteDialog(targetIds()); }
  else if (k === 'r') { e.preventDefault(); act.reminderDialog(targetIds()); }
  else if (k === 'e') { const it = cursorItem(); if (it) { e.preventDefault(); act.editItemDialog(it); } }
  else if (k === 't') triage();
});

/* --------------------------------------------------- other stash pages / sync */

let multiTimer;
async function checkOtherPages() {
  try {
    if (chrome.runtime.getManifest().chrome_url_overrides?.newtab) return setBanner('multi', null); // new-tab mode: many pages are normal
    const me = await chrome.tabs.getCurrent();
    const tabs = (await chrome.tabs.query({ url: STASH_PAGE + '*' })).filter((t) => t.id !== me?.id);
    if (!tabs.length) return setBanner('multi', null);
    if (Number(sessionStorage.getItem('multiDismissed')) >= tabs.length) return;
    setBanner(
      'multi',
      h('div', { class: 'banner' },
        h('span', { text: `TabDepot is also open in ${tabs.length === 1 ? 'another tab' : tabs.length + ' other tabs'}. Both stay in sync automatically.` }),
        h('button', { class: 'btn small', text: 'Go there', onclick: () => { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); } }),
        h('button', { class: 'btn small', text: tabs.length === 1 ? 'Close the other one' : 'Close the others', onclick: () => chrome.tabs.remove(tabs.map((t) => t.id)) }),
        h('button', { class: 'btn small', text: 'Dismiss', onclick: () => { sessionStorage.setItem('multiDismissed', tabs.length); setBanner('multi', null); } }))
    );
  } catch {
    /* tabs API unavailable */
  }
}
const checkOtherSoon = () => {
  clearTimeout(multiTimer);
  multiTimer = setTimeout(checkOtherPages, 400);
};
chrome.tabs.onCreated.addListener(checkOtherSoon);
chrome.tabs.onRemoved.addListener(checkOtherSoon);
chrome.tabs.onUpdated.addListener((id, info) => info.url && checkOtherSoon());

// live updates when the background worker (or another stash page) changes the data
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.state) {
    refresh();
    scheduleEnrich();
    act.backupSoon();
  }
  if (changes.settings) getSettings().then((s) => { app.settings = s; applySettings(); scheduleRender(); });
});

/* ---------------------------------------------------------------------- boot */

function checkHash() {
  if (location.hash === '#settings') {
    history.replaceState(null, '', location.pathname);
    openSettings({ onSaved: () => { applySettings(); scheduleRender(); } });
  } else if (location.hash === '#triage') {
    history.replaceState(null, '', location.pathname);
    triage();
  }
}
addEventListener('hashchange', checkHash);

new ResizeObserver(() => document.documentElement.style.setProperty('--topH', $('#topwrap').offsetHeight + 'px')).observe($('#topwrap'));

async function announceUpdate() {
  const { updatedFrom } = await chrome.storage.local.get('updatedFrom');
  if (!updatedFrom) return;
  await chrome.storage.local.remove('updatedFrom');
  toast(`TabDepot updated ${updatedFrom} → ${chrome.runtime.getManifest().version}`, { label: "What's new", onClick: showChanges });
}

(async function boot() {
  bindHeader();
  bindFilters();
  app.settings = await getSettings();
  applySettings();
  app.state = await getState();
  render();
  gcThumbs();
  checkHash();
  announceUpdate();
  scheduleEnrich(600);
  checkOtherPages();
  act.startBackupTimers();
  initUpdates();
  watchStale();
})();
