// Stash / restore logic shared by the service worker and the extension pages.

import {
  STASH_PAGE,
  COLOR_HEX,
  getSettings,
  getState,
  mutate,
  ensureGroup,
  uid,
  hostOf,
  isStashableUrl,
  idbGet,
  idbPut,
  idbDel,
  idbKeys,
} from './common.js';

const channel = new BroadcastChannel('tab-stash');
export const notify = (msg) => channel.postMessage(msg);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
const isWeb = (u) => /^https?:/i.test(u || '');

// ---------- stash page helpers ----------

export async function findStashTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (t.url || '').startsWith(STASH_PAGE));
}

export async function openStashPage(hash = '') {
  const existing = await findStashTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, ...(hash ? { url: STASH_PAGE + hash } : {}) });
    await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url: STASH_PAGE + hash });
}

async function ensureStashTabInWindow(windowId) {
  const existing = await findStashTab();
  if (existing && existing.windowId === windowId) return existing;
  if (existing) {
    await chrome.tabs.move(existing.id, { windowId, index: -1 });
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  return chrome.tabs.create({ windowId, url: STASH_PAGE });
}

// ---------- which tabs to stash ----------

export async function tabsForScope(scope) {
  const settings = await getSettings();
  const norm = (t) => ({ ...t, url: t.url || t.pendingUrl || '' });
  const ok = (t) => isStashableUrl(t.url);
  const pinnedOk = (t) => settings.includePinned || !t.pinned;

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) return [];
  const inWindow = (await chrome.tabs.query({ windowId: active.windowId })).map(norm);

  let result = [];
  switch (scope) {
    case 'tab':
      result = [norm(active)];
      break;
    case 'window':
      result = inWindow.filter(pinnedOk);
      break;
    case 'others':
      result = inWindow.filter((t) => t.id !== active.id && pinnedOk(t));
      break;
    case 'right':
      result = inWindow.filter((t) => t.index > active.index && pinnedOk(t));
      break;
    case 'left':
      result = inWindow.filter((t) => t.index < active.index && pinnedOk(t));
      break;
    case 'highlighted':
      result = inWindow.filter((t) => t.highlighted);
      break;
    case 'site': {
      const host = hostOf(active.url || active.pendingUrl);
      if (!host) return [];
      result = (await chrome.tabs.query({})).map(norm).filter((t) => hostOf(t.url) === host && pinnedOk(t));
      break;
    }
    case 'all':
      result = (await chrome.tabs.query({})).map(norm).filter(pinnedOk);
      break;
  }
  return result.filter(ok);
}

// ---------- scraping + capturing ----------

// Runs inside the page, so it must be fully self-contained.
function scrapePage() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  let description =
    meta('meta[name="description"]') ||
    meta('meta[property="og:description"]') ||
    meta('meta[name="twitter:description"]');
  let ogImage = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  try {
    if (ogImage) ogImage = new URL(ogImage, location.href).href;
  } catch {
    ogImage = '';
  }
  if (!description) {
    const p = [...document.querySelectorAll('p')]
      .map((el) => (el.innerText || '').trim())
      .find((t) => t.length > 60);
    description = p || '';
  }
  return { description: description.replace(/\s+/g, ' ').trim().slice(0, 300), ogImage };
}

async function scrapeTab(tab) {
  if (!isWeb(tab.url) || tab.discarded || tab.status === 'unloaded') return null;
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage }),
      1500
    );
    return res?.[0]?.result || null;
  } catch {
    return null;
  }
}

export async function captureActive(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const w = Math.min(640, bmp.width);
  const h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
}

