// Gemeinsame Bausteine für alle Frontend-Module. Bewusst ohne innerHTML: Nutzerinhalte nur per textContent (XSS-sicher).

// Optionale Teile (cond ? el : null) sollen wie in h() einfach wegfallen statt als Text "null" zu erscheinen.
// Gilt nur für null/undefined/false – alles andere verhält sich wie gewohnt.
for (const method of ['replaceChildren', 'append']) {
  const original = Element.prototype[method];
  Element.prototype[method] = function (...nodes) { return original.apply(this, nodes.filter((n) => n != null && n !== false)); };
}
export const $app = document.getElementById('app');
export const $toast = document.getElementById('toast');
export const state = {
  user: null, csrf: null, scope: 'feed', q: '', page: 1, group: null, unread: 0, notifTimer: null,
  config: { sso: null, passwordLogin: true },
};

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// Einfache Linien-Icons (SVG per DOM-API, CSP-konform)
export const ICONS = {
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  plus: 'M12 5v14M5 12h14',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  image: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  sort: 'M3 6h18M6 12h12M10 18h4',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  edit: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  minus: 'M5 12h14',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  chart: 'M3 3v18h18M7 16v-5M12 16V8M17 16V5',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10',
  key: 'M2.59 18.59A2 2 0 0 0 4 22h3v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4zM16.5 7.5h.01',
  plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z',
  fingerprint: 'M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88M17.29 21.02c.12-.6.43-2.3.5-3.02M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .131-5.354 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2M8.65 22c.21-.66.45-1.32.57-2M9 6.8a6 6 0 0 1 9 5.2v2',
};
export function icon(name, { filled = false, size = 20 } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

export let toastTimer;
/** Kurze Meldung unten; optional mit Aktion (z. B. "Rückgängig"). */
export function toast(msg, { action, onAction, ms = 2600 } = {}) {
  $toast.replaceChildren(h('span', {}, msg),
    ...(action ? [h('button', { class: 'toast-action', onclick: () => { $toast.classList.remove('show'); onAction?.(); } }, action)] : []));
  $toast.classList.toggle('has-action', !!action);
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}

// Farbschema: System (Standard), hell oder dunkel – nur eine Komfort-Einstellung pro Browser
export const THEME_KEY = 'quotes-theme';
export function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
export function getTheme() { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } }
export function setTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch { /* privat-Modus */ } applyTheme(t); }
applyTheme(getTheme());

// Eigene Version (vom Server ins HTML geschrieben). Meldet der Server eine andere, gibt es ein Update.
export const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content ?? null;
export let updateShown = false;
export function checkVersion(res) {
  const server = res.headers.get('X-App-Version');
  // Offline kommen Antworten aus dem Service-Worker-Cache (alte Version) -> kein Update-Hinweis
  if (!APP_VERSION || !server || server === APP_VERSION || updateShown || !navigator.onLine) return;
  updateShown = true;
  document.body.append(h('div', { class: 'update-bar', role: 'status' },
    h('span', {}, 'Neue Version verfügbar'),
    h('button', { class: 'btn sm primary', onclick: () => location.reload() }, 'Neu laden')));
}

