// Update banner and buttons on the stash page.

import * as up from './updater.js';
import { getSettings } from './common.js';
import { $, h, toast, setBanner } from './ui.js';

const SIX_HOURS = 6 * 3600_000;
let working = false;

const manualHelp = (v) => `Run in a terminal: bash ~/tab-stash/update.sh ~/Downloads/tabdepot-${v}.zip — then Settings → Reload extension.`;

function bannerFor(info) {
  if (!info?.available || localStorage.getItem('updateDismissed') === info.latest) return setBanner('update', null);
  setBanner(
    'update',
    h('div', { class: 'banner' },
      h('span', { text: `TabDepot ${info.latest} is available (you have ${info.current}).` }),
      up.supported() && info.zipUrl ? h('button', { class: 'btn small', text: 'Update now', onclick: () => run(info) }) : h('span', { class: 'hint', text: manualHelp(info.latest) }),
      info.url && h('a', { class: 'btn small', href: info.url, target: '_blank', rel: 'noreferrer', text: 'What’s new' }),
      h('button', { class: 'btn small', text: 'Later', onclick: () => { localStorage.setItem('updateDismissed', info.latest); setBanner('update', null); } }))
  );
}

function progressBanner(label, done, total) {
  setBanner('update', h('div', { class: 'banner' }, h('span', { text: `${label}… ${total > 1 ? `${done}/${total}` : ''}` })));
}

async function run(info) {
  if (working) return;
  working = true;
  try {
    // the folder picker must open straight from the click
    const root = await up.chooseFolder();
    const version = await up.installUpdate(info, root, { onProgress: (d, t, label) => progressBanner(label, d, t) });
    setBanner('update', h('div', { class: 'banner' }, h('span', { text: `Updated to ${version}. Reloading the extension…` })));
    localStorage.removeItem('updateDismissed');
    up.reloadExtension();
  } catch (e) {
    working = false;
    if (e.name === 'AbortError') return bannerFor(info);
    setBanner('update', h('div', { class: 'banner' }, h('span', { text: `Update failed: ${e.message || e}. Nothing was changed unless the message says otherwise. ${manualHelp(info.latest)}` }), h('button', { class: 'btn small', text: 'Dismiss', onclick: () => setBanner('update', null) })));
  }
}

// Called at start-up: show a known update immediately, and look again if the last check is old.
export async function initUpdates() {
  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  if (updateInfo) {
    // the extension may have been updated since the last check
    updateInfo.current = chrome.runtime.getManifest().version;
    updateInfo.available = up.compareVersions(updateInfo.latest, updateInfo.current) > 0;
    bannerFor(updateInfo);
  }
  const settings = await getSettings();
  if (!settings.checkUpdates) return;
  if (updateInfo && Date.now() - updateInfo.checkedAt < SIX_HOURS) return;
  try {
    bannerFor(await up.checkForUpdate());
  } catch {
    /* offline or rate limited: try again next time */
  }
}

export async function checkNow() {
  const status = $('#updStatus');
  status.textContent = 'Checking…';
  try {
    const info = await up.checkForUpdate();
    localStorage.removeItem('updateDismissed');
    status.textContent = info.available ? `Version ${info.latest} is available (you have ${info.current}).` : `You have the latest version (${info.current}).`;
    bannerFor(info);
    if (info.available) $('#dlgSettings').close('cancel');
  } catch (e) {
    status.textContent = `Could not check: ${e.message || e}`;
  }
}

export async function rollbackNow() {
  if (!up.supported()) return toast('This browser cannot write to the extension folder');
  try {
    const root = await up.chooseFolder();
    if (!confirm('Put back the files that were saved before the last in-app update?')) return;
    const v = await up.rollback(root);
    toast(`Restored v${v}. Reloading…`);
    up.reloadExtension();
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Could not restore: ${e.message || e}`);
  }
}
