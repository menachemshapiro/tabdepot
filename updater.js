// Update TabDepot from inside the extension.
//   1. Ask GitHub for the latest release (once every few hours, or on demand).
//   2. Download the release zip and unpack it in memory.
//   3. Write the files into the extension's own folder (you grant access to it once with a folder picker),
//      keep the old files in "previous-version/", then reload the extension.
// An extension cannot overwrite its own files without that permission, which is why the picker is needed.

import { idbGet, idbPut, idbDel } from './common.js';

export const REPO = 'menachemshapiro/tabdepot';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const HANDLE_KEY = 'updateDirHandle';
const BACKUP_DIR = 'previous-version';
const SKIP_WRITE = [/^tests\//, /^\.github\//, /^node_modules\//, /^\.git\//, /^dist\//];
const KEEP_ON_DELETE = [/^previous-version(\/|$)/, /^node_modules(\/|$)/, /^\.git(\/|$)/, /^tests(\/|$)/, /^dist(\/|$)/, /^\./, /^update\.sh$/];

export const supported = () => typeof window.showDirectoryPicker === 'function';

// ---------------- versions ----------------

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const current = () => chrome.runtime.getManifest().version;

// Returns { current, latest, available, zipUrl, size, notes, url } or throws.
export async function checkForUpdate({ api = API } = {}) {
  const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find((a) => /^(tab-stash|tabdepot)-.*\.zip$/.test(a.name));
  const info = {
    current: current(),
    latest,
    available: !!latest && compareVersions(latest, current()) > 0,
    zipUrl: asset?.browser_download_url || '',
    size: asset?.size || 0,
    notes: rel.body || '',
    url: rel.html_url || '',
    checkedAt: Date.now(),
  };
  await chrome.storage.local.set({ updateInfo: info });
  return info;
}

// ---------------- zip reading ----------------

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Reads a zip file in memory. Returns [{ name, data: Uint8Array }] for files (folders are skipped).
export async function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip (central directory)');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('Damaged zip (file header)');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    out.push({ name, data: method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw) : (() => { throw new Error('Unsupported zip compression'); })() });
  }
  return out;
}

// Zips made with "zip -r folder" have one top folder; drop it. Returns files keyed by relative path.
export function stripTopFolder(entries) {
  const manifest = entries.find((e) => /(^|\/)manifest\.json$/.test(e.name) && e.name.split('/').length <= 2);
  if (!manifest) throw new Error('That zip has no manifest.json');
  const prefix = manifest.name.slice(0, manifest.name.length - 'manifest.json'.length);
  return entries.filter((e) => e.name.startsWith(prefix)).map((e) => ({ name: e.name.slice(prefix.length), data: e.data }));
}

// ---------------- folder access ----------------

async function walk(dir, base = '') {
  const files = [];
  for await (const [name, handle] of dir.entries()) {
    const path = base + name;
    if (handle.kind === 'directory') {
      if (KEEP_ON_DELETE.some((r) => r.test(path))) continue;
      files.push(...(await walk(handle, path + '/')));
    } else files.push({ path, handle });
  }
  return files;
}

async function dirFor(root, path, create) {
  const parts = path.split('/');
  const file = parts.pop();
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return { dir, file };
}