export async function api(method, url, body) {
  const write = method !== 'GET';
  const res = await fetch(url, {
    method,
    // Schreibende Anfragen immer als JSON (der Server lehnt alles andere ab)
    headers: { ...(write ? { 'Content-Type': 'application/json' } : {}), ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
    body: write ? JSON.stringify(body ?? {}) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  checkVersion(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { setUser(null); state.onUnauthorized?.(); }
    throw new Error(data.error || 'Etwas ist schiefgelaufen.');
  }
  return data;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const fmtDate = (t) => new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
export function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  if (s < 7 * 86400) return `vor ${plural(Math.floor(s / 86400), 'Tag', 'Tagen')}`;
  return fmtDate(t);
}

export function modal(...kids) {
  const dlg = h('dialog', {}, ...kids);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Eingabefeld für mehrere Werte mit Vorschlägen: @Benutzernamen (Standard) oder #Tags. */
export function chipInput({ initial = [], placeholder = '@benutzername', id, prefix = '@', suggest } = {}) {
  let values = [...initial];
  const strip = (v) => (prefix === '#' ? v.trim().replace(/^#+/, '').toLowerCase() : v.trim().replace(/^@/, ''));
  const fetchSuggest = suggest ?? (async (q) => (await api('GET', `/api/users?q=${encodeURIComponent(q)}`)).users);
  const chips = h('div', { class: 'chips' });
  const input = h('input', { type: 'text', id, placeholder, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 31 });
  const list = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  const has = (v) => values.some((x) => x.toLowerCase() === v.toLowerCase());
  const renderChips = () => chips.replaceChildren(...values.map((v) => h('span', { class: 'chip' }, `${prefix}${v}`,
    h('button', { type: 'button', 'aria-label': `${prefix}${v} entfernen`, onclick: () => { values = values.filter((x) => x !== v); renderChips(); } }, '×'))));
  const add = (raw) => {
    const v = strip(raw);
    if (v && !has(v)) values.push(v);
    input.value = ''; list.hidden = true; renderChips();
  };
  let timer, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = strip(input.value);
    if (/[,\s]$/.test(input.value)) return add(input.value.replace(/[,\s]+$/, ''));
    if (!q) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const found = await fetchSuggest(q);
        if (my !== seq) return;
        const opts = found.filter((u) => !has(u));
        list.replaceChildren(...opts.map((u) => h('button', {
          type: 'button', role: 'option', onmousedown: (e) => e.preventDefault(), onclick: () => { add(u); input.focus(); },
        }, `${prefix}${u}`)));
        list.hidden = !opts.length;
      } catch { /* Vorschläge sind optional */ }
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); add(input.value); }
    else if (e.key === 'Backspace' && !input.value && values.length) { values.pop(); renderChips(); }
    else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); list.hidden = true; }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; if (input.value.trim()) add(input.value); }, 150));
  renderChips();
  return { el: h('div', { class: 'chip-input', onclick: (e) => { if (e.target === e.currentTarget || e.target === chips) input.focus(); } }, chips, input, list),
           values: () => { if (input.value.trim()) add(input.value); return values; } };
}

export function setUser(user, csrf = null) {
  state.user = user; state.csrf = user ? csrf : null; state.unread = 0;
  clearInterval(state.notifTimer); state.notifTimer = null;
}

export const VIS = { private: 'Privat', shared: 'Geteilt', public: 'Öffentlich' };
export const quoteAsText = (q) => `„${q.text}“ — ${q.person}${q.source ? `, ${q.source}` : ''}`;

export function avatar(name) {
  const initials = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  return h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials);
}

/** Kleines Aufklapp-Menü an einem Button. items: [icon, label, action, extraClass?] */
export function popMenu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const menu = h('div', { class: 'menu', role: 'menu' }, items.map(([ic, label, fn, cls]) => h('button', {
    role: 'menuitem', class: cls ?? null, onclick: () => { close(); fn(); },
  }, icon(ic), label)));
  const close = () => { menu.remove(); removeEventListener('scroll', onScroll, { capture: true }); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); anchor.setAttribute('aria-expanded', 'false'); };
  const outside = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  // In einem modalen Dialog ist alles außerhalb inert -> Menü in den Dialog hängen; fest am Viewport positionieren
  (anchor.closest('dialog[open]') ?? document.body).append(menu);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6 + menu.offsetHeight > innerHeight ? r.top - menu.offsetHeight - 6 : r.bottom + 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  // Beim Scrollen der Seite/des Dialogs schließen, sonst "schwebt" das Menü vom Button weg
  const onScroll = () => close();
  addEventListener('scroll', onScroll, { capture: true, once: true });
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', esc, true);
  menu.querySelector('button')?.focus({ preventScroll: true });
}
