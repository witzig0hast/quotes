// Bewusst ohne innerHTML: alle Nutzerinhalte werden per textContent gesetzt (XSS-sicher).
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const state = {
  user: null, csrf: null, scope: 'feed', q: '', page: 1, group: null, unread: 0, notifTimer: null,
  config: { sso: null, passwordLogin: true },
};

const SSO_ERRORS = {
  access_denied: 'Anmeldung wurde abgebrochen oder abgelehnt.',
  signup_disabled: 'Für dieses SSO-Konto ist keine Registrierung erlaubt. Bitte einen Administrator kontaktieren.',
  invalid_state: 'Die Anmeldung ist abgelaufen. Bitte erneut versuchen.',
  invalid_token: 'Die Anmeldung konnte nicht verifiziert werden.',
  provider_error: 'Der SSO-Anbieter ist gerade nicht erreichbar.',
  already_linked: 'Dieses SSO-Konto gehört bereits zu einem anderen Quotes-Konto und kann nicht verknüpft werden.',
  has_identity: 'Dein Konto ist bereits mit einem anderen SSO-Konto verknüpft. Löse zuerst die bestehende Verknüpfung.',
};

function h(tag, attrs = {}, ...kids) {
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
const ICONS = {
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
};
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

async function api(method, url, body) {
  const write = method !== 'GET';
  const res = await fetch(url, {
    method,
    // Schreibende Anfragen immer als JSON (der Server lehnt alles andere ab)
    headers: { ...(write ? { 'Content-Type': 'application/json' } : {}), ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
    body: write ? JSON.stringify(body ?? {}) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { setUser(null); render(); }
    throw new Error(data.error || 'Etwas ist schiefgelaufen.');
  }
  return data;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtDate = (t) => new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  if (s < 7 * 86400) return `vor ${plural(Math.floor(s / 86400), 'Tag', 'Tagen')}`;
  return fmtDate(t);
}

function modal(...kids) {
  const dlg = h('dialog', {}, ...kids);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Eingabefeld für mehrere Benutzernamen mit Vorschlägen (@-Chips). */
function chipInput({ initial = [], placeholder = '@benutzername', id } = {}) {
  let values = [...initial];
  const chips = h('div', { class: 'chips' });
  const input = h('input', { type: 'text', id, placeholder, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 31 });
  const list = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  const has = (v) => values.some((x) => x.toLowerCase() === v.toLowerCase());
  const renderChips = () => chips.replaceChildren(...values.map((v) => h('span', { class: 'chip' }, `@${v}`,
    h('button', { type: 'button', 'aria-label': `@${v} entfernen`, onclick: () => { values = values.filter((x) => x !== v); renderChips(); } }, '×'))));
  const add = (raw) => {
    const v = raw.trim().replace(/^@/, '');
    if (v && !has(v)) values.push(v);
    input.value = ''; list.hidden = true; renderChips();
  };
  let timer, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim().replace(/^@/, '');
    if (/[,\s]$/.test(input.value)) return add(input.value.replace(/[,\s]+$/, ''));
    if (!q) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const { users } = await api('GET', `/api/users?q=${encodeURIComponent(q)}`);
        if (my !== seq) return;
        const opts = users.filter((u) => !has(u));
        list.replaceChildren(...opts.map((u) => h('button', {
          type: 'button', role: 'option', onmousedown: (e) => e.preventDefault(), onclick: () => { add(u); input.focus(); },
        }, `@${u}`)));
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

function setUser(user, csrf = null) {
  state.user = user; state.csrf = user ? csrf : null; state.unread = 0;
  clearInterval(state.notifTimer); state.notifTimer = null;
}

// ---------- Login / Registrierung ----------
function renderAuth(mode = 'login') {
  const isReg = mode === 'register';
  const err = h('p', { class: 'error', role: 'alert' });
  const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true, maxlength: 30, autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { type: 'password', id: 'p', autocomplete: isReg ? 'new-password' : 'current-password', required: true, maxlength: 200, minlength: isReg ? 10 : null });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, isReg ? 'Konto erstellen' : 'Anmelden');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      try {
        const r = await api('POST', isReg ? '/api/register' : '/api/login', { username: user.value, password: pass.value });
        setUser(r.user, r.csrf);
        Object.assign(state, { scope: 'feed', q: '', page: 1, group: null });
        render({ justLoggedIn: true });
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
  h('label', { for: 'u' }, 'Benutzername'), user,
  h('label', { for: 'p' }, 'Passwort'), pass,
  isReg ? h('div', { class: 'hint' }, 'Mindestens 10 Zeichen.') : null,
  err, btn);

  const { sso, passwordLogin } = state.config;
  const ssoBtn = sso ? h('a', { class: 'btn primary block sso', href: '/api/auth/oidc/login' }, `Mit ${sso.name} anmelden`) : null;
  const pwBlock = passwordLogin ? [
    h('div', { class: 'tabs', role: 'tablist' },
      h('button', { role: 'tab', 'aria-selected': String(!isReg), onclick: () => renderAuth('login') }, 'Anmelden'),
      h('button', { role: 'tab', 'aria-selected': String(isReg), onclick: () => renderAuth('register') }, 'Registrieren')),
    form] : [];
  const divider = ssoBtn && passwordLogin ? h('div', { class: 'or' }, h('span', {}, 'oder mit Passwort')) : null;

  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'auth' },
    h('div', { class: 'logo auth-logo' }, h('i', {}, '“'), 'Quotes'),
    h('h1', {}, 'Worte, die bleiben.'),
    h('p', { class: 'lead' }, 'Sammle Zitate von Menschen, die dich inspirieren – privat oder geteilt mit anderen.'),
    h('div', { class: 'card' }, ssoBtn, divider, pwBlock))));
  if (passwordLogin) user.focus();
}