async function writeFile(root, path, data) {
  const { dir, file } = await dirFor(root, path, true);
  const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

async function readJson(root, path) {
  const { dir, file } = await dirFor(root, path, false);
  return JSON.parse(await (await (await dir.getFileHandle(file)).getFile()).text());
}

// The folder must be this extension's own folder (same "key" in its manifest).
export async function verifyFolder(root) {
  let m;
  try {
    m = await readJson(root, 'manifest.json');
  } catch {
    throw new Error('That folder has no manifest.json. Pick the TabDepot folder (the one you loaded in chrome://extensions).');
  }
  const mine = chrome.runtime.getManifest();
  if (m.name !== mine.name || (mine.key && m.key !== mine.key)) throw new Error('That does not look like this extension’s folder. Pick the folder you loaded in chrome://extensions.');
  return m;
}

export async function getSavedFolder() {
  return (await idbGet('meta', HANDLE_KEY).catch(() => null)) || null;
}
export const forgetFolder = () => idbDel('meta', HANDLE_KEY);

// Must be called from a click. Returns a verified, writable folder handle.
export async function chooseFolder() {
  let handle = await getSavedFolder();
  if (handle) {
    try {
      if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') handle = null;
      if (handle) await verifyFolder(handle);
    } catch {
      handle = null;
    }
  }
  if (!handle) {
    handle = await window.showDirectoryPicker({ id: 'tab-stash-folder', mode: 'readwrite', startIn: 'documents' });
    await verifyFolder(handle);
    await idbPut('meta', HANDLE_KEY, handle);
  }
  return handle;
}

// ---------------- applying an update ----------------

// files: [{ name, data }] relative to the extension folder. onProgress(done, total, label).
export async function applyFiles(root, files, { onProgress } = {}) {
  await verifyFolder(root);
  const incoming = files.filter((f) => f.name && !f.name.endsWith('/') && !SKIP_WRITE.some((r) => r.test(f.name)));
  const manifestFile = incoming.find((f) => f.name === 'manifest.json');
  if (!manifestFile) throw new Error('The update has no manifest.json');
  const newManifest = JSON.parse(new TextDecoder().decode(manifestFile.data));
  const mine = chrome.runtime.getManifest();
  if (newManifest.name !== mine.name || (mine.key && newManifest.key !== mine.key)) throw new Error('The update does not belong to this extension (different name or key).');
  // keep the "open in every new tab" opt-in across updates
  if (mine.chrome_url_overrides?.newtab && !newManifest.chrome_url_overrides) {
    newManifest.chrome_url_overrides = { newtab: mine.chrome_url_overrides.newtab };
    manifestFile.data = new TextEncoder().encode(JSON.stringify(newManifest, null, 2) + '\n');
  }

  // 1. keep the current files in previous-version/
  const existing = await walk(root);
  const total = existing.length + incoming.length;
  let done = 0;
  try {
    await root.removeEntry(BACKUP_DIR, { recursive: true });
  } catch {
    /* none yet */
  }
  for (const f of existing) {
    if (/^tests\//.test(f.path)) continue;
    await writeFile(root, `${BACKUP_DIR}/${f.path}`, await f.handle.getFile());
    onProgress?.(++done, total, 'Saving the current version');
  }
  // 2. write the new files; the manifest goes last so a failed update never half-applies it
  const ordered = [...incoming.filter((f) => f.name !== 'manifest.json'), manifestFile];
  for (const f of ordered) {
    await writeFile(root, f.name, f.data);
    onProgress?.(++done, total, 'Writing the new version');
  }
  // 3. remove files that no longer exist in the new version
  const names = new Set(incoming.map((f) => f.name));
  for (const f of existing) {
    if (names.has(f.path) || KEEP_ON_DELETE.some((r) => r.test(f.path))) continue;
    const { dir, file } = await dirFor(root, f.path, false);
    await dir.removeEntry(file).catch(() => {});
  }
  return newManifest.version;
}

// Put the saved files back (after a bad update).
export async function rollback(root) {
  await verifyFolder(root).catch(() => {});
  const backupDir = await root.getDirectoryHandle(BACKUP_DIR);
  const files = await walk(backupDir);
  if (!files.length) throw new Error('There is no previous version saved');
  for (const f of files) await writeFile(root, f.path, await f.handle.getFile());
  return (await readJson(backupDir, 'manifest.json')).version;
}

// Download the release, unpack it, check that it is the version announced, write it.
export async function installUpdate(info, root, { onProgress } = {}) {
  if (!info?.zipUrl) throw new Error('This release has no zip file attached');
  onProgress?.(0, 1, 'Downloading');
  const res = await fetch(info.zipUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (info.size && buf.length !== info.size) throw new Error('The download is incomplete. Try again.');
  const files = stripTopFolder(await readZip(buf));
  const version = JSON.parse(new TextDecoder().decode(files.find((f) => f.name === 'manifest.json').data)).version;
  if (info.latest && version !== info.latest) throw new Error(`The zip contains v${version}, not v${info.latest}`);
  if (compareVersions(version, current()) <= 0) throw new Error('That is not newer than the installed version');
  return applyFiles(root, files, { onProgress });
}

export function reloadExtension() {
  setTimeout(() => chrome.runtime.reload(), 600);
}
