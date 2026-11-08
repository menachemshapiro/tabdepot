// Reading and writing the "Netscape bookmark file" format that every browser can import and export,
// and pulling links out of pasted text (plain URLs, Markdown links, "URL | title" lines, HTML anchors).

import { normalizeState, uid, COLORS } from './common.js';

const BAD_URL = /^(javascript|place|about|data):/i;
const okUrl = (u) => /^[a-z][a-z0-9+.-]*:/i.test(u) && !BAD_URL.test(u);

export const looksLikeBookmarksHtml = (text) => /<DT>/i.test(text) && /<A\s[^>]*HREF=/i.test(text);

export function parseBookmarksHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const groups = [];
  const items = [];
  let n = 0;
  const addLink = (a, groupId) => {
    const url = (a.getAttribute('href') || '').trim();
    if (!okUrl(url)) return;
    const added = Number(a.getAttribute('add_date')) * 1000;
    items.push({
      url,
      title: (a.textContent || '').trim() || url,
      ...(added > 0 ? { addedAt: added } : {}),
      order: n++,
      groupIds: groupId ? [groupId] : [],
    });
  };
  const walk = (dl, parentId, depth) => {
    for (const el of dl.children) {
      if (el.tagName === 'DL') {
        walk(el, parentId, depth); // a list that is not nested in a <DT>
        continue;
      }
      if (el.tagName !== 'DT') continue;
      const head = [...el.children].find((c) => c.tagName === 'H3' || c.tagName === 'A');
      if (head?.tagName === 'A') addLink(head, parentId);
      else if (head?.tagName === 'H3') {
        const g = { id: uid(), name: (head.textContent || '').trim() || 'Folder', color: COLORS[groups.length % COLORS.length], parentId, collapsed: false };
        groups.push(g);
        const inner = [...el.children].find((c) => c.tagName === 'DL') || (el.nextElementSibling?.tagName === 'DL' ? el.nextElementSibling : null);
        if (inner && depth < 12) walk(inner, g.id, depth + 1);
      }
    }
  };
  const top = doc.querySelector('dl');
  if (top) walk(top, null, 0);
  return normalizeState({ items, groups, orders: {} });
}

// Links in free text. Returns [{ url, title }] without duplicates, in order of appearance.
export function linksFromText(text) {
  const found = new Map();
  const add = (url, title = '') => {
    url = url.replace(/[.,;:!?'"]+$/, '');
    while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url) && !/^https?:\/\/(localhost|\d)/i.test(url)) return;
    const prev = found.get(url);
    if (!prev) found.set(url, { url, title: title.trim() });
    else if (!prev.title && title) prev.title = title.trim();
  };
  if (/<a\s[^>]*href=/i.test(text) && typeof DOMParser !== 'undefined') {
    for (const a of new DOMParser().parseFromString(text, 'text/html').querySelectorAll('a[href]')) add(a.getAttribute('href') || '', a.textContent || '');
  }
  for (const m of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g)) add(m[2], m[1]);
  for (const line of text.split(/\r?\n/)) {
    const one = line.match(/^\s*(?:[-*]\s+)?(https?:\/\/\S+?)\s*\|\s*(.+?)\s*$/); // OneTab: "URL | title"
    if (one) add(one[1], one[2]);
  }
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\]\[]+/g)) add(m[0]);
  return [...found.values()];
}

// ---- export ----

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const secs = (ms) => Math.floor((ms || Date.now()) / 1000);

export function buildBookmarksHtml(state, items = state.items) {
  const pick = new Set(items.map((i) => i.id));
  const childrenOf = (pid) => state.groups.filter((g) => (g.parentId ?? null) === pid);
  const link = (i) => `<DT><A HREF="${esc(i.url)}" ADD_DATE="${secs(i.addedAt)}">${esc(i.title || i.url)}</A>`;
  const hasItems = (g) => items.some((i) => i.groupIds.includes(g.id)) || childrenOf(g.id).some(hasItems);
  const folder = (g, pad) => {
    const own = items.filter((i) => i.groupIds.includes(g.id));
    const kids = childrenOf(g.id).filter(hasItems).map((k) => folder(k, pad + '    '));
    return `${pad}<DT><H3>${esc(g.name)}</H3>\n${pad}<DL><p>\n${[...own.map((i) => `${pad}    ${link(i)}`), ...kids].join('\n')}\n${pad}</DL><p>`;
  };
  const rest = items.filter((i) => pick.has(i.id) && !i.groupIds.some((g) => state.groups.some((x) => x.id === g)));
  const body = [...childrenOf(null).filter(hasItems).map((g) => folder(g, '    ')), ...rest.map((i) => `    ${link(i)}`)];
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. It will be read and overwritten. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${body.join('\n')}
</DL><p>
`;
}

export const plainLinks = (items) => items.map((i) => i.url).join('\n') + (items.length ? '\n' : '');