// ---------- Öffentliche Ansicht (Freigabe-Link, ohne Login) ----------
async function renderPublic(token) {
  const body = h('div', { class: 'list' });
  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'public' },
    h('a', { class: 'logo auth-logo', href: '/' }, h('i', {}, '“'), 'Quotes'), body,
    h('p', { class: 'public-cta' }, h('a', { class: 'btn', href: '/' }, 'Eigene Zitate sammeln')))));
  try {
    const q = await api('GET', `/api/public/quotes/${encodeURIComponent(token)}`);
    document.title = `„${q.text.slice(0, 60)}${q.text.length > 60 ? '…' : ''}“ – ${q.person}`;
    body.append(h('article', { class: 'card quote quote-lg' },
      h('blockquote', {}, q.text),
      h('div', {}, h('span', { class: 'person' }, `— ${q.person}`), q.source ? h('span', { class: 'source' }, `, ${q.source}`) : null),
      h('div', { class: 'meta' }, h('span', {}, `geteilt von @${q.author}`), h('span', {}, fmtDate(q.createdAt)))));
  } catch (ex) {
    body.append(h('div', { class: 'empty' }, h('b', {}, 'Link nicht verfügbar'), ex.message));
  }
}

// ---------- Hauptansicht ----------
const SCOPES = [['feed', 'Entdecken'], ['mine', 'Meine'], ['shared', 'Für mich'], ['liked', 'Favoriten']];
const VIS = { private: 'Privat', shared: 'Geteilt', public: 'Öffentlich' };