// Briefly activates tabs that have no cached thumbnail, screenshots them, then restores the
// previously active tab in each window. Discarded tabs are skipped so we never reload them.
async function captureMissing(tabs, thumbs) {
  if (!tabs.length) return;
  const original = new Map();
  for (const t of tabs) {
    if (!original.has(t.windowId)) {
      const [a] = await chrome.tabs.query({ windowId: t.windowId, active: true });
      if (a) original.set(t.windowId, a.id);
    }
  }
  const ordered = [...tabs].sort((a, b) => (original.get(b.windowId) === b.id) - (original.get(a.windowId) === a.id));
  for (const t of ordered) {
    try {
      if (original.get(t.windowId) !== t.id) {
        await chrome.tabs.update(t.id, { active: true });
        for (let i = 0; i < 10; i++) {
          const cur = await chrome.tabs.get(t.id);
          if (cur.status === 'complete') break;
          await sleep(250);
        }
        await sleep(300);
      }
      thumbs.set(t.id, await captureActive(t.windowId));
    } catch {
      /* page can't be captured (restricted, minimised window, ...) */
    }
  }
  for (const id of original.values()) {
    try {
      await chrome.tabs.update(id, { active: true });
    } catch {
      /* gone */
    }
  }
}

// ---------- stash ----------

export async function stashTabs(inputTabs, opts = {}) {
  const settings = await getSettings();
  const { groupId = null, groupName = null, protectWindowId = null, noCapture = false, close = true } = opts;

  const tabs = inputTabs
    .map((t) => ({ ...t, url: t.url || t.pendingUrl || '' }))
    .filter((t) => isStashableUrl(t.url));
  if (!tabs.length) return { count: 0, added: 0 };

  const scraped = await Promise.all(tabs.map(scrapeTab));

  // Thumbnails. YouTube gets its official thumbnail fetched afterwards, so skip screenshots there.
  const thumbs = new Map();
  for (const t of tabs) {
    if (youtubeId(t.url)) continue;
    const live = await idbGet('live', t.id).catch(() => null);
    if (live?.blob && hostOf(live.url) === hostOf(t.url)) thumbs.set(t.id, live.blob);
  }
  // Instant and harmless: screenshot tabs that are on screen right now (no tab switching).
  for (const t of tabs) {
    if (!t.active || thumbs.has(t.id) || youtubeId(t.url) || t.discarded || t.status === 'unloaded' || !isWeb(t.url)) continue;
    try {
      thumbs.set(t.id, await captureActive(t.windowId));
    } catch {
      /* restricted page / window not visible */
    }
  }
  // Optional and slow: visit the rest to screenshot them.
  if (settings.flipCapture && !noCapture) {
    const missing = tabs
      .filter((t) => !thumbs.has(t.id) && !t.discarded && t.status !== 'unloaded' && !t.audible && !youtubeId(t.url) && isWeb(t.url))
      .slice(0, 40);
    await captureMissing(missing, thumbs);
  }

  // Chrome tab groups -> stash groups
  const chromeGroups = new Map();
  if (settings.preserveChromeGroups && !groupId && !groupName) {
    for (const gid of new Set(tabs.map((t) => t.groupId).filter((g) => g > 0))) {
      try {
        chromeGroups.set(gid, await chrome.tabGroups.get(gid));
      } catch {
        /* group vanished */
      }
    }
  }

  const now = Date.now();
  let added = 0;
  await mutate(async (state) => {
    let targetId = groupId;
    if (!targetId && groupName) targetId = ensureGroup(state, groupName).id;

    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      let info = scraped[i] || {};
      if (/(^|\.)youtube\.com$/.test(hostOf(t.url))) info = {}; // single-page app: scraped tags can be stale
      let gid = targetId;
      const cg = chromeGroups.get(t.groupId);
      if (!gid && cg) gid = ensureGroup(state, cg.title || `${cg.color} group`, cg.color).id;

      let item = settings.dedupe ? state.items.find((x) => x.url === t.url) : null;
      if (item) {
        item.addedAt = now;
        item.order = i;
        if (t.title) item.title = t.title;
        if (gid) item.groupId = gid;
        if (info.description) item.description = info.description;
        if (info.ogImage) item.ogImage = info.ogImage;
      } else {
        item = {
          id: uid(),
          url: t.url,
          title: t.title || t.url,
          description: info.description || '',
          ogImage: info.ogImage || '',
          addedAt: now,
          order: i,
          groupId: gid || null,
          note: '',
        };
        state.items.push(item);
        added++;
      }
      if (thumbs.has(t.id)) await idbPut('thumbs', item.id, thumbs.get(t.id));
    }
  });

  if (close) {
    const ids = tabs.map((t) => t.id);
    const win = protectWindowId ?? (await chrome.windows.getLastFocused()).id;
    const inWin = await chrome.tabs.query({ windowId: win });
    if (!inWin.some((t) => !ids.includes(t.id))) await ensureStashTabInWindow(win);
    try {
      await chrome.tabs.remove(ids);
    } catch {
      /* some already closed */
    }
  }
  if (settings.fetchThumbs) enrichMissing().catch(() => {});
  return { count: tabs.length, added };
}

