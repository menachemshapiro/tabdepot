// Tab picker: lists every open tab (all windows) with checkboxes, then stashes the chosen ones.
// Used inside the toolbar popup and inside a dialog on the stash page.

import { faviconFor, hostOf, isStashableUrl } from './common.js';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

export async function mountPicker(root, { groups = [], onDone, onCancel }) {
  const cur = await chrome.windows.getLastFocused();
  const wins = await chrome.windows.getAll({ populate: true });
  wins.sort((a, b) => (b.id === cur.id) - (a.id === cur.id));

  const rows = []; // { tab, el, cb, text }
  const list = h('div', { class: 'pk-list' });

  wins.forEach((w, wi) => {
    const tabs = (w.tabs || []).filter((t) => isStashableUrl(t.url || t.pendingUrl));
    if (!tabs.length) return;
    const wrows = [];
    list.append(
      h(
        'div',
        { class: 'pk-win' },
        h('span', { text: w.id === cur.id ? `This window · ${tabs.length}` : `Window ${wi + 1} · ${tabs.length}` }),
        h('button', {
          type: 'button',
          class: 'pk-link',
          text: 'toggle all',
          onclick: () => {
            const vis = wrows.filter((r) => !r.el.hidden);
            const all = vis.every((r) => r.cb.checked);
            vis.forEach((r) => (r.cb.checked = !all));
            update();
          },
        })
      )
    );
    for (const t of tabs) {
      const url = t.url || t.pendingUrl;
      const cb = h('input', { type: 'checkbox' });
      const el = h(
        'label',
        { class: 'pk-row' + (t.active ? ' active' : '') },
        cb,
        h('img', { src: faviconFor(url), alt: '', onerror: (e) => (e.currentTarget.style.visibility = 'hidden') }),
        h('span', { class: 'pk-text' }, h('span', { class: 'pk-title', text: t.title || url }), h('span', { class: 'pk-url', text: hostOf(url) || url })),
        t.pinned && h('span', { class: 'pk-tag', text: 'pinned' }),
        t.audible && h('span', { class: 'pk-tag', text: '♪ playing' }),
        t.discarded && h('span', { class: 'pk-tag', text: 'asleep' })
      );
      const row = { tab: t, el, cb, text: `${t.title || ''} ${url}`.toLowerCase() };
      rows.push(row);
      wrows.push(row);
      list.append(el);
    }
  });

  // shift-click range selection among visible rows
  let last = null;
  rows.forEach((r) => {
    r.cb.addEventListener('click', (e) => {
      const vis = rows.filter((x) => !x.el.hidden);
      const i = vis.indexOf(r);
      if (e.shiftKey && last != null && last < vis.length) {
        const [lo, hi] = last < i ? [last, i] : [i, last];
        for (const x of vis.slice(lo, hi + 1)) x.cb.checked = r.cb.checked;
      }
      last = i;
      update();
    });
  });

  const search = h('input', { type: 'search', class: 'pk-search', placeholder: 'Filter open tabs…', autocomplete: 'off' });
  search.addEventListener('input', () => {
    const toks = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of rows) r.el.hidden = !toks.every((t) => r.text.includes(t));
    update();
  });

  const setVisible = (on) => {
    rows.filter((r) => !r.el.hidden).forEach((r) => (r.cb.checked = on));
    update();
  };

  const groupSel = h(
    'select',
    { class: 'pk-select' },
    h('option', { value: '', text: 'Ungrouped' }),
    groups.map((g) => h('option', { value: g.id, text: g.name })),
    h('option', { value: '__new', text: '+ New group…' })
  );
  const newName = h('input', { class: 'pk-newname', placeholder: 'New group name', maxlength: '60', hidden: true });
  groupSel.addEventListener('change', () => {
    newName.hidden = groupSel.value !== '__new';
    if (!newName.hidden) newName.focus();
  });

  const go = h('button', { type: 'button', class: 'pk-go', disabled: true });
  const count = h('span', { class: 'pk-count' });

  function update() {
    const n = rows.filter((r) => r.cb.checked).length;
    go.textContent = `Stash ${n} tab${n === 1 ? '' : 's'}`;
    go.disabled = n === 0;
    const vis = rows.filter((r) => !r.el.hidden).length;
    count.textContent = `${n} selected · ${vis} shown`;
  }

  go.addEventListener('click', async () => {
    const tabIds = rows.filter((r) => r.cb.checked).map((r) => r.tab.id);
    if (!tabIds.length) return;
    const msg = { type: 'stashTabs', tabIds };
    if (groupSel.value === '__new') {
      const name = newName.value.trim();
      if (!name) return newName.focus();
      msg.groupName = name;
    } else if (groupSel.value) {
      msg.groupId = groupSel.value;
    }
    go.disabled = true;
    go.textContent = 'Stashing…';
    let res = null;
    try {
      res = await chrome.runtime.sendMessage(msg);
    } catch {
      /* popup may close while tabs switch */
    }
    onDone?.(res || { count: tabIds.length });
  });

  root.replaceChildren(
    h(
      'div',
      { class: 'pk' },
      h('div', { class: 'pk-head' }, h('button', { type: 'button', class: 'pk-back', text: '← Back', onclick: () => onCancel?.() }), h('strong', { text: 'Choose tabs to stash' })),
      h('div', { class: 'pk-tools' }, search, h('button', { type: 'button', class: 'pk-link', text: 'All', onclick: () => setVisible(true) }), h('button', { type: 'button', class: 'pk-link', text: 'None', onclick: () => setVisible(false) })),
      list,
      h('div', { class: 'pk-foot' }, count, h('div', { class: 'pk-send' }, h('span', { text: 'Send to' }), groupSel), newName, go)
    )
  );
  update();
  search.focus();
}
