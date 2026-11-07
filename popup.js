import { getState, hostOf, flattenGroups } from './common.js';
import { tabsForScope } from './core.js';
import { mountPicker } from './picker.js';

const $ = (s) => document.querySelector(s);
const groupSel = $('#group');
const newGroup = $('#newGroup');

async function init() {
  const { items, groups } = await getState();
  $('#count').textContent = `${items.length} tab${items.length === 1 ? '' : 's'} in your stash`;

  const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
  groupSel.append(opt('', 'Ungrouped (or keep Chrome groups)'));
  for (const { group, depth } of flattenGroups(groups)) groupSel.append(opt(group.id, '\u00a0\u00a0'.repeat(depth) + (depth ? '↳ ' : '') + group.name));
  groupSel.append(opt('__new', '+ New group…'));
  groupSel.addEventListener('change', () => {
    newGroup.hidden = groupSel.value !== '__new';
    if (!newGroup.hidden) newGroup.focus();
  });

  // live counts on every button
  for (const btn of document.querySelectorAll('[data-scope]')) {
    const scope = btn.dataset.scope;
    const tabs = await tabsForScope(scope);
    const badge = btn.querySelector('b');
    if (badge) badge.textContent = tabs.length || '';
    btn.disabled = tabs.length === 0;
    if (scope === 'highlighted') btn.hidden = tabs.length < 2;
    if (scope === 'site') {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const host = hostOf(active?.url || '');
      if (host) $('#siteLabel').textContent = `Stash all tabs from ${host.length > 24 ? host.slice(0, 23) + '…' : host}`;
    }
  }
}

async function run(scope) {
  const msg = { type: 'stash', scope };
  if (groupSel.value === '__new') {
    const name = newGroup.value.trim();
    if (!name) return newGroup.focus();
    msg.groupName = name;
  } else if (groupSel.value) {
    msg.groupId = groupSel.value;
  }
  document.querySelectorAll('#mainView button').forEach((b) => (b.disabled = true));
  const status = $('#status');
  status.hidden = false;
  status.textContent = 'Stashing…';
  try {
    const res = await chrome.runtime.sendMessage(msg);
    status.textContent = res?.count ? `Stashed ${res.count} tab${res.count === 1 ? '' : 's'}` : 'Nothing to stash';
  } catch {
    // popup may be closed by the browser while tabs are switching – that's fine
  }
  setTimeout(() => window.close(), 600);
}

document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => run(b.dataset.scope)));

$('#choose').addEventListener('click', async () => {
  const { groups } = await getState();
  const show = (picker) => {
    $('#mainView').hidden = picker;
    $('#pickerView').hidden = !picker;
    document.body.classList.toggle('wide', picker);
  };
  show(true);
  await mountPicker($('#pickerView'), {
    groups,
    onCancel: () => show(false),
    onDone: (res) => {
      $('#pickerView').hidden = true;
      const status = $('#status');
      status.hidden = false;
      status.textContent = res?.count ? `Stashed ${res.count} tab${res.count === 1 ? '' : 's'}` : 'Nothing to stash';
      setTimeout(() => window.close(), 700);
    },
  });
});
$('#open').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'openStash' });
  window.close();
});
$('#settings').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'openStash', hash: '#settings' });
  window.close();
});

init();