// Debug trail for "Diagnose thumbnail" (null unless a diagnosis is running).
let currentLog = null;
const dbg = (msg) => currentLog?.push(msg);

const decodeEntities = (s) =>
  (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

// Reads title / description / preview image (and a YouTube channel id) straight from the web,
// without opening the page in a tab.
export async function fetchMeta(url) {
  try {
    const res = await fetchWithTimeout(url, 10000);
    const type = res.headers.get('content-type') || '';
    dbg(`page ${url.slice(0, 80)} -> HTTP ${res.status} ${type.split(';')[0]}${res.url && res.url !== url ? ` (redirected to ${res.url.slice(0, 80)})` : ''}`);
    if (!type.includes('html')) return {};
    const text = (await res.text()).slice(0, 800000);
    const meta = (key) => {
      const a = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
      const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, 'i');
      return decodeEntities((text.match(a) || text.match(b) || [])[1]);
    };
    const title = decodeEntities((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) || meta('og:title');
    let ogImage = meta('og:image') || meta('twitter:image');
    try {
      if (ogImage) ogImage = new URL(ogImage, url).href;
    } catch {
      ogImage = '';
    }
    const channelId =
      (text.match(/channel_id=(UC[\w-]{22})/) || text.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/) || [])[1] || '';
    dbg(`  read ${text.length} chars; title="${title.slice(0, 50)}"; og:image=${ogImage ? ogImage.slice(0, 80) : 'none'}; channelId=${channelId || 'none'}`);
    return {
      title: title.slice(0, 200),
      description: (meta('description') || meta('og:description')).slice(0, 300),
      ogImage,
      channelId,
    };
  } catch (e) {
    dbg(`page fetch failed: ${e.message}`);
    return {};
  }
}

export async function stashLink(url, textHint = '') {
  if (!isStashableUrl(url)) return;
  const settings = await getSettings();
  const meta = await fetchMeta(url);
  await mutate((state) => {
    if (settings.dedupe && state.items.some((x) => x.url === url)) return;
    state.items.push({
      id: uid(),
      url,
      title: meta.title || textHint || url,
      description: meta.description || '',
      ogImage: meta.ogImage || '',
      addedAt: Date.now(),
      order: 0,
      groupId: null,
      note: '',
    });
  });
  if (settings.fetchThumbs) enrichMissing().catch(() => {});
}

// ---------- thumbnails fetched from the web (no tabs are touched) ----------

export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else id = (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1];
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } finally {
    clearTimeout(timer);
  }
}

// Downloads an image and shrinks it to a 640px-wide JPEG so the stash stays small.
async function fetchImageBlob(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      dbg(`image ${url.slice(0, 90)} -> HTTP ${res.status}`);
      return null;
    }
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size < 500) {
      dbg(`image ${url.slice(0, 90)} -> not usable (${blob.type || 'no type'}, ${blob.size} bytes)`);
      return null;
    }
    const bmp = await createImageBitmap(blob);
    if (bmp.width < 100 || bmp.height < 60) {
      dbg(`image ${url.slice(0, 90)} -> too small (${bmp.width}x${bmp.height})`);
      return null;
    }
    const w = Math.min(640, bmp.width);
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    dbg(`image ${url.slice(0, 90)} -> OK (${bmp.width}x${bmp.height})`);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  } catch (e) {
    dbg(`image ${url.slice(0, 90)} -> error: ${e.message}`);
    return null;
  }
}

