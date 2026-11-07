// Link checker: finds dead pages without opening them. Runs from the stash page.
//   status: 'ok' | 'dead' (404/410, removed videos) | 'blocked' (401/403/451: exists but restricted)
//           | 'error' (server error, timeout, cannot connect)

import { youtubeId, hostOf } from './common.js';

const TIMEOUT = 12000;

async function statusOf(url, method, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT);
  const res = await fetch(url, {
    method,
    redirect: 'follow',
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  res.body?.cancel().catch(() => {});
  return res.status;
}

function classify(code) {
  if (code >= 200 && code < 400) return 'ok';
  if (code === 404 || code === 410) return 'dead';
  if (code === 401 || code === 403 || code === 451) return 'blocked';
  return 'error';
}

// Returns { status, code, checkedAt, detail } or null when the result is not meaningful (rate limited).
export async function checkLink(url, signal) {
  const checkedAt = Date.now();
  try {
    if (youtubeId(url)) {
      // A removed/private video still returns 200 for the watch page, but not from oEmbed.
      const code = await statusOf(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, 'GET', signal);
      if (code === 429) return null;
      if (code === 401) return { status: 'ok', code, checkedAt, detail: 'embedding disabled' };
      return { status: classify(code), code, checkedAt, detail: code === 404 ? 'video removed or private' : '' };
    }
    let code = await statusOf(url, 'HEAD', signal);
    // Many servers answer HEAD badly; ask again with GET before calling anything dead.
    if (code !== 404 && code !== 410 && classify(code) !== 'ok') code = await statusOf(url, 'GET', signal);
    if (code === 429) return null;
    return { status: classify(code), code, checkedAt, detail: '' };
  } catch (e) {
    if (signal?.aborted) throw e;
    try {
      const code = await statusOf(url, 'GET', signal); // some servers drop HEAD connections
      if (code === 429) return null;
      return { status: classify(code), code, checkedAt, detail: '' };
    } catch (e2) {
      if (signal?.aborted) throw e2;
      const timedOut = e2.name === 'TimeoutError' || e2.name === 'AbortError';
      return { status: 'error', code: 0, checkedAt, detail: timedOut ? 'timed out' : 'could not connect', network: true };
    }
  }
}

// items: [{id,url}]. onProgress(done,total); onResults({id: result}) in batches.
// Max 6 at once and 2 per site, so one site is never hammered.
export async function checkLinks(items, { onProgress, onResults, signal, concurrency = 6, perHost = 2 } = {}) {
  const queue = items.filter((i) => /^https?:/i.test(i.url)).sort(() => Math.random() - 0.5);
  const total = queue.length;
  const inflight = new Map();
  const batch = {};
  const held = {}; // connection failures: only kept if the network was really fine
  let done = 0;
  let netErrors = 0;
  let flushed = 0;

  const flush = () => {
    if (Object.keys(batch).length) onResults?.({ ...batch });
    for (const k of Object.keys(batch)) delete batch[k];
  };

  const next = () => {
    for (let i = 0; i < queue.length; i++) {
      const host = hostOf(queue[i].url);
      if ((inflight.get(host) || 0) < perHost) return queue.splice(i, 1)[0];
    }
    return null;
  };

  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const item = next();
      if (!item) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      const host = hostOf(item.url);
      inflight.set(host, (inflight.get(host) || 0) + 1);
      try {
        const res = await checkLink(item.url, signal);
        if (res) {
          if (res.network) {
            netErrors++;
            held[item.id] = res;
          } else batch[item.id] = res;
        }
      } catch {
        /* aborted */
      } finally {
        inflight.set(host, inflight.get(host) - 1);
        done++;
        onProgress?.(done, total);
        if (++flushed % 10 === 0) flush();
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  // If almost everything failed to connect, the problem is probably the network, not the links.
  const offline = done >= 8 && netErrors / done > 0.8;
  flush();
  if (!offline && Object.keys(held).length) onResults?.({ ...held });
  return { done, total, offline, aborted: !!signal?.aborted };
}