async function renderMain({ justLoggedIn = false } = {}) {
  const list = h('div', { class: 'list' });
  const banner = h('div', { class: 'banner', hidden: true });
  const groupBar = h('div', { class: 'groupbar', hidden: true });
  const more = h('button', { class: 'btn more' }, 'Mehr laden');
  more.hidden = true;
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Zitate durchsuchen…', 'aria-label': 'Suche', value: state.q, maxlength: 100 });
  const bellCount = h('span', { class: 'count', hidden: true });
  const bell = h('button', { class: 'icon-btn', 'aria-label': 'Benachrichtigungen', title: 'Benachrichtigungen', onclick: () => openNotifications() }, icon('bell'), bellCount);

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load(true); }, 250); });
  more.addEventListener('click', () => { state.page++; load(false); });

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Ansicht' },
    SCOPES.map(([id, label]) => h('button', { 'data-scope': id, onclick: () => { state.scope = id; state.group = null; load(true); } }, label)));

  $app.replaceChildren(
    h('header', { class: 'nav' }, h('div', { class: 'nav-in' },
      h('div', { class: 'logo' }, h('i', {}, '“'), 'Quotes'),
      h('div', { class: 'spacer' }),
      bell,
      h('button', { class: 'icon-btn', 'aria-label': 'Gruppen', title: 'Gruppen', onclick: () => openGroups() }, icon('users')),
      h('button', { class: 'icon-btn', 'aria-label': 'Konto', title: `Konto (@${state.user.username})`, onclick: () => openAccount() }, icon('user')))),
    h('main', { class: 'container' }, banner, h('div', { class: 'toolbar' }, seg, search), groupBar, list, more),
    h('button', { class: 'btn primary fab', onclick: () => openEditor() }, '+ Neues Zitat'));

  function syncChrome() {
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(state.scope === b.dataset.scope)));
    groupBar.hidden = state.scope !== 'group';
    if (state.scope === 'group') {
      groupBar.replaceChildren(
        h('span', {}, 'Gruppe'), h('b', {}, state.group.name), h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => openGroup(state.group.id) }, 'Mitglieder'),
        h('button', { class: 'btn sm ghost', 'aria-label': 'Gruppenansicht schließen', onclick: () => { state.scope = 'feed'; state.group = null; load(true); } }, '✕'));
    }
  }

  let token = 0;
  async function load(reset) {
    const my = ++token;
    syncChrome();
    if (reset) { state.page = 1; list.replaceChildren(); }
    try {
      const qs = new URLSearchParams({ scope: state.scope, page: state.page, ...(state.q ? { q: state.q } : {}), ...(state.group ? { group: state.group.id } : {}) });
      const { quotes, hasMore } = await api('GET', `/api/quotes?${qs}`);
      if (my !== token) return;
      for (const q of quotes) list.append(quoteCard(q, () => load(true)));
      more.hidden = !hasMore;
      if (!list.children.length) list.append(emptyState());
    } catch (ex) {
      if (my !== token) return;
      toast(ex.message);
      if (state.scope === 'group') { state.scope = 'feed'; state.group = null; load(true); }
    }
  }

  state.reload = () => load(true);
  state.showGroup = (g) => { state.scope = 'group'; state.group = { id: g.id, name: g.name }; state.q = ''; search.value = ''; load(true); window.scrollTo(0, 0); };
  state.updateBell = (n) => {
    state.unread = n;
    bellCount.hidden = !n;
    bellCount.textContent = n > 99 ? '99+' : String(n);
    bell.setAttribute('aria-label', n ? `Benachrichtigungen (${n} neu)` : 'Benachrichtigungen');
  };
  state.hideBanner = () => { banner.hidden = true; };

  load(true);

  // Benachrichtigungen: beim Einloggen Hinweis anzeigen, danach jede Minute aktualisieren
  async function refresh(showBanner) {
    if (document.hidden && !showBanner) return;
    try {
      const { items, unread } = await api('GET', '/api/notifications');
      state.updateBell(unread);
      if (showBanner && unread) showLoginBanner(banner, items.filter((i) => !i.read));
    } catch { /* still */ }
  }
  refresh(true);
  clearInterval(state.notifTimer);
  state.notifTimer = setInterval(() => refresh(false), 60_000);

  if (state.user.usernameSet === false) chooseUsername();
  if (justLoggedIn) window.scrollTo(0, 0);
}

function showLoginBanner(banner, unread) {
  const count = (t) => unread.filter((i) => i.type === t).length;
  const parts = [];
  if (count('mention')) parts.push(`Du wurdest in ${plural(count('mention'), 'Zitat', 'Zitaten')} markiert`);
  if (count('share')) parts.push(`${plural(count('share'), 'Zitat wurde', 'Zitate wurden')} mit dir geteilt`);
  if (count('group_add')) parts.push(`Du wurdest zu ${plural(count('group_add'), 'Gruppe', 'Gruppen')} hinzugefügt`);
  if (!parts.length) return;
  banner.replaceChildren(
    icon('bell'),
    h('div', { class: 'banner-text' }, h('b', {}, 'Neu für dich'), h('span', {}, parts.join(' · '))),
    h('button', { class: 'btn sm primary', onclick: () => { banner.hidden = true; openNotifications(); } }, 'Ansehen'),
    h('button', { class: 'btn sm ghost', 'aria-label': 'Hinweis schließen', onclick: () => { banner.hidden = true; } }, '✕'));
  banner.hidden = false;
}

function emptyState() {
  if (state.scope === 'group') {
    return h('div', { class: 'empty' }, h('b', {}, state.q ? 'Keine Treffer' : 'Noch keine Zitate in dieser Gruppe'),
      state.q ? 'Versuche einen anderen Suchbegriff.' : 'Teile ein Zitat und wähle unter „Geteilt“ diese Gruppe aus.');
  }
  const msgs = {
    feed: ['Noch nichts los hier', 'Sobald jemand ein Zitat öffentlich teilt, erscheint es hier.'],
    mine: ['Deine Sammlung ist leer', 'Füge dein erstes Zitat hinzu – mit dem Button unten rechts.'],
    shared: ['Noch nichts für dich', 'Hier landen Zitate, in denen du markiert bist oder die mit dir bzw. deinen Gruppen geteilt wurden.'],
    liked: ['Keine Favoriten', 'Markiere Zitate mit ♥, um sie hier wiederzufinden.'],
  }[state.scope];
  return h('div', { class: 'empty' }, h('b', {}, state.q ? 'Keine Treffer' : msgs[0]), state.q ? 'Versuche einen anderen Suchbegriff.' : msgs[1]);
}