const isYoutubeHost = (url) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(new URL(url).hostname);

// Channels and playlists have no video id, but YouTube publishes an RSS feed for them whose
// newest entry carries a video id we can build a thumbnail from.
async function youtubeFeedInfo(url, channelIdFromHtml) {
  let query = null;
  try {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    const chan = (u.pathname.match(/^\/channel\/(UC[\w-]{22})/) || [])[1] || channelIdFromHtml;
    if (list) query = `playlist_id=${encodeURIComponent(list)}`;
    else if (chan) query = `channel_id=${chan}`;
  } catch {
    return null;
  }
  if (!query) {
    dbg('feed: no channel/playlist id found');
    return null;
  }
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/feeds/videos.xml?${query}`);
    dbg(`feed ${query.slice(0, 50)} -> HTTP ${res.status}`);
    if (!res.ok) return null;
    const xml = await res.text();
    const [head, entry = ''] = xml.split('<entry>');
    const info = {
      videoId: (entry.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1],
      feedTitle: decodeEntities((head.match(/<title>([^<]*)<\/title>/) || [])[1]),
      entryTitle: decodeEntities((entry.match(/<title>([^<]*)<\/title>/) || [])[1]),
    };
    dbg(`  feed "${info.feedTitle}", newest video ${info.videoId || 'none'}`);
    return info.videoId ? info : null;
  } catch (e) {
    dbg(`feed failed: ${e.message}`);
    return null;
  }
}

async function enrichItem(item) {
  const patch = {};
  let blob = null;
  const yt = youtubeId(item.url);
  const onYoutube = isYoutubeHost(item.url);

  if (yt) {
    // maxres is clean 16:9 but missing for some videos; mq is always 16:9; hq has black bars
    for (const q of ['maxresdefault', 'mqdefault', 'hqdefault']) {
      blob = await fetchImageBlob(`https://i.ytimg.com/vi/${yt}/${q}.jpg`);
      if (blob) break;
    }
    try {
      const res = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(item.url)}&format=json`);
      dbg(`oembed -> HTTP ${res.status}`);
      if (res.ok) {
        const o = await res.json();
        if (o.title) patch.title = o.title;
        if (o.author_name && !item.description) patch.description = o.author_name;
      }
    } catch (e) {
      dbg(`oembed failed: ${e.message}`);
    }
  }

  // The preview image remembered from an open tab. Not trusted on YouTube: it is a single-page
  // app, so tags in a loaded tab are often stale or from another page.
  if (!blob && item.ogImage && !onYoutube) blob = await fetchImageBlob(item.ogImage);

  if (!blob) {
    // Read the page's own preview image straight from the web.
    const meta = await fetchMeta(item.url);
    if (meta.ogImage) {
      patch.ogImage = meta.ogImage;
      blob = await fetchImageBlob(meta.ogImage);
    }
    if (meta.description && !item.description) patch.description = meta.description;
    if (meta.title && (!item.title || item.title === item.url)) patch.title = meta.title;

    if (!blob && onYoutube) {
      const feed = await youtubeFeedInfo(item.url, meta.channelId);
      if (feed) {
        blob = await fetchImageBlob(`https://i.ytimg.com/vi/${feed.videoId}/mqdefault.jpg`);
        if (!item.description && !patch.description && feed.entryTitle) patch.description = `Latest: ${feed.entryTitle}`;
      }
    }
  }

  if (blob) await idbPut('thumbs', item.id, blob);
  if (Object.keys(patch).length) {
    await mutate((state) => {
      const it = state.items.find((x) => x.id === item.id);
      if (it) Object.assign(it, patch);
    });
  }
  if (blob) notify({ type: 'thumb', id: item.id });
  dbg(blob ? 'RESULT: thumbnail saved' : 'RESULT: no thumbnail found');
  return !!blob;
}

