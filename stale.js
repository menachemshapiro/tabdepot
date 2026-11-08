// Notices when this open stash page is running old code, and offers the one click that fixes it.
//  - 'page':      the extension was reloaded/updated while this page stayed open -> reload this page.
//  - 'extension': new files are on disk but the extension has not been reloaded -> reload the extension.

import { h, setBanner } from './ui.js';

const LOADED = chrome.runtime.getManifest().version; // the version this page's code came from

// Pure decision, so it can be tested.
export function staleState({ loaded, running, disk, alive }) {
  if (!alive || (running && running !== loaded)) return 'page';
  if (disk && running && disk !== running) return 'extension';
  return 'ok';
}

async function readDiskVersion() {
  const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
  return (await res.json()).version;
}

function show(state, disk) {
  if (state === 'ok') return setBanner('stale', null);
  setBanner(
    'stale',
    h('div', { class: 'banner' },
      h('span', {
        text: state === 'page'
          ? 'TabDepot was updated while this page was open, so this page is running old code. Reload it to use the new version.'
          : `Version ${disk} is installed in the folder, but the extension is still running ${LOADED}.`,
      }),
      state === 'page'
        ? h('button', { class: 'btn small', text: 'Reload this page', onclick: () => location.reload() })
        : h('button', { class: 'btn small', text: 'Reload extension', onclick: () => chrome.runtime.reload() }))
  );
}

// opts.read / opts.loaded can be replaced in tests.
export async function checkStale(opts = {}) {
  const loaded = opts.loaded ?? LOADED;
  let alive = true;
  let running = null;
  let disk = null;
  try {
    alive = !!chrome.runtime?.id;
    running = alive ? chrome.runtime.getManifest().version : null;
    disk = alive ? await (opts.read || readDiskVersion)() : null;
  } catch {
    alive = !!chrome.runtime?.id; // "Extension context invalidated"
  }
  const state = staleState({ loaded, running, disk, alive });
  show(state, disk);
  return state;
}

export function watchStale() {
  checkStale();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkStale());
  addEventListener('focus', () => checkStale());
  setInterval(checkStale, 60_000);
}
