// Small DOM helpers shared by the stash page modules: element builder, icons, menus, toast.

export const $ = (s, r = document) => r.querySelector(s);

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); // custom properties need setProperty
        else el.style[prop] = val;
      }
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const ICONS = {
  restore: '<path d="M7 17 17 7M8 7h9v9"/>',
  keep: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  note: '<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8 9h8M8 13h5"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
  triage: '<path d="M4 6h10M4 12h16M4 18h7"/><path d="m17 4 3 2-3 2"/>',
};
export function ic(name) {
  const span = h('span', { class: 'ic' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(ts) {
  const s = (ts - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  if (a < 86400 * 365) return rtf.format(Math.round(s / 86400 / 30), 'month');
  return rtf.format(Math.round(s / 86400 / 365), 'year');
}

export function hueOf(str) {
  let n = 0;
  for (const c of str) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % 360;
}

export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------- menus ----------------

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

// anchor: an element, or a point { x, y }.
export function showMenu(anchor, entries) {
  closeMenu();
  const m = h(
    'div',
    { class: 'menu', role: 'menu' },
    entries.filter(Boolean).map((e) =>
      e.sep
        ? h('hr')
        : e.head
          ? h('div', { class: 'menu-head', text: e.head })
          : h('button', { class: 'menu-item' + (e.danger ? ' danger' : ''), disabled: e.disabled, onclick: () => { closeMenu(); e.onClick?.(); } }, e.label)
    )
  );
  document.body.append(m);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const x = Math.min(r.left, innerWidth - m.offsetWidth - 8);
  let y = r.bottom + 6;
  if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - m.offsetHeight - 6);
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = y + 'px';
  openMenu = m;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
addEventListener('scroll', closeMenu, { passive: true });

// ---------------- toast ----------------

let toastTimer;
export function hideToast() {
  $('#toast').hidden = true;
}
export function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(
    h('span', { text: msg }),
    action && h('button', { class: 'link', text: action.label, onclick: () => { hideToast(); action.onClick(); } })
  );
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 9000 : 3500);
}

// ---------------- banners (notices at the top of the page) ----------------

const banners = new Map();
export function setBanner(key, node) {
  if (node) banners.set(key, node);
  else banners.delete(key);
  $('#banner').replaceChildren(...banners.values());
}