function quoteCard(q, reload, { compact = false } = {}) {
  const likeBtn = h('button', {
    class: 'btn ghost sm like', 'aria-pressed': String(q.liked), 'aria-label': `Favorit (${q.likes})`,
    onclick: async () => {
      try {
        const r = await api('POST', `/api/quotes/${q.id}/like`);
        q.liked = r.liked; q.likes = r.likes;
        likeBtn.setAttribute('aria-pressed', String(r.liked));
        likeBtn.setAttribute('aria-label', `Favorit (${r.likes})`);
        likeBtn.textContent = `${r.liked ? '♥' : '♡'} ${r.likes}`;
      } catch (ex) { toast(ex.message); }
    },
  }, `${q.liked ? '♥' : '♡'} ${q.likes}`);

  const sharedCount = q.mine && q.visibility === 'shared' ? q.shareWith.length + q.shareGroups.length : 0;
  return h('article', { class: 'card quote' },
    h('blockquote', {}, q.text),
    h('div', {}, h('span', { class: 'person' }, `— ${q.person}`), q.source ? h('span', { class: 'source' }, `, ${q.source}`) : null),
    q.mentions.length ? h('div', { class: 'mentions' }, h('span', {}, 'Markiert:'),
      q.mentions.map((m) => h('span', { class: `mention${m === state.user?.username ? ' me' : ''}` }, `@${m}`))) : null,
    h('div', { class: 'meta' },
      h('span', {}, q.mine ? 'von dir' : `von @${q.author}`), h('span', {}, fmtDate(q.createdAt)),
      q.mine ? h('span', { class: `badge ${q.visibility}` }, VIS[q.visibility] + (sharedCount ? ` (${sharedCount})` : '')) : null,
      q.mine && q.link ? h('span', { class: 'badge', title: 'Per Link geteilt' }, 'Link') : null,
      compact ? null : h('div', { class: 'actions' }, likeBtn,
        q.mine ? [
          h('button', { class: 'btn ghost sm', onclick: () => openLink(q, reload) }, 'Link'),
          h('button', { class: 'btn ghost sm', onclick: () => openEditor(q) }, 'Bearbeiten'),
          h('button', { class: 'btn ghost sm danger', onclick: async () => {
            if (!confirm('Dieses Zitat wirklich löschen?')) return;
            try { await api('DELETE', `/api/quotes/${q.id}`); toast('Gelöscht'); reload(); } catch (ex) { toast(ex.message); }
          } }, 'Löschen')] : null)));
}