// Runs the same steps as the background fetch and returns a readable trail of what happened.
export async function diagnoseThumbnail(item) {
  currentLog = [`url: ${item.url}`, `youtube video id: ${youtubeId(item.url) || 'none'}`];
  try {
    await enrichItem(item);
  } catch (e) {
    currentLog.push(`unexpected error: ${e.message}`);
  }
  const log = currentLog;
  currentLog = null;
  return log.join('\n');
}

// Fills in missing thumbnails (3 at a time). Safe to call from anywhere: only one run at a time.
// Items that failed are not retried for a week unless retry/force is set.
export function enrichMissing({ ids = null, force = false, retry = false } = {}) {
  return navigator.locks.request('tab-stash-enrich', { ifAvailable: true }, async (lock) => {
    if (!lock) return { skipped: true };
    const { items } = await getState();
    const have = new Set(await idbKeys('thumbs'));
    const { thumbMiss = {} } = await chrome.storage.local.get('thumbMiss');
    const weekAgo = Date.now() - 7 * 86400000;
    const todo = items.filter(
      (i) =>
        /^https?:/i.test(i.url) &&
        (!ids || ids.includes(i.id)) &&
        (force || !have.has(i.id)) &&
        (force || retry || !(thumbMiss[i.id] > weekAgo))
    );
    if (!todo.length) return { total: 0, fetched: 0 };

    let done = 0;
    let fetched = 0;
    const queue = [...todo];
    notify({ type: 'progress', done, total: todo.length });
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        let ok = false;
        try {
          ok = await enrichItem(item);
        } catch {
          /* ignore */
        }
        if (ok) {
          fetched++;
          delete thumbMiss[item.id];
        } else {
          thumbMiss[item.id] = Date.now();
        }
        notify({ type: 'progress', done: ++done, total: todo.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const live = new Set((await getState()).items.map((i) => i.id));
    for (const id of Object.keys(thumbMiss)) if (!live.has(id)) delete thumbMiss[id];
    await chrome.storage.local.set({ thumbMiss });
    notify({ type: 'progress', done, total: todo.length, finished: true });
    return { total: todo.length, fetched };
  });
}

// ---------- restore ----------

// mode: 'tabs' | 'window' | 'group'
export async function restoreItems(items, opts = {}) {
  if (!items.length) return 0;
  const settings = await getSettings();
  const { mode = 'tabs', background = false, keep = settings.keepOnOpen, groupTitle = '', groupColor = 'grey' } = opts;
  const lazy = settings.lazyRestore && items.length > 3;

  const queue = [...items];
  const created = [];
  let windowId;

  if (mode === 'window') {
    try {
      const first = queue.shift();
      const w = await chrome.windows.create({ url: first.url, focused: true });
      windowId = w.id;
      created.push({ tabId: w.tabs[0].id, item: first });
    } catch (e) {
      console.warn('window restore failed', e);
    }
  }

  let first = created.length === 0;
  for (const item of queue) {
    try {
      const props = { url: item.url, active: first && !background };
      if (windowId != null) props.windowId = windowId;
      const t = await chrome.tabs.create(props);
      created.push({ tabId: t.id, item });
      first = false;
    } catch (e) {
      console.warn('restore failed for', item.url, e);
    }
  }

  if (mode === 'group' && created.length) {
    try {
      const gid = await chrome.tabs.group({ tabIds: created.map((c) => c.tabId) });
      await chrome.tabGroups.update(gid, {
        title: groupTitle,
        color: COLOR_HEX[groupColor] ? groupColor : 'grey',
        collapsed: false,
      });
    } catch (e) {
      console.warn('tab grouping failed', e);
    }
  }

  if (lazy) {
    // Keep memory flat: everything except the focused tab stays unloaded until clicked.
    const skip = background ? 0 : 1;
    for (const c of created.slice(skip)) chrome.tabs.discard(c.tabId).catch(() => {});
  }

  if (!keep && created.length) {
    const ids = new Set(created.map((c) => c.item.id));
    await mutate((state) => {
      state.items = state.items.filter((x) => !ids.has(x.id));
    });
    for (const id of ids) idbDel('thumbs', id).catch(() => {});
  }
  return created.length;
}
