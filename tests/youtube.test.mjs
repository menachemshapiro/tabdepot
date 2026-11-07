// YouTube thumbnails for videos, channels (@handle pages), playlists, with YouTube's responses mocked.
import { launch, serve, checker, sleep } from './helpers.mjs';

export default async function () {
  const check = checker('youtube');
  const srv = await serve(8131);
  const h = await launch();
  const stash = await h.stashPage();

  const out = await stash.evaluate(async () => {
    const core = await import('./core.js');
    const common = await import('./common.js');
    const realFetch = window.fetch.bind(window);
    const png = (n) => realFetch(`http://localhost:8131/img${n}.png`);
    const FILLER = 'x'.repeat(3_000_000); // YouTube pages are several MB; the useful tags come late
    const html = (head) => new Response(`<!doctype html><html><head><script>${FILLER}</script>${head}</head><body></body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const feed = (title, vid, entry) => new Response(`<?xml version="1.0"?><feed xmlns:yt="x"><title>${title}</title><entry><yt:videoId>${vid}</yt:videoId><title>${entry}</title></entry></feed>`, { status: 200, headers: { 'content-type': 'text/xml' } });
    window.fetch = async (url, opts) => {
      url = String(url);
      if (url.includes('@Late/')) return html('<title>Late Channel - YouTube</title><link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa">');
      if (url.includes('@ItempropOnly')) return html('<title>X - YouTube</title><meta itemprop="channelId" content="UCbbbbbbbbbbbbbbbbbbbbbb">');
      if (url.includes('@NeedsResolve')) return html('<title>Y - YouTube</title>');
      if (url.includes('resolve_url') && String(opts?.body).includes('NeedsResolve')) return new Response(JSON.stringify({ endpoint: { browseEndpoint: { browseId: 'UCcccccccccccccccccccccc' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('resolve_url')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('@Nothing')) return html('<title>Z - YouTube</title>');
      if (url.includes('playlist?list=PLabc')) return html('<title>P - YouTube</title>');
      if (url.includes('channel_id=UCaaaa')) return feed('Late Channel', 'aaaaaaaaaaa', 'Newest A');
      if (url.includes('channel_id=UCbbbb')) return feed('B', 'bbbbbbbbbbb', 'Newest B');
      if (url.includes('channel_id=UCcccc')) return feed('C', 'ccccccccccc', 'Newest C');
      if (url.includes('playlist_id=PLabc')) return feed('P', 'ppppppppppp', 'First');
      if (/\/vi\/(aaaaaaaaaaa|bbbbbbbbbbb|ccccccccccc|ppppppppppp)\/mqdefault/.test(url)) return png(0);
      if (url.includes('/vi/dQw4w9WgXcQ/maxresdefault')) return new Response('', { status: 404 });
      if (url.includes('/vi/dQw4w9WgXcQ/mqdefault')) return png(2);
      if (url.includes('oembed')) return new Response(JSON.stringify({ title: 'Real Title', author_name: 'Chan' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return realFetch(url, opts);
    };
    const mk = (id, url) => ({ id, url, title: id, description: '', ogImage: '', addedAt: Date.now(), order: 0, groupIds: [], note: '' });
    const items = [
      mk('late', 'https://www.youtube.com/@Late/videos'),
      mk('itemprop', 'https://www.youtube.com/@ItempropOnly'),
      mk('resolve', 'https://www.youtube.com/@NeedsResolve/featured'),
      mk('playlist', 'https://www.youtube.com/playlist?list=PLabc'),
      mk('video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      mk('none', 'https://www.youtube.com/@Nothing/featured'),
    ];
    await chrome.storage.local.set({ state: { items, groups: [] }, thumbMiss: {} });
    await common.idbClear('thumbs');
    await core.enrichMissing({});
    const have = new Set(await common.idbKeys('thumbs'));
    return { have: [...have], diag: await core.diagnoseThumbnail(items[5]) };
  });

  check('channel page whose data comes after 3 MB of head (old 800 KB limit failed)', out.have.includes('late'));
  check('channel id found via itemprop meta tag', out.have.includes('itemprop'));
  check('channel id found via resolve_url fallback', out.have.includes('resolve'));
  check('playlist gets the first video thumbnail', out.have.includes('playlist'));
  check('video uses its own thumbnail', out.have.includes('video'));
  check('a page with no information gets none (placeholder)', !out.have.includes('none'));
  check('diagnosis explains what happened', /read \d+ chars/.test(out.diag) && /Start of page|RESULT: no thumbnail/.test(out.diag), out.diag);
  check('no JS errors', h.errors.length === 0, h.errors.join(' | '));
  await h.close();
  srv.close();
  return check.failed();
}