// ---------- Editor ----------
async function openEditor(q) {
  const err = h('p', { class: 'error', role: 'alert' });
  const text = h('textarea', { id: 'f-text', required: true, maxlength: 1000, placeholder: 'Was wurde gesagt?' }); text.value = q?.text ?? '';
  const person = h('input', { id: 'f-person', type: 'text', required: true, maxlength: 100, placeholder: 'z. B. Marie Curie' }); person.value = q?.person ?? '';
  const source = h('input', { id: 'f-source', type: 'text', maxlength: 150, placeholder: 'Buch, Rede, Interview … (optional)' }); source.value = q?.source ?? '';
  const mentions = chipInput({ id: 'f-mentions', initial: q?.mentions ?? [], placeholder: '@benutzername' });
  const shareUsers = chipInput({ id: 'f-share', initial: q?.shareWith ?? [], placeholder: '@benutzername' });
  const groupBox = h('div', { class: 'check-group' }, h('span', { class: 'hint' }, 'Gruppen werden geladen …'));
  const shareBox = h('div', { class: 'share-box' },
    h('label', { for: 'f-share' }, 'Teilen mit Personen'), shareUsers.el,
    h('label', {}, 'Teilen mit Gruppen'), groupBox);
  const current = q?.visibility ?? 'private';
  const opts = [['private', 'Privat', 'Nur du (und markierte Personen) siehst es.'],
    ['shared', 'Geteilt', 'Ausgewählte Personen und Gruppen sehen es.'],
    ['public', 'Öffentlich', 'Alle angemeldeten Nutzer sehen es unter „Entdecken“.']];
  const radios = opts.map(([v, t, d]) => h('label', {}, h('input', { type: 'radio', name: 'vis', value: v, checked: v === current }), h('span', {}, t, h('small', {}, d))));
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Speichern');
  let dlg;
  const sync = () => { shareBox.hidden = dlg.querySelector('input[name=vis]:checked').value !== 'shared'; };
  const form = h('form', {
    onchange: sync,
    onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true; err.textContent = '';
      const visibility = dlg.querySelector('input[name=vis]:checked').value;
      const body = { text: text.value, person: person.value, source: source.value, visibility, mentions: mentions.values(),
        shareWith: shareUsers.values(), shareGroups: [...groupBox.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
      try {
        await (q ? api('PUT', `/api/quotes/${q.id}`, body) : api('POST', '/api/quotes', body));
        dlg.close(); toast('Gespeichert'); state.reload?.();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    },
  },
  h('h2', {}, q ? 'Zitat bearbeiten' : 'Neues Zitat'),
  h('label', { for: 'f-text' }, 'Zitat'), text, h('label', { for: 'f-person' }, 'Person'), person,
  h('label', { for: 'f-source' }, 'Quelle'), source,
  h('label', { for: 'f-mentions' }, 'Personen markieren'), mentions.el,
  h('div', { class: 'hint' }, 'Markierte Nutzer sehen das Zitat immer und werden benachrichtigt.'),
  h('label', {}, 'Sichtbarkeit'), h('div', { class: 'radio-group' }, radios), shareBox, err,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'), save));
  dlg = modal(form);
  sync();
  text.focus();

  try {
    const { groups } = await api('GET', '/api/groups');
    const selected = new Set((q?.shareGroups ?? []).map((g) => g.id));
    groupBox.replaceChildren(...(groups.length
      ? groups.map((g) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: g.id, checked: selected.has(g.id) }),
        h('span', {}, g.name, h('small', {}, plural(g.memberCount, 'Mitglied', 'Mitglieder')))))
      : [h('span', { class: 'hint' }, 'Du bist noch in keiner Gruppe. Gruppen legst du oben über das Personen-Symbol an.')]));
  } catch { groupBox.replaceChildren(h('span', { class: 'hint' }, 'Gruppen konnten nicht geladen werden.')); }
}

// ---------- Freigabe-Link ----------
function openLink(q, reload) {
  const body = h('div');
  const dlg = modal(h('h2', {}, 'Per Link teilen'),
    h('p', { class: 'hint' }, 'Jeder mit diesem Link kann das Zitat lesen – auch ohne Konto. Markierungen und Empfänger bleiben verborgen.'),
    body, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Fertig')));
  const draw = () => {
    if (!q.link) {
      body.replaceChildren(h('button', { class: 'btn primary block', onclick: async () => {
        try { q.link = (await api('POST', `/api/quotes/${q.id}/link`)).link; draw(); reload(); } catch (ex) { toast(ex.message); }
      } }, h('span', {}, icon('link')), 'Link erstellen'));
      return;
    }
    const url = new URL(q.link, location.origin).toString();
    const field = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Freigabe-Link', onfocus: (e) => e.target.select() });
    body.replaceChildren(h('div', { class: 'linkbox' }, field,
      h('button', { class: 'btn primary', onclick: async () => {
        try { await navigator.clipboard.writeText(url); toast('Link kopiert'); } catch { field.select(); toast('Bitte manuell kopieren'); }
      } }, 'Kopieren')),
      h('div', { class: 'row left' },
        navigator.share ? h('button', { class: 'btn', onclick: () => navigator.share({ title: 'Zitat', text: `„${q.text}“ — ${q.person}`, url }).catch(() => {}) }, 'Teilen …') : null,
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Link deaktivieren? Wer ihn hat, kann das Zitat dann nicht mehr öffnen.')) return;
          try { await api('DELETE', `/api/quotes/${q.id}/link`); q.link = null; draw(); reload(); toast('Link deaktiviert'); } catch (ex) { toast(ex.message); }
        } }, 'Link deaktivieren')));
  };
  draw();
}

