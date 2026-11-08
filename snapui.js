// "Safety snapshots" dialog: restore the stash to an earlier state, or recover tabs that were open.

import { mutate, ensureGroup, dupKey, uid, hostOf, faviconFor } from './common.js';
import { listSnapshots, getSnapshot, deleteSnapshot, takeStashSnapshot, takeTabsSnapshot, restoreStashSnapshot } from './snapshots.js';
import { restoreItems, enrichMissing } from './core.js';
import { app, refresh } from './app.js';
import { $, h, ago, plural, toast } from './ui.js';

const when = (ts) => `${ago(ts)} · ${new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;

let tab = 'stash';

export async function openSnapshots(startTab = 'stash') {
  tab = startTab;
  const dlg = $('#dlgSnap');
  await renderList();
  if (!dlg.open) dlg.showModal();
}

const close = () => $('#dlgSnap').close();

async function renderList() {
  const root = $('#snapRoot');
  const list = await listSnapshots(tab);
  const tabBtn = (id, label) => h('button', { type: 'button', class: 'seg' + (tab === id ? ' on' : ''), text: label, onclick: () => { tab = id; renderList(); } });
  root.replaceChildren(
    h('h3', { text: 'Safety snapshots' }),
    h('p', { class: 'hint', text: 'TabDepot quietly keeps copies so a mistake is never final. They stay on this computer, in the browser’s storage.' }),
    h('div', { class: 'segs' }, tabBtn('stash', 'Stash history'), tabBtn('tabs', 'Open tabs history')),
    h(
      'div',
      { class: 'snap-list' },
      list.length
        ? list.map((s) =>
            h(
              'div',
              { class: 'snap-row' },
              h('div', { class: 'snap-main' }, h('strong', { text: s.label || 'automatic' }), h('span', { class: 'hint', text: when(s.ts) }),
                h('span', { class: 'hint', text: s.kind === 'stash' ? `${plural(s.items, 'tab')} · ${plural(s.groups, 'group')}` : `${plural(s.tabs, 'tab')} in ${plural(s.windows, 'window')}` })),
              h(
                'div',
                { class: 'snap-acts' },
                s.kind === 'stash'
                  ? [
                      h('button', { type: 'button', class: 'btn small', text: 'Add back what is missing', title: 'Keeps your current stash and adds the tabs and groups that this snapshot has', onclick: () => restoreStash(s, 'merge') }),
                      h('button', { type: 'button', class: 'btn small', text: 'Replace stash', title: 'Make the stash exactly like this snapshot (your current state is snapshotted first)', onclick: () => restoreStash(s, 'replace') }),
                    ]
                  : h('button', { type: 'button', class: 'btn small', text: 'View tabs…', onclick: () => viewTabs(s.id) }),
                h('button', { type: 'button', class: 'btn small', text: 'Delete', onclick: async () => { await deleteSnapshot(s.id); renderList(); } })
              )
            )
          )
        : h('p', { class: 'empty-hint', text: tab === 'stash' ? 'No stash snapshots yet. One is taken automatically after changes, and before risky actions.' : 'No open-tabs snapshots yet. They are taken every few minutes while the browser is open, and when a window closes.' })
    ),
    h(
      'menu',
      {},
      h('button', { type: 'button', class: 'btn', text: tab === 'stash' ? 'Snapshot the stash now' : 'Snapshot open tabs now', onclick: async () => {
        const id = tab === 'stash' ? await takeStashSnapshot('manual') : await takeTabsSnapshot('manual');
        toast(id ? 'Snapshot saved' : 'Nothing has changed since the last snapshot');
        renderList();
      } }),
      h('button', { type: 'button', class: 'btn primary', text: 'Close', onclick: close })
    )
  );
}

async function restoreStash(s, mode) {
  if (mode === 'replace' && !confirm('Replace your whole stash with this snapshot?\n\nYour current stash is snapshotted first, so you can come back.')) return;
  await restoreStashSnapshot(s.id, mode);
  await refresh();
  enrichMissing().catch(() => {});
  close();
  toast(mode === 'replace' ? 'Stash replaced from snapshot' : 'Added back what was missing');
}

// ---- open tabs snapshot detail ----

async function viewTabs(id) {
  const snap = await getSnapshot(id);
  if (!snap) return renderList();
  const root = $('#snapRoot');
  const rows = []; // { cb, tab }
  const body = h('div', { class: 'snap-tabs' });
  snap.data.windows.forEach((w, wi) => {
    body.append(h('div', { class: 'pk-win' }, h('span', { text: `Window ${wi + 1} · ${w.tabs.length}` })));
    for (const t of w.tabs) {
      const cb = h('input', { type: 'checkbox', checked: true });
      rows.push({ cb, t });
      body.append(
        h('label', { class: 'pk-row' }, cb, h('img', { src: faviconFor(t.url), alt: '' }),
          h('span', { class: 'pk-text' }, h('span', { class: 'pk-title', text: t.title || t.url }), h('span', { class: 'pk-url', text: hostOf(t.url) || t.url })),
          t.group && h('span', { class: 'pk-tag', text: t.group }))
      );
    }
  });
  const chosen = () => rows.filter((r) => r.cb.checked).map((r) => r.t);
  const all = h('button', { type: 'button', class: 'pk-link', text: 'toggle all', onclick: () => { const on = rows.every((r) => r.cb.checked); rows.forEach((r) => (r.cb.checked = !on)); } });
  root.replaceChildren(
    h('h3', { text: `Tabs open ${when(snap.ts)}` }),
    h('p', { class: 'hint' }, `${snap.label === 'automatic' ? 'Automatic snapshot' : snap.label}. Tick what you want back. `, all),
    body,
    h(
      'menu',
      {},
      h('button', { type: 'button', class: 'btn', text: '← Back', onclick: renderList }),
      h('button', { type: 'button', class: 'btn', text: 'Open selected', onclick: async () => {
        const items = chosen().map((t) => ({ id: uid(), url: t.url, title: t.title }));
        if (!items.length) return;
        if (items.length > 25 && !confirm(`Open ${items.length} tabs?`)) return;
        await restoreItems(items, { keep: true });
        close();
      } }),
      h('button', { type: 'button', class: 'btn primary', text: 'Add selected to the stash', onclick: async () => {
        const n = await addToStash(chosen());
        close();
        await refresh();
        enrichMissing().catch(() => {});
        toast(n ? `Added ${plural(n, 'tab')} to the stash` : 'Those tabs are already in the stash');
      } })
    )
  );
}

async function addToStash(tabs) {
  let added = 0;
  await mutate((state) => {
    const have = new Set(state.items.map((i) => dupKey(i.url)));
    let order = state.items.length;
    for (const t of tabs) {
      const key = dupKey(t.url);
      if (have.has(key)) continue;
      have.add(key);
      const groupIds = t.group ? [ensureGroup(state, t.group).id] : [];
      state.items.push({ id: uid(), url: t.url, title: t.title || t.url, description: '', ogImage: '', addedAt: Date.now(), order: ++order, groupIds, note: '' });
      added++;
    }
  });
  return added;
}
