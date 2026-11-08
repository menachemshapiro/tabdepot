// Automatic backup to a file you choose (e.g. on your Desktop). The file handle is kept in
// IndexedDB. The browser may ask permission again after a restart; the stash page shows a button.
// Runs while a stash page is open.

import { idbGet, idbPut, idbDel } from './common.js';

const KEY = 'autobackupHandle';
export const FILE_TYPES = [{ description: 'TabDepot backup', accept: { 'application/json': ['.json'] } }];
export const supported = () => typeof window.showSaveFilePicker === 'function';

export const getHandle = () => idbGet('meta', KEY);
export const lastRun = () => idbGet('meta', 'autobackupTs');
export const turnOff = () => idbDel('meta', KEY);

export async function chooseFile() {
  const handle = await window.showSaveFilePicker({ suggestedName: 'tabdepot-autobackup.json', startIn: 'desktop', types: FILE_TYPES });
  await idbPut('meta', KEY, handle);
  return handle;
}

// 'granted' | 'prompt' | 'denied'. request=true must come from a click.
export async function permission(handle, request = false) {
  let p = await handle.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted' && request) p = await handle.requestPermission({ mode: 'readwrite' });
  return p;
}

export async function writeBackup(handle, text) {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
  await idbPut('meta', 'autobackupTs', Date.now());
}