// ---------- Benachrichtigungen ----------
async function openNotifications() {
  const list = h('div', { class: 'notif-list' }, h('p', { class: 'hint' }, 'Wird geladen …'));
  const dlg = modal(h('h2', {}, 'Benachrichtigungen'), list,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')));
  state.hideBanner?.();
  try {
    const { items, unread } = await api('GET', '/api/notifications');
    if (unread) { api('POST', '/api/notifications/read').catch(() => {}); state.updateBell?.(0); }
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'empty small' }, h('b', {}, 'Alles ruhig'), 'Wenn dich jemand markiert, etwas mit dir teilt oder dich zu einer Gruppe hinzufügt, siehst du es hier.'));
      return;
    }
    list.replaceChildren(...items.map((n) => {
      const what = {
        mention: [h('b', {}, `@${n.actor}`), ' hat dich in einem Zitat markiert'],
        share: [h('b', {}, `@${n.actor}`), ' hat ein Zitat mit dir geteilt'],
        group_add: [h('b', {}, `@${n.actor}`), ' hat dich zur Gruppe ', h('b', {}, `„${n.groupName}“`), ' hinzugefügt'],
      }[n.type];
      const open = async () => {
        dlg.close();
        if (n.groupId) return openGroup(n.groupId);
        try { const q = await api('GET', `/api/quotes/${n.quoteId}`); openQuote(q); } catch (ex) { toast(ex.message); }
      };
      return h('button', { class: `notif${n.read ? '' : ' unread'}`, onclick: open },
        h('div', {}, ...what),
        n.quoteText ? h('div', { class: 'notif-quote' }, `„${n.quoteText}${n.quoteText.length >= 140 ? '…' : ''}“ — ${n.quotePerson}`) : null,
        h('div', { class: 'notif-time' }, relTime(n.createdAt)));
    }));
  } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
}

function openQuote(q) {
  const dlg = modal(quoteCard(q, () => { dlg.close(); state.reload?.(); }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')));
  dlg.classList.add('quote-dialog');
}

// ---------- Gruppen ----------
async function openGroups() {
  const list = h('div', { class: 'group-list' }, h('p', { class: 'hint' }, 'Wird geladen …'));
  const err = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { type: 'text', id: 'g-name', required: true, maxlength: 50, placeholder: 'z. B. Lesekreis' });
  const members = chipInput({ id: 'g-members' });
  const create = h('button', { class: 'btn primary', type: 'submit' }, 'Gruppe erstellen');
  const dlg = modal(h('h2', {}, 'Gruppen'),
    h('p', { class: 'hint' }, 'Teile Zitate mit allen Mitgliedern einer Gruppe auf einmal.'),
    list,
    h('details', { class: 'new-group' }, h('summary', {}, '+ Neue Gruppe'),
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault(); err.textContent = ''; create.disabled = true;
          try {
            const g = await api('POST', '/api/groups', { name: name.value, members: members.values() });
            dlg.close(); toast(`Gruppe „${g.name}“ erstellt`); openGroup(g.id);
          } catch (ex) { err.textContent = ex.message; create.disabled = false; }
        },
      }, h('label', { for: 'g-name' }, 'Name'), name, h('label', { for: 'g-members' }, 'Mitglieder'), members.el, err,
      h('div', { class: 'row' }, create))),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')));
  try {
    const { groups } = await api('GET', '/api/groups');
    if (!groups.length) dlg.querySelector('details').open = true;
    list.replaceChildren(...(groups.length ? groups.map((g) => h('button', { class: 'group-item', onclick: () => { dlg.close(); openGroup(g.id); } },
      h('span', { class: 'group-name' }, g.name),
      h('span', { class: 'hint' }, plural(g.memberCount, 'Mitglied', 'Mitglieder') + (g.isOwner ? ' · Besitzer' : '')), h('span', { 'aria-hidden': 'true' }, '›')))
      : [h('p', { class: 'hint' }, 'Du bist noch in keiner Gruppe.')]));
  } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
}

