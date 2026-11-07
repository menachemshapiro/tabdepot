// Triage mode: go through tabs one at a time with the keyboard.
//   → / k / Space  keep (next)      ←  back        d / Delete  delete        o / Enter  open & remove
//   Shift+O  open & keep     1–9  add to that group        n  note        u  undo last action        Esc  leave

import { flattenGroups, hostOf, faviconFor, idbGet } from './common.js';
import { app, byId, groupOf, refresh } from './app.js';
import { $, h, ago, hueOf, plural, toast } from './ui.js';
import * as model from './model.js';
import { COLOR_HEX } from './common.js';

export function startTriage(ids, actions) {
  const root = $('#triage');
  const queue = ids.filter((id) => byId(id));
  if (!queue.length) return toast('Nothing to go through');
  const stats = { kept: 0, deleted: 0, opened: 0, grouped: 0 };
  const log = []; // { index, kind, undoable }
  let i = 0;
  let thumbUrl = null;
  let busy = false;

  const cleanup = () => {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    removeEventListener('keydown', onKey, true);
    root.hidden = true;
    root.replaceChildren();
    document.body.classList.remove('triaging');
    refresh();
  };

  const groupKeys = () => flattenGroups(app.state.groups).slice(0, 9);

  async function draw() {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    thumbUrl = null;
    // skip things that disappeared meanwhile
    while (i < queue.length && !byId(queue[i])) i++;
    if (i >= queue.length) return drawDone();
    const it = byId(queue[i]);
    const host = hostOf(it.url) || it.url;
    let src = '';
    try {
      const blob = await idbGet('thumbs', it.id);
      if (blob) src = thumbUrl = URL.createObjectURL(blob);
    } catch {
      /* none */
    }
    if (!src && it.ogImage) src = it.ogImage;
    const keys = groupKeys();
    root.replaceChildren(
      h('div', { class: 'tr-top' }, h('span', { text: `${i + 1} of ${queue.length}` }),
        h('div', { class: 'tr-bar' }, h('i', { style: { width: (i / queue.length) * 100 + '%' } })),
        h('button', { class: 'btn small', text: 'Leave (Esc)', onclick: cleanup })),
      h('div', { class: 'tr-card' },
        h('div', { class: 'tr-thumb' },
          h('div', { class: 'ph', style: { '--h': hueOf(host) } }, host[0] || '?'),
          src && h('img', { src, referrerpolicy: 'no-referrer', alt: '', onerror: (e) => e.currentTarget.remove() })),
        h('div', { class: 'tr-body' },
          h('h2', { text: it.title || it.url }),
          h('div', { class: 'tr-host' }, h('img', { src: faviconFor(it.url), alt: '' }), h('span', { text: host }), h('span', { class: 'hint', text: `· stashed ${ago(it.addedAt)}` })),
          it.description && h('p', { class: 'desc', text: it.description }),
          it.note && h('p', { class: 'note', text: it.note }),
          h('div', { class: 'tr-groups' },
            it.groupIds.length ? it.groupIds.map((g) => h('span', { class: 'pill' }, h('i', { class: 'dot', style: { background: COLOR_HEX[groupOf(g)?.color] || '#9aa0a6' } }), groupOf(g)?.name || '')) : h('span', { class: 'hint', text: 'Ungrouped' })))),
      h('div', { class: 'tr-acts' },
        btn('←', 'Back', () => go(-1)),
        btn('→', 'Keep', () => keep()),
        btn('d', 'Delete', () => del(), 'danger'),
        btn('o', 'Open & remove', () => open(false)),
        btn('⇧O', 'Open & keep', () => open(true)),
        btn('n', 'Note', () => note()),
        btn('u', 'Undo', () => undo())),
      keys.length
        ? h('div', { class: 'tr-keys' }, h('span', { class: 'hint', text: 'Add to group:' }),
            keys.map(({ group }, n) => h('button', { class: 'pill btn-pill', onclick: () => addTo(group.id) }, h('kbd', { text: n + 1 }), h('i', { class: 'dot', style: { background: COLOR_HEX[group.color] } }), group.name)))
        : h('div', { class: 'hint', text: 'Create groups first and they appear here with number keys 1–9.' })
    );
  }

  function btn(key, label, fn, cls = '') {
    return h('button', { class: 'btn ' + cls, onclick: fn }, h('kbd', { text: key }), ' ' + label);
  }

  function drawDone() {
    root.replaceChildren(
      h('div', { class: 'tr-done' },
        h('h2', { text: 'All done' }),
        h('p', { text: `Kept ${stats.kept} · deleted ${stats.deleted} · opened ${stats.opened} · grouped ${stats.grouped}` }),
        h('div', {}, h('button', { class: 'btn', text: '← Back', onclick: () => go(-1) }), ' ', h('button', { class: 'btn primary', text: 'Close', onclick: cleanup }))));
  }

  const cur = () => byId(queue[i]);
  const advance = () => { i++; return draw(); };
  const go = (d) => { i = Math.max(0, Math.min(queue.length, i + d)); return draw(); };

  async function guard(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } finally { busy = false; }
  }

  const keep = () => guard(async () => { stats.kept++; log.push({ index: i, kind: 'keep' }); await advance(); });
  const del = () => guard(async () => {
    const it = cur(); if (!it) return;
    await model.deleteItems([it.id]);
    stats.deleted++; log.push({ index: i, kind: 'model' });
    await refresh(); await advance();
  });
  const open = (keepIt) => guard(async () => {
    const it = cur(); if (!it) return;
    await actions.open(it, keepIt);
    stats.opened++; log.push({ index: i, kind: keepIt ? 'keep' : 'model' });
    await refresh(); await advance();
  });
  const addTo = (gid) => guard(async () => {
    const it = cur(); if (!it) return;
    await model.addToGroups([it.id], [gid]);
    stats.grouped++; log.push({ index: i, kind: 'model' });
    await refresh(); await advance();
  });
  const note = () => guard(async () => {
    const it = cur(); if (!it) return;
    removeEventListener('keydown', onKey, true);
    await actions.note(it.id);
    addEventListener('keydown', onKey, true);
    await refresh(); await draw();
  });
  const undo = () => guard(async () => {
    const last = log.pop();
    if (!last) return;
    if (last.kind === 'model') await model.undoLast();
    else if (last.kind === 'keep') stats.kept = Math.max(0, stats.kept - 1);
    await refresh();
    i = last.index;
    await draw();
  });

  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'Escape') { handled(); cleanup(); }
    else if (k === 'ArrowRight' || k === 'k' || k === ' ') { handled(); keep(); }
    else if (k === 'ArrowLeft' || k === 'Backspace') { handled(); go(-1); }
    else if (k === 'd' || k === 'Delete') { handled(); del(); }
    else if (k === 'O') { handled(); open(true); }
    else if (k === 'o' || k === 'Enter') { handled(); open(false); }
    else if (k === 'n') { handled(); note(); }
    else if (k === 'u') { handled(); undo(); }
    else if (/^[1-9]$/.test(k)) {
      const g = groupKeys()[Number(k) - 1];
      if (g) { handled(); addTo(g.group.id); }
    }
  }

  document.body.classList.add('triaging');
  root.hidden = false;
  addEventListener('keydown', onKey, true);
  draw();
}