async function openGroup(id) {
  let g;
  try { g = await api('GET', `/api/groups/${id}`); } catch (ex) { return toast(ex.message); }
  const err = h('p', { class: 'error', role: 'alert' });
  const body = h('div');
  const dlg = modal(body);
  const close = () => dlg.close();
  const refresh = async () => { try { g = await api('GET', `/api/groups/${id}`); draw(); } catch (ex) { close(); toast(ex.message); } };

  function draw() {
    const add = chipInput({ id: 'gm-add' });
    const title = h('h2', {}, g.name);
    const rename = g.isOwner ? h('button', { class: 'btn ghost sm', onclick: async () => {
      const n = prompt('Neuer Gruppenname', g.name);
      if (n == null) return;
      try { g = await api('PATCH', `/api/groups/${id}`, { name: n }); if (state.group?.id === id) state.group.name = g.name; draw(); state.reload?.(); } catch (ex) { toast(ex.message); }
    } }, 'Umbenennen') : null;
    body.replaceChildren(
      h('div', { class: 'dialog-head' }, title, rename),
      h('button', { class: 'btn primary block', onclick: () => { close(); state.showGroup?.(g); } }, 'Zitate der Gruppe ansehen'),
      h('label', {}, plural(g.members.length, 'Mitglied', 'Mitglieder')),
      h('ul', { class: 'members' }, g.members.map((m) => h('li', {},
        h('span', {}, `@${m.username}`, m.username === state.user.username ? h('small', {}, ' (du)') : null),
        m.role === 'owner' ? h('span', { class: 'badge' }, 'Besitzer') : null,
        g.isOwner && m.role !== 'owner' ? h('button', { class: 'btn ghost sm danger', 'aria-label': `@${m.username} entfernen`, onclick: async () => {
          if (!confirm(`@${m.username} aus der Gruppe entfernen?`)) return;
          try { await api('DELETE', `/api/groups/${id}/members/${m.id}`); refresh(); } catch (ex) { toast(ex.message); }
        } }, 'Entfernen') : null))),
      g.isOwner ? h('form', {
        onsubmit: async (e) => {
          e.preventDefault(); err.textContent = '';
          const usernames = add.values();
          if (!usernames.length) return;
          try { g = await api('POST', `/api/groups/${id}/members`, { usernames }); draw(); toast('Hinzugefügt'); } catch (ex) { err.textContent = ex.message; }
        },
      }, h('label', { for: 'gm-add' }, 'Mitglieder hinzufügen'), add.el, err, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Hinzufügen'))) : null,
      h('div', { class: 'row split' },
        g.isOwner
          ? h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(`Gruppe „${g.name}“ löschen? Mit ihr geteilte Zitate sind dann für die Mitglieder nicht mehr sichtbar.`)) return;
            try { await api('DELETE', `/api/groups/${id}`); close(); toast('Gruppe gelöscht'); leaveGroupView(); } catch (ex) { toast(ex.message); }
          } }, 'Gruppe löschen')
          : h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(`Gruppe „${g.name}“ verlassen?`)) return;
            try { await api('DELETE', `/api/groups/${id}/members/${state.user.id}`); close(); toast('Gruppe verlassen'); leaveGroupView(); } catch (ex) { toast(ex.message); }
          } }, 'Gruppe verlassen'),
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Schließen')));
  }
  const leaveGroupView = () => { if (state.group?.id === id) { state.scope = 'feed'; state.group = null; } state.reload?.(); };
  draw();
}

// ---------- Konto ----------
function usernameForm({ onDone, submitLabel = 'Speichern' }) {
  const err = h('p', { class: 'error', role: 'alert' });
  const input = h('input', { type: 'text', id: 'acc-username', required: true, minlength: 3, maxlength: 30, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'username', pattern: '[A-Za-z0-9_.\\-]{3,30}' });
  input.value = state.user.username;
  const btn = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        const r = await api('PUT', '/api/me/username', { username: input.value.trim() });
        state.user = { ...state.user, username: r.user.username, usernameSet: true };
        onDone?.(r.user.username);
      } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
    },
  }, h('label', { for: 'acc-username' }, 'Benutzername'), h('div', { class: 'linkbox' }, input, btn),
  h('div', { class: 'hint' }, '3–30 Zeichen: Buchstaben, Zahlen, _ . -  ·  Unter diesem Namen können andere dich finden und markieren.'), err);
  return { form, input };
}

/** Beim ersten SSO-Login: eigenen Benutzernamen wählen statt den SSO-Namen zu übernehmen. */
function chooseUsername() {
  const { form, input } = usernameForm({
    submitLabel: 'Weiter',
    onDone: () => { dlg.close(); toast('Willkommen!'); renderMain(); },
  });
  const dlg = modal(h('h2', {}, 'Willkommen bei Quotes'),
    h('p', { class: 'hint' }, 'Wähle, unter welchem Namen du hier sichtbar sein möchtest. Der Vorschlag stammt aus deinem SSO-Konto – du kannst ihn übernehmen oder ändern, und später jederzeit im Konto anpassen.'),
    form);
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // nicht wegklickbar
  input.select();
}

function openAccount() {
  const sso = !!state.user.sso;
  const { form: nameForm } = usernameForm({ onDone: (u) => { toast(`Du heißt jetzt @${u}`); dlg.close(); renderMain(); } });
  const err = h('p', { class: 'error', role: 'alert' });
  const pass = h('input', { type: sso ? 'text' : 'password', id: 'acc-del', autocomplete: sso ? 'off' : 'current-password', required: true, maxlength: 200, autocapitalize: 'none', spellcheck: 'false' });
  const delForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!confirm('Konto und alle Zitate endgültig löschen?')) return;
      try { await api('DELETE', '/api/me', sso ? { confirm: pass.value } : { password: pass.value }); dlg.close(); setUser(null); render(); toast('Konto gelöscht'); }
      catch (ex) { err.textContent = ex.message; }
    },
  },
  h('label', { for: 'acc-del' }, sso ? 'Konto löschen – Benutzernamen eintippen' : 'Konto löschen – Passwort bestätigen'), pass,
  sso ? h('div', { class: 'hint' }, 'Dein Konto wird über SSO verwaltet und hat kein Passwort.') : null, err,
  h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, 'Konto endgültig löschen')));
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Konto'), h('button', { class: 'btn sm', onclick: () => { dlg.close(); logout(); } }, 'Abmelden')),
    nameForm,
    ssoSection(() => dlg),
    h('details', { class: 'danger-zone' }, h('summary', {}, 'Konto löschen'), delForm),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')));
}

/** Bereich „Anmeldung mit SSO“: bestehendes Konto verknüpfen bzw. Verknüpfung lösen. */
function ssoSection(getDlg) {
  const { sso } = state.config;
  if (!sso) return null;
  const box = h('section', { class: 'sso-box' });
  const err = h('p', { class: 'error', role: 'alert' });
  const pass = h('input', { type: 'password', id: 'acc-sso-pw', autocomplete: 'current-password', required: true, maxlength: 200 });
  const title = h('label', { for: state.user.sso ? null : 'acc-sso-pw' }, `Anmeldung mit ${sso.name}`);

  if (state.user.ssoLinked) {
    const status = h('p', { class: 'sso-status' }, h('span', { class: 'badge public' }, 'Verknüpft'), ' ',
      h('span', {}, `Du kannst dich mit ${sso.name} anmelden.`));
    if (state.user.sso) { // reines SSO-Konto ohne Passwort: Lösen würde aussperren
      box.append(title, status);
      return box;
    }
    const btn = h('button', { class: 'btn danger', type: 'submit' }, 'Verknüpfung lösen');
    box.append(title, status, h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        if (!confirm(`Verknüpfung mit ${sso.name} lösen? Du meldest dich dann nur noch mit Passwort an.`)) return;
        btn.disabled = true;
        try {
          await api('DELETE', '/api/me/sso', { password: pass.value });
          state.user = { ...state.user, ssoLinked: false };
          getDlg().close(); toast('Verknüpfung gelöst'); openAccount();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      },
    }, h('div', { class: 'hint' }, 'Zum Lösen dein Passwort bestätigen:'), h('div', { class: 'linkbox' }, pass, btn), err));
    return box;
  }

  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Verknüpfen');
  box.append(title, h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        const { url } = await api('POST', '/api/me/sso', { password: pass.value });
        location.assign(url); // weiter zum SSO-Anbieter, danach zurück mit ?sso_linked=1
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  }, h('div', { class: 'hint' }, `Verknüpfe dein bestehendes Konto mit ${sso.name}, um dich künftig auch darüber anzumelden. Deine Zitate, Gruppen und dein Name bleiben erhalten. Bitte dein Passwort bestätigen:`),
  h('div', { class: 'linkbox' }, pass, btn), err));
  return box;
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* egal */ }
  setUser(null); render();
}

function render(opts) {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
  if (m) return renderPublic(m[1]);
  return state.user ? renderMain(opts) : renderAuth();
}

(async () => {
  if (location.pathname.startsWith('/s/')) return render();
  try { state.config = await api('GET', '/api/config'); } catch { /* Standard */ }
  const params = new URLSearchParams(location.search);
  if (params.has('sso_linked')) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(`Konto mit ${state.config.sso?.name ?? 'SSO'} verknüpft`), 100);
  }
  if (params.has('sso_error')) {
    const code = params.get('sso_error');
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(SSO_ERRORS[code] || 'SSO-Anmeldung fehlgeschlagen.'), 100);
  }
  try {
    const r = await api('GET', '/api/me');
    setUser(r.user, r.csrf ?? null);
  } catch { /* nicht angemeldet */ }
  render({ justLoggedIn: true });
})();
