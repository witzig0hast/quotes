// Bewusst ohne innerHTML: alle Nutzerinhalte werden per textContent gesetzt (XSS-sicher).
import { $app, $toast, state, h, ICONS, icon, toast, applyTheme, getTheme, setTheme, checkVersion, api, plural, fmtDate, relTime, modal, chipInput, setUser, VIS, quoteAsText, quoteText, avatar, popMenu, langName, t, LOCALE, LANG } from './core.js';
import { collectionsView, openCollectionEditor, openAddToCollection, openCollectionLink, renderPublicCollection } from './collections.js';
import { personHeader, openRandom, duplicateHint, attachPersonSuggest, importSection } from './people.js';
import { openComments, profileHeader, openStats, openFilters } from './social.js';
import { openGroups, openGroup, renderInvite } from './groups.js';
import { openSuggest, openSuggestions, openReport, openAdmin } from './moderation.js';
import { initPwa, clearOfflineData, takeUrlActions, deviceSection, emailSection } from './pwa.js';
import { QUOTE_LANGS, LANGS, setLang } from './i18n.js';
import { passkeyLoginButton, twoFactorForm, openSecurity, openIntegrations } from './security.js';

const SSO_ERRORS = {
  access_denied: t('Anmeldung wurde abgebrochen oder abgelehnt.'),
  signup_disabled: t('Für dieses SSO-Konto ist keine Registrierung erlaubt. Bitte einen Administrator kontaktieren.'),
  invalid_state: t('Die Anmeldung ist abgelaufen. Bitte erneut versuchen.'),
  invalid_token: t('Die Anmeldung konnte nicht verifiziert werden.'),
  provider_error: t('Der SSO-Anbieter ist gerade nicht erreichbar.'),
  account_disabled: t('Dieses Konto wurde gesperrt.'),
  already_linked: t('Dieses SSO-Konto gehört bereits zu einem anderen Quotes-Konto und kann nicht verknüpft werden.'),
  has_identity: t('Dein Konto ist bereits mit einem anderen SSO-Konto verknüpft. Löse zuerst die bestehende Verknüpfung.'),
};

// ---------- Login / Registrierung ----------
function renderAuth(mode = 'login', notice = state.authNotice) {
  state.authNotice = notice;
  const isReg = mode === 'register';
  const err = h('p', { class: 'error', role: 'alert' });
  const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true, maxlength: 30, autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { type: 'password', id: 'p', autocomplete: isReg ? 'new-password' : 'current-password', required: true, maxlength: 200, minlength: isReg ? 10 : null });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, isReg ? t('Konto erstellen') : t('Anmelden'));
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      try {
        finishLogin(await api('POST', isReg ? '/api/register' : '/api/login', { username: user.value, password: pass.value }));
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
  h('label', { for: 'u' }, t('Benutzername')), user,
  h('label', { for: 'p' }, t('Passwort')), pass,
  isReg ? h('div', { class: 'hint' }, t('Mindestens 10 Zeichen.')) : null,
  err, btn);

  const card = h('div', { class: 'card' });
  // Nach Passwort/Passkey: Sitzung übernehmen oder zweiten Faktor abfragen
  const finishLogin = (r) => {
    if (r.twoFactor) {
      card.replaceChildren(twoFactorForm(r.ticket, { onUser: finishLogin, onBack: () => renderAuth('login') }));
      return;
    }
    setUser(r.user, r.csrf);
    Object.assign(state, { scope: 'feed', q: '', page: 1, group: null });
    render({ justLoggedIn: true });
  };
  const { sso, passwordLogin } = state.config;
  const ssoBtn = sso ? h('a', { class: 'btn primary block sso', href: '/api/auth/oidc/login' }, t('Mit {0} anmelden', sso.name)) : null;
  const passkeyBtn = isReg ? null : passkeyLoginButton(finishLogin, (msg) => { if (err.isConnected) err.textContent = msg; else toast(msg); });
  const pwBlock = passwordLogin ? [
    h('div', { class: 'tabs', role: 'tablist' },
      h('button', { role: 'tab', 'aria-selected': String(!isReg), onclick: () => renderAuth('login') }, t('Anmelden')),
      h('button', { role: 'tab', 'aria-selected': String(isReg), onclick: () => renderAuth('register') }, t('Registrieren'))),
    form] : [];
  const divider = (ssoBtn || passkeyBtn) && passwordLogin ? h('div', { class: 'or' }, h('span', {}, t('oder mit Passwort'))) : null;

  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'auth' },
    h('div', { class: 'logo auth-logo' }, h('i', {}, '“'), t('Quotes')),
    h('h1', {}, t('Worte, die bleiben.')),
    h('p', { class: 'lead' }, t('Sammle Zitate von Menschen, die dich inspirieren – privat oder geteilt mit anderen.')),
    notice ? h('p', { class: 'auth-notice' }, notice) : null,
    card,
    h('p', { class: 'lang-switch' }, Object.entries(LANGS).filter(([code]) => code !== LANG).map(([code, name]) =>
      h('button', { class: 'link-btn', type: 'button', lang: code, onclick: () => setLang(code) }, name))))));
  card.append(ssoBtn, passkeyBtn, divider, ...pwBlock);
  if (passwordLogin) user.focus();
}

// ---------- Öffentliche Ansicht (Freigabe-Link, ohne Login) ----------
async function renderPublic(token) {
  const body = h('div', { class: 'list' });
  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'public-page' },
    h('a', { class: 'logo auth-logo', href: '/' }, h('i', {}, '“'), t('Quotes')), body,
    h('p', { class: 'public-cta' }, h('a', { class: 'btn', href: '/' }, t('Eigene Zitate sammeln'))))));
  try {
    const q = await api('GET', `/api/public/quotes/${encodeURIComponent(token)}`);
    document.title = `„${q.text.slice(0, 60)}${q.text.length > 60 ? '…' : ''}“ – ${q.person}`;
    body.append(h('article', { class: 'card quote quote-lg' },
      quoteText(q),
      h('div', {}, h('span', { class: 'person' }, `— ${q.person}`), q.source ? h('span', { class: 'source' }, `, ${q.source}`) : null),
      h('div', { class: 'meta' }, h('span', {}, t('geteilt von @{0}', q.author)), h('span', {}, fmtDate(q.createdAt)))));
  } catch (ex) {
    body.append(h('div', { class: 'empty' }, h('b', {}, t('Link nicht verfügbar')), ex.message));
  }
}

// ---------- Hauptansicht ----------
const SCOPES = [['feed', t('Entdecken'), 'compass'], ['mine', t('Meine'), 'bookmark'], ['shared', t('Für mich'), 'inbox'], ['liked', t('Favoriten'), 'heart']];
const pendingDeletes = new Map(); // Zitat-ID -> sofort ausführen (für "Rückgängig")

async function renderMain({ justLoggedIn = false } = {}) {
  Object.assign(state, { tag: state.tag ?? null, person: state.person ?? null, sort: state.sort ?? 'new' });
  const list = h('div', { class: 'list', 'aria-live': 'polite' });
  const banner = h('div', { class: 'banner', hidden: true });
  const groupBar = h('div', { class: 'groupbar', hidden: true });
  const collBar = h('section', { class: 'collhead', hidden: true });
  const subSeg = h('div', { class: 'subseg', role: 'group', hidden: true });
  const SUBS = {
    feed: [['feed', t('Alle')], ['following', t('Gefolgt')]], following: [['feed', t('Alle')], ['following', t('Gefolgt')]],
    mine: [['mine', t('Zitate')], ['collections', t('Sammlungen'), 'folder']], collections: [['mine', t('Zitate')], ['collections', t('Sammlungen'), 'folder']],
  };
  const filterBtn = h('button', { class: 'btn sort-btn filter-btn', title: t('Filter: Zeitraum, Person, Tag, Sichtbarkeit'), 'aria-label': t('Filter'),
    onclick: () => openFilters(state, (f) => { Object.assign(state, f); load(true); }) }, icon('sliders'));
  const randomBtn = h('button', { class: 'btn sort-btn random-btn', title: t('Überrasch mich – zufälliges Zitat'), 'aria-label': t('Überrasch mich – zufälliges Zitat'),
    onclick: () => openRandom(['mine', 'liked'].includes(state.scope) ? state.scope : 'feed', quoteCard) }, icon('shuffle'));
  const filterBar = h('div', { class: 'filters' });
  const daily = h('div', { class: 'daily-slot' });
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  const more = h('button', { class: 'btn more', hidden: true }, t('Mehr laden'));
  const search = h('input', { type: 'search', id: 'search', class: 'search', placeholder: t('Suchen …'), title: t('Durchsucht Text, Person, Quelle und #Tags (Taste /)'), 'aria-label': t('Suche'), value: state.q, maxlength: 100, enterkeyhint: 'search' });
  const sortBtn = h('button', { class: 'btn sort-btn', title: t('Sortierung'), onclick: () => { state.sort = state.sort === 'top' ? 'new' : 'top'; load(true); } });
  const bellCount = h('span', { class: 'count', hidden: true });
  const bell = h('button', { class: 'icon-btn', 'aria-label': t('Benachrichtigungen'), title: t('Benachrichtigungen'), onclick: () => openNotifications() }, icon('bell'), bellCount);
  const newBtn = h('button', { class: 'btn primary new-btn', onclick: () => openEditor(), title: t('Neues Zitat (N)') }, icon('plus'), h('span', {}, t('Neues Zitat')));

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load(true); }, 250); });
  more.addEventListener('click', () => loadMore());

  const setScope = (id, extra = {}) => {
    Object.assign(state, { scope: id, group: null, collection: null, profile: null, tag: null, person: null, from: null, to: null, vis: null }, extra);
    load(true); window.scrollTo({ top: 0 });
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('Ansicht') },
    SCOPES.map(([id, label]) => h('button', { 'data-scope': id, onclick: () => setScope(id) }, label)));
  // Handy: Navigationsleiste unten (Daumen-Reichweite), "+" in der Mitte
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': t('Ansicht') },
    SCOPES.slice(0, 2).map(([id, label, ic]) => h('button', { 'data-scope': id, onclick: () => setScope(id) }, icon(ic), h('span', {}, label))),
    h('button', { class: 'tab-new', 'aria-label': t('Neues Zitat'), onclick: () => openEditor() }, icon('plus')),
    SCOPES.slice(2).map(([id, label, ic]) => h('button', { 'data-scope': id, onclick: () => setScope(id) }, icon(ic), h('span', {}, label))));

  $app.replaceChildren(
    h('header', { class: 'nav' }, h('div', { class: 'nav-in' },
      h('button', { class: 'logo logo-btn', onclick: () => setScope('feed'), 'aria-label': t('Quotes – Startseite') }, h('i', {}, '“'), t('Quotes')),
      h('div', { class: 'spacer' }),
      newBtn, bell,
      h('button', { class: 'icon-btn', 'aria-label': t('Gruppen'), title: t('Gruppen'), onclick: () => openGroups() }, icon('users')),
      h('button', { class: 'icon-btn avatar-btn', 'aria-label': t('Konto (@{0})', state.user.username), title: t('Konto (@{0})', state.user.username), onclick: () => openAccount() }, avatar(state.user.username)))),
    h('main', { class: 'container' }, banner, h('div', { class: 'toolbar' }, seg, h('div', { class: 'search-row' }, h('span', { class: 'search-wrap' }, icon('search'), search), sortBtn, filterBtn, randomBtn)),
      subSeg, groupBar, collBar, filterBar, daily, list, sentinel, more),
    tabbar);

  function syncChrome() {
    const navScope = ['collections', 'collection'].includes(state.scope) && state.collection?.isOwner !== false ? 'mine'
      : state.scope === 'following' ? 'feed' : state.scope;
    for (const b of [...seg.children, ...tabbar.querySelectorAll('[data-scope]')]) b.setAttribute('aria-current', navScope === b.dataset.scope ? 'page' : 'false');
    const subs = SUBS[state.scope];
    subSeg.hidden = !subs;
    if (subs) {
      subSeg.setAttribute('aria-label', state.scope === 'mine' || state.scope === 'collections' ? t('Meine') : t('Entdecken'));
      subSeg.replaceChildren(...subs.map(([id, label, ic]) => h('button', { 'aria-pressed': String(id === state.scope), onclick: () => setScope(id) },
        ic ? icon(ic, { size: 16 }) : null, label)));
    }
    filterBtn.classList.toggle('on', !!(state.from || state.to || state.vis));
    const listMode = !['collections', 'collection'].includes(state.scope);
    search.closest('.search-row').hidden = !listMode;
    collBar.hidden = state.scope !== 'collection';
    if (state.scope === 'collection') {
      const c = state.collection;
      collBar.replaceChildren(
        h('div', { class: 'collhead-top' }, h('span', { class: 'daily-label' }, c.isOwner ? t('Sammlung') : t('Sammlung von @{0}', c.owner)),
          h('button', { class: 'icon-btn sm', 'aria-label': t('Sammlung schließen'), onclick: () => setScope(c.isOwner ? 'collections' : 'feed') }, '✕')),
        h('h2', {}, c.name),
        c.description ? h('p', { class: 'coll-intro' }, c.description) : null,
        c.isOwner ? h('div', { class: 'collhead-actions' },
          h('button', { class: 'btn sm', onclick: () => openCollectionLink(c, () => load(true)) }, icon('link', { size: 16 }), h('span', {}, c.link ? t('Link verwalten') : t('Per Link teilen'))),
          h('button', { class: 'btn sm', onclick: () => openCollectionEditor(c, (sv) => { state.collection = { ...c, ...sv }; load(true); }, () => setScope('collections')) }, icon('edit', { size: 16 }), h('span', {}, t('Bearbeiten')))) : null);
    }
    sortBtn.replaceChildren(icon('sort'), h('span', {}, state.sort === 'top' ? t('Beliebteste') : t('Neueste')));
    sortBtn.classList.toggle('on', state.sort === 'top');
    sortBtn.setAttribute('aria-label', t('Sortierung: {0} (umschalten)', state.sort === 'top' ? t('Beliebteste') : t('Neueste')));
    groupBar.hidden = state.scope !== 'group';
    if (state.scope === 'group') {
      groupBar.replaceChildren(
        h('span', {}, t('Gruppe')), h('b', {}, state.group.name), h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => openGroup(state.group.id) }, t('Mitglieder')),
        h('button', { class: 'btn sm ghost', 'aria-label': t('Gruppenansicht schließen'), onclick: () => setScope('feed') }, '✕'));
    }
  }

  async function drawFilters() {
    const active = [];
    if (state.person) active.push(h('button', { class: 'fchip on', onclick: () => { state.person = null; load(true); }, 'aria-label': t('Filter {0} entfernen', state.person) }, h('span', {}, state.person), ' ✕'));
    if (state.tag) active.push(h('button', { class: 'fchip on', onclick: () => { state.tag = null; load(true); }, 'aria-label': t('Filter #{0} entfernen', state.tag) }, `#${state.tag} ✕`));
    if (state.from || state.to) {
      const d = (v) => new Date(`${v}T00:00:00Z`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      const label = state.from && state.to ? `${d(state.from)} – ${d(state.to)}` : state.from ? t('ab {0}', d(state.from)) : t('bis {0}', d(state.to));
      active.push(h('button', { class: 'fchip on', onclick: () => { state.from = state.to = null; load(true); }, 'aria-label': t('Zeitraum-Filter entfernen') }, `${label} ✕`));
    }
    if (state.vis) active.push(h('button', { class: 'fchip on', onclick: () => { state.vis = null; load(true); }, 'aria-label': t('Sichtbarkeits-Filter entfernen') }, `${VIS[state.vis]} ✕`));
    if (active.length) { filterBar.replaceChildren(h('span', { class: 'flabel' }, t('Filter')), ...active); return; }
    filterBar.replaceChildren();
    if (['group', 'collections', 'collection'].includes(state.scope)) return;
    try {
      const { tags } = await api('GET', `/api/tags${state.scope === 'mine' ? '?scope=mine' : ''}`);
      if (state.tag || state.person || !tags.length) return;
      filterBar.replaceChildren(...tags.slice(0, 12).map((t) => h('button', { class: 'fchip', onclick: () => filterBy({ tag: t.tag }) }, `#${t.tag}`)));
    } catch { /* optional */ }
  }

  async function drawDaily() {
    daily.replaceChildren();
    if (state.scope === 'user') {
      const who = state.profile;
      const head = await profileHeader(who);
      if (state.profile === who) daily.replaceChildren(head);
      return;
    }
    if (state.person) {
      const who = state.person;
      const head = await personHeader(who, { onTag: (t) => filterBy({ tag: t }) });
      if (state.person === who) daily.replaceChildren(head);
      return;
    }
    if (state.scope !== 'feed' || state.q || state.tag || state.person) return;
    try {
      const { quote: q } = await api('GET', '/api/daily');
      if (!q || state.scope !== 'feed') return;
      daily.replaceChildren(h('section', { class: 'daily', 'aria-label': t('Zitat des Tages') },
        h('div', { class: 'daily-label' }, t('Zitat des Tages')),
        quoteText(q),
        h('div', { class: 'daily-foot' },
          h('button', { class: 'person-link', onclick: () => filterBy({ person: q.person }) }, `— ${q.person}`),
          h('div', { class: 'spacer' }),
          h('button', { class: 'icon-btn sm', 'aria-label': t('Kopieren'), title: t('Kopieren'), onclick: () => copyQuote(q) }, icon('copy')),
          h('button', { class: 'icon-btn sm', 'aria-label': t('Als Bild'), title: t('Als Bild'), onclick: () => openImage(q) }, icon('image')))));
    } catch { /* optional */ }
  }

  const skeletons = () => Array.from({ length: 3 }, () => h('div', { class: 'card skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));

  let token = 0, page = 1, hasMore = false, loading = false;
  async function load(reset) {
    const my = ++token;
    syncChrome();
    if (reset) {
      page = 1; list.replaceChildren(...skeletons()); more.hidden = true;
      drawFilters(); drawDaily();
    }
    loading = true;
    if (state.scope === 'collections') {
      const view = await collectionsView((c) => setScope('collection', { collection: c }));
      if (my === token) { list.replaceChildren(view); hasMore = false; loading = false; }
      return;
    }
    if (state.scope === 'collection') {
      try {
        const res = await api('GET', `/api/collections/${state.collection.id}?page=${page}`);
        if (my !== token) return;
        state.collection = res.collection; syncChrome();
        if (reset) list.replaceChildren();
        for (const q of res.quotes) if (!pendingDeletes.has(q.id)) list.append(quoteCard(q, () => load(true)));
        hasMore = res.hasMore;
        if (!list.querySelector('.quote')) list.append(h('div', { class: 'empty' }, h('b', {}, t('Noch leer')),
          h('p', {}, res.collection.isOwner ? t('Füge Zitate über das ⋯-Menü einer Karte hinzu („Zu Sammlung …“).') : t('In dieser Sammlung ist noch nichts, das du sehen kannst.'))));
      } catch (ex) { if (my === token) { toast(ex.message); setScope('collections'); } } finally { if (my === token) loading = false; }
      return;
    }
    try {
      const qs = new URLSearchParams({ scope: state.scope, page, sort: state.sort,
        ...(state.q ? { q: state.q } : {}), ...(state.group ? { group: state.group.id } : {}),
        ...(state.tag ? { tag: state.tag } : {}), ...(state.person ? { person: state.person } : {}),
        ...(state.from ? { from: state.from } : {}), ...(state.to ? { to: state.to } : {}), ...(state.vis ? { vis: state.vis } : {}),
        ...(state.profile ? { user: state.profile } : {}) });
      const res = await api('GET', `/api/quotes?${qs}`);
      if (my !== token) return;
      if (reset) list.replaceChildren();
      for (const q of res.quotes) if (!pendingDeletes.has(q.id)) list.append(quoteCard(q, () => load(true)));
      hasMore = res.hasMore;
      more.hidden = !hasMore || 'IntersectionObserver' in window;
      if (!list.children.length) list.append(emptyState(res.suggestion, (s) => { state.q = s; search.value = s; load(true); }));
    } catch (ex) {
      if (my !== token) return;
      if (reset) list.replaceChildren();
      toast(ex.message);
      if (state.scope === 'group') setScope('feed');
    } finally { if (my === token) loading = false; }
  }
  function loadMore() { if (!hasMore || loading) return; page++; load(false); }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '600px' }).observe(sentinel);
  }

  function filterBy({ tag = null, person = null }) {
    Object.assign(state, { tag, person, q: '' });
    if (state.scope === 'group') { /* Filter gelten auch in der Gruppenansicht */ }
    search.value = '';
    document.querySelector('dialog[open]')?.close();
    load(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  state.reload = () => load(true);
  state.showProfile = (username) => setScope('user', { profile: username });
  state.filterBy = filterBy;
  state.focusSearch = () => { search.focus(); search.select(); };
  state.showGroup = (g) => { Object.assign(state, { scope: 'group', group: { id: g.id, name: g.name }, q: '', tag: null, person: null }); search.value = ''; load(true); window.scrollTo(0, 0); };
  state.updateBell = (n) => {
    state.unread = n;
    bellCount.hidden = !n;
    bellCount.textContent = n > 99 ? '99+' : String(n);
    bell.setAttribute('aria-label', n ? t('Benachrichtigungen ({0} neu)', n) : t('Benachrichtigungen'));
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
  if (count('mention')) parts.push(t('Du wurdest in {0} markiert', plural(count('mention'), t('Zitat'), t('Zitaten'))));
  if (count('share')) parts.push(t('{0} mit dir geteilt', plural(count('share'), t('Zitat wurde'), t('Zitate wurden'))));
  if (count('group_add')) parts.push(t('Du wurdest zu {0} hinzugefügt', plural(count('group_add'), t('Gruppe'), t('Gruppen'))));
  if (!parts.length) return;
  banner.replaceChildren(
    icon('bell'),
    h('div', { class: 'banner-text' }, h('b', {}, t('Neu für dich')), h('span', {}, parts.join(' · '))),
    h('button', { class: 'btn sm primary', onclick: () => { banner.hidden = true; openNotifications(); } }, t('Ansehen')),
    h('button', { class: 'btn sm ghost', 'aria-label': t('Hinweis schließen'), onclick: () => { banner.hidden = true; } }, '✕'));
  banner.hidden = false;
}

function emptyState(suggestion, onSuggest) {
  if (suggestion) {
    return h('div', { class: 'empty' }, h('b', {}, t('Keine Treffer')),
      h('p', {}, t('Meintest du '), h('button', { class: 'link-btn', onclick: () => onSuggest(suggestion) }, `„${suggestion}“`), '?'));
  }
  if (state.scope === 'following') {
    return h('div', { class: 'empty' }, h('b', {}, t('Noch niemandem gefolgt')),
      h('p', {}, t('Tippe bei einem Zitat auf den Namen, um das Profil zu öffnen, und folge Leuten, deren Zitate dir gefallen.')));
  }
  if (state.scope === 'user') return h('div', { class: 'empty' }, h('b', {}, t('Keine sichtbaren Zitate')));
  const filtered = state.q || state.tag || state.person || state.from || state.to || state.vis;
  const reset = filtered ? h('button', { class: 'btn', onclick: () => state.filterBy?.({}) }, t('Filter zurücksetzen')) : null;
  if (filtered) return h('div', { class: 'empty' }, h('b', {}, t('Keine Treffer')), h('p', {}, t('Versuche einen anderen Suchbegriff oder Filter.')), reset);
  if (state.scope === 'group') {
    return h('div', { class: 'empty' }, h('b', {}, t('Noch keine Zitate in dieser Gruppe')), h('p', {}, t('Teile ein Zitat und wähle unter „Geteilt“ diese Gruppe aus.')));
  }
  const msgs = {
    feed: [t('Noch nichts los hier'), t('Sobald jemand ein Zitat öffentlich teilt, erscheint es hier.')],
    mine: [t('Deine Sammlung ist leer'), t('Halte fest, was dich bewegt – dein erstes Zitat ist nur einen Tipp entfernt.')],
    shared: [t('Noch nichts für dich'), t('Hier landen Zitate, in denen du markiert bist oder die mit dir bzw. deinen Gruppen geteilt wurden.')],
    liked: [t('Keine Favoriten'), t('Tippe bei einem Zitat auf ♡, um es hier wiederzufinden.')],
  }[state.scope];
  return h('div', { class: 'empty' }, h('b', {}, msgs[0]), h('p', {}, msgs[1]),
    state.scope === 'mine' ? h('button', { class: 'btn primary', onclick: () => openEditor() }, t('+ Erstes Zitat hinzufügen')) : null);
}

async function copyQuote(q) {
  try { await navigator.clipboard.writeText(quoteAsText(q)); toast(t('Zitat kopiert')); } catch { toast(t('Kopieren nicht möglich')); }
}

function deleteWithUndo(q, card) {
  card.hidden = true;
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true; clearTimeout(timer); pendingDeletes.delete(q.id);
    try {
      await api('DELETE', `/api/quotes/${q.id}`);
      const list = card.parentElement;
      card.remove();
      if (list && !list.querySelector('.quote')) list.append(emptyState());
    } catch (ex) { card.hidden = false; toast(ex.message); }
  };
  const timer = setTimeout(commit, 5000);
  pendingDeletes.set(q.id, commit);
  toast(t('Zitat gelöscht'), { action: t('Rückgängig'), ms: 5000, onAction: () => {
    if (done) return;
    done = true; clearTimeout(timer); pendingDeletes.delete(q.id); card.hidden = false;
  } });
}
// Seite wird verlassen: ausstehende Löschungen noch abschicken
window.addEventListener('pagehide', () => {
  for (const id of pendingDeletes.keys()) {
    fetch(`/api/quotes/${id}`, { method: 'DELETE', keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf ?? '' }, body: '{}' });
  }
});

function quoteCard(q, reload, { compact = false } = {}) {
  const heart = () => icon('heart', { filled: q.liked });
  const likeCount = h('span', {}, String(q.likes));
  const likeBtn = h('button', {
    class: 'act like', 'aria-pressed': String(q.liked), 'aria-label': t('Favorit ({0})', q.likes), title: t('Favorit'),
    onclick: async () => {
      try {
        const r = await api('POST', `/api/quotes/${q.id}/like`);
        q.liked = r.liked; q.likes = r.likes;
        likeBtn.setAttribute('aria-pressed', String(r.liked));
        likeBtn.setAttribute('aria-label', t('Favorit ({0})', r.likes));
        likeBtn.firstChild.replaceWith(heart());
        likeCount.textContent = String(r.likes);
        if (r.liked) { likeBtn.classList.remove('pop'); void likeBtn.offsetWidth; likeBtn.classList.add('pop'); }
      } catch (ex) { toast(ex.message); }
    },
  }, heart(), likeCount);

  const sharedCount = q.mine && q.visibility === 'shared' ? q.shareWith.length + q.shareGroups.length : 0;
  const commentCount = h('span', {}, String(q.comments ?? 0));
  const commentBtn = h('button', { class: 'act', 'aria-label': t('Kommentare ({0})', q.comments ?? 0), title: t('Kommentare'),
    onclick: () => openComments(q, { onCount: (n) => { q.comments = n; commentCount.textContent = String(n); commentBtn.setAttribute('aria-label', t('Kommentare ({0})', n)); } }) },
  icon('message'), commentCount);
  let card;
  const inOwnCollection = state.scope === 'collection' && state.collection?.isOwner;
  const moreBtn = !compact ? h('button', { class: 'act', 'aria-label': t('Weitere Aktionen'), 'aria-haspopup': 'menu', title: t('Mehr'),
    onclick: (e) => popMenu(e.currentTarget, [
      ['folder', t('Zu Sammlung …'), () => openAddToCollection(q)],
      ...(inOwnCollection ? [['minus', t('Aus dieser Sammlung entfernen'), async () => {
        try { await api('DELETE', `/api/collections/${state.collection.id}/quotes/${q.id}`); card.remove(); toast(t('Aus der Sammlung entfernt')); } catch (ex) { toast(ex.message); }
      }]] : []),
      ...(!q.mine ? [
        ['edit', t('Korrektur vorschlagen …'), () => openSuggest(q)],
        ['flag', t('Melden …'), () => openReport({ quoteId: q.id }, t('Zitat')), 'danger'],
      ] : []),
      ...(q.mine ? [
        ['edit', t('Bearbeiten'), () => openEditor(q)],
        ['link', q.link ? t('Link verwalten') : t('Per Link teilen'), () => openLink(q, reload)],
        ['trash', t('Löschen'), () => deleteWithUndo(q, card), 'danger'],
      ] : []),
    ]) }, icon('more')) : null;

  card = h('article', { class: 'card quote' },
    h('header', { class: 'qhead' }, avatar(q.mine ? state.user.username : q.author),
      h('span', { class: 'qwho' }, h('button', { class: 'author-link', title: t('Profil von @{0}', q.author), onclick: () => { document.querySelector('dialog[open]')?.close(); state.showProfile?.(q.author); } },
        q.mine ? t('Du') : `@${q.author}`), h('span', {}, relTime(q.createdAt))),
      q.mine ? h('span', { class: `badge ${q.visibility}`, title: q.visibility === 'shared' ? t('Geteilt mit {0}', plural(sharedCount, t('Empfänger'), t('Empfängern'))) : null },
        VIS[q.visibility] + (sharedCount ? ` · ${sharedCount}` : '')) : null,
      q.mine && q.link ? h('span', { class: 'badge', title: t('Per Link geteilt') }, icon('link', { size: 12 })) : null),
    quoteText(q),
    h('div', { class: 'qsrc' },
      h('button', { class: 'person-link', title: t('Alle Zitate von {0}', q.person), onclick: () => state.filterBy?.({ person: q.person }) }, `— ${q.person}`),
      q.source ? h('span', { class: 'source' }, `, ${q.source}`) : null),
    q.tags?.length ? h('div', { class: 'tags' }, q.tags.map((t) => h('button', { class: 'tag', onclick: () => state.filterBy?.({ tag: t }) }, `#${t}`))) : null,
    q.mentions.length ? h('div', { class: 'mentions' }, h('span', {}, t('Markiert')),
      q.mentions.map((m) => h('span', { class: `mention${m === state.user?.username ? ' me' : ''}` }, `@${m}`))) : null,
    compact ? null : h('footer', { class: 'qactions' }, likeBtn,
      commentBtn,
      h('button', { class: 'act', 'aria-label': t('Kopieren'), title: t('Kopieren'), onclick: () => copyQuote(q) }, icon('copy')),
      h('button', { class: 'act', 'aria-label': t('Als Bild teilen'), title: t('Als Bild'), onclick: () => openImage(q) }, icon('image')),
      h('div', { class: 'spacer' }), moreBtn));
  return card;
}

// ---------- Zitat als Bild ----------
function renderQuoteImage(q, dark) {
  const W = 1080, H = 1350, PAD = 110;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const bg = dark ? '#0a0a0a' : '#ffffff', fg = dark ? '#f5f5f5' : '#0a0a0a', mute = dark ? '#8a8a8a' : '#6f6f6f';
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.strokeStyle = fg; x.lineWidth = 3; x.strokeRect(48, 48, W - 96, H - 96);
  const serif = t('"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif');
  const sans = t('ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif');
  const wrap = (text, size) => {
    x.font = `${size}px ${serif}`;
    const lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const test = line ? `${line} ${word}` : word;
        if (x.measureText(test).width > W - PAD * 2 && line) { lines.push(line); line = word; } else line = test;
      }
      lines.push(line);
    }
    return lines;
  };
  let size = 76, lines;
  do { lines = wrap(q.text, size); size -= 2; } while (lines.length * size * 1.35 > H - 520 && size > 28);
  size += 2;
  const lh = size * 1.35, blockH = lines.length * lh;
  let y = Math.max(300, (H - blockH) / 2 - 40);
  x.fillStyle = fg; x.font = `220px ${serif}`; x.textBaseline = 'alphabetic';
  x.fillText('“', PAD - 12, y - 20);
  x.font = `${size}px ${serif}`; x.textBaseline = 'top';
  for (const l of lines) { x.fillText(l, PAD, y); y += lh; }
  y += 40;
  x.font = `700 34px ${sans}`;
  x.letterSpacing = '4px';
  x.fillText(`— ${q.person.toUpperCase()}`.slice(0, 48), PAD, y);
  x.letterSpacing = '0px';
  if (q.source) { x.fillStyle = mute; x.font = `30px ${sans}`; x.fillText(q.source.slice(0, 60), PAD, y + 52); }
  x.fillStyle = mute; x.font = `600 26px ${sans}`; x.textBaseline = 'alphabetic';
  x.fillText(t('“ Quotes'), PAD, H - 90);
  return c;
}

function openImage(q) {
  let dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  let canvas;
  const img = h('img', { class: 'qimg', alt: t('Bild des Zitats: {0}', quoteAsText(q)) });
  const fileName = () => `zitat-${q.person.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'quotes'}.png`;
  const draw = () => { canvas = renderQuoteImage(q, dark); img.src = canvas.toDataURL('image/png'); toggle.textContent = dark ? t('Hell') : t('Dunkel'); };
  const toggle = h('button', { class: 'btn', type: 'button', onclick: () => { dark = !dark; draw(); } });
  const download = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    const a = h('a', { href: canvas.toDataURL('image/png'), download: fileName() }); document.body.append(a); a.click(); a.remove();
  } }, icon('download'), h('span', {}, t('Herunterladen')));
  const share = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => canvas.toBlob(async (blob) => {
    try { await navigator.share({ files: [new File([blob], fileName(), { type: 'image/png' })], text: quoteAsText(q) }); } catch { /* abgebrochen */ }
  }) }, t('Teilen …'));
  try { share.hidden = !navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] }); } catch { share.hidden = true; }
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, t('Als Bild')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg.close() }, '✕')),
    h('p', { class: 'hint' }, t('Perfekt für Instagram, WhatsApp-Status oder zum Ausdrucken (1080 × 1350).')),
    img, h('div', { class: 'img-actions' }, download, share, toggle));
  dlg.classList.add('image-dialog');
  draw();
}

// ---------- Editor ----------
async function openEditor(q) {
  const err = h('p', { class: 'error', role: 'alert' });
  const text = h('textarea', { id: 'f-text', required: true, maxlength: 1000, placeholder: t('Was wurde gesagt?'), rows: 4 }); text.value = q?.text ?? '';
  const counter = h('span', { class: 'counter' });
  const updateCounter = () => { counter.textContent = `${text.value.length}/1000`; counter.classList.toggle('warn', text.value.length > 900); };
  text.addEventListener('input', updateCounter); updateCounter();
  const person = h('input', { id: 'f-person', type: 'text', required: true, maxlength: 100, placeholder: t('z. B. Marie Curie'), autocomplete: 'off' }); person.value = q?.person ?? '';
  const source = h('input', { id: 'f-source', type: 'text', maxlength: 150, placeholder: t('Buch, Rede, Interview … (optional)') }); source.value = q?.source ?? '';
  // Originalsprache + Übersetzung (aufklappbar, offen wenn schon gesetzt)
  const langSel = h('select', { id: 'f-lang' }, h('option', { value: '' }, t('Sprache wählen …')),
    QUOTE_LANGS.map((c) => [c, langName(c)]).sort((a, b) => a[1].localeCompare(b[1], LOCALE))
      .map(([c, name]) => h('option', { value: c, selected: c === q?.lang }, name)));
  const translation = h('textarea', { id: 'f-translation', maxlength: 1000, rows: 3, placeholder: t('Übersetzung (optional)') }); translation.value = q?.translation ?? '';
  const langBox = h('details', { class: 'lang-box', open: !!(q?.lang || q?.translation) },
    h('summary', {}, t('Originalsprache & Übersetzung')),
    h('label', { for: 'f-lang' }, t('Originalsprache (optional)')), langSel,
    h('label', { for: 'f-translation' }, t('Übersetzung')), translation,
    h('div', { class: 'hint' }, t('Wird unter dem Original angezeigt und bei der Suche mit durchsucht.')));
  let tagCache = null;
  const tags = chipInput({ id: 'f-tags', initial: q?.tags ?? [], prefix: '#', placeholder: '#tag', suggest: async (s) => {
    tagCache ??= (await api('GET', '/api/tags').catch(() => ({ tags: [] }))).tags.map((t) => t.tag);
    return tagCache.filter((t) => t.startsWith(s.toLowerCase())).slice(0, 8);
  } });
  const mentions = chipInput({ id: 'f-mentions', initial: q?.mentions ?? [], placeholder: t('@benutzername') });
  const shareUsers = chipInput({ id: 'f-share', initial: q?.shareWith ?? [], placeholder: t('@benutzername') });
  const groupBox = h('div', { class: 'check-group' }, h('span', { class: 'hint' }, t('Gruppen werden geladen …')));
  const shareBox = h('div', { class: 'share-box' },
    h('label', { for: 'f-share' }, t('Teilen mit Personen')), shareUsers.el,
    h('label', {}, t('Teilen mit Gruppen')), groupBox);
  const current = q?.visibility ?? 'private';
  const opts = [['private', t('Privat'), t('Nur du (und Markierte)')], ['shared', t('Geteilt'), t('Personen & Gruppen')], ['public', t('Öffentlich'), t('Alle Nutzer')]];
  const radios = opts.map(([v, label, d]) => h('label', {}, h('input', { type: 'radio', name: 'vis', value: v, checked: v === current }), h('span', {}, label, h('small', {}, d))));
  const save = h('button', { class: 'btn primary', type: 'submit', title: t('Speichern (Strg/⌘ + Enter)') }, t('Speichern'));
  let dlg;
  const sync = () => { shareBox.hidden = dlg.querySelector('input[name=vis]:checked').value !== 'shared'; };
  const form = h('form', {
    onchange: sync,
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } },
    onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true; err.textContent = '';
      const visibility = dlg.querySelector('input[name=vis]:checked').value;
      const body = { text: text.value, person: person.value, source: source.value, lang: langSel.value, translation: translation.value, visibility, tags: tags.values(), mentions: mentions.values(),
        shareWith: shareUsers.values(), shareGroups: [...groupBox.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
      try {
        await (q ? api('PUT', `/api/quotes/${q.id}`, body) : api('POST', '/api/quotes', body));
        dlg.close(); toast(q ? t('Gespeichert') : t('Zitat hinzugefügt')); state.reload?.();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    },
  },
  h('div', { class: 'dialog-head' }, h('h2', {}, q ? t('Zitat bearbeiten') : t('Neues Zitat')),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg.close() }, '✕')),
  h('div', { class: 'label-row' }, h('label', { for: 'f-text' }, t('Zitat')), counter), text,
  duplicateHint(text, q?.id, { onOpen: (d) => { dlg.close(); openQuote(d); } }), attachPersonSuggest(person),
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'f-person' }, t('Person')), person),
    h('div', {}, h('label', { for: 'f-source' }, t('Quelle')), source)),
  langBox,
  h('label', { for: 'f-tags' }, t('Tags')), tags.el,
  h('label', { for: 'f-mentions' }, t('Personen markieren')), mentions.el,
  h('div', { class: 'hint' }, t('Markierte Nutzer sehen das Zitat immer und werden benachrichtigt.')),
  h('label', {}, t('Sichtbarkeit')), h('div', { class: 'radio-group vis-group' }, radios), shareBox, err,
  h('div', { class: 'row sticky-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Abbrechen')), save));
  dlg = modal(form);
  dlg.classList.add('editor');
  sync();
  text.focus();

  try {
    const { groups } = await api('GET', '/api/groups');
    const selected = new Set((q?.shareGroups ?? []).map((g) => g.id));
    groupBox.replaceChildren(...(groups.length
      ? groups.map((g) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: g.id, checked: selected.has(g.id) }),
        h('span', {}, g.name, h('small', {}, plural(g.memberCount, t('Mitglied'), t('Mitglieder'))))))
      : [h('span', { class: 'hint' }, t('Du bist noch in keiner Gruppe. Gruppen legst du oben über das Personen-Symbol an.'))]));
  } catch { groupBox.replaceChildren(h('span', { class: 'hint' }, t('Gruppen konnten nicht geladen werden.'))); }
}

// ---------- Freigabe-Link ----------
function openLink(q, reload) {
  const body = h('div');
  const dlg = modal(h('h2', {}, t('Per Link teilen')),
    h('p', { class: 'hint' }, t('Jeder mit diesem Link kann das Zitat lesen – auch ohne Konto. Markierungen und Empfänger bleiben verborgen.')),
    body, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Fertig'))));
  const draw = () => {
    if (!q.link) {
      body.replaceChildren(h('button', { class: 'btn primary block', onclick: async () => {
        try { q.link = (await api('POST', `/api/quotes/${q.id}/link`)).link; draw(); reload(); } catch (ex) { toast(ex.message); }
      } }, h('span', {}, icon('link')), t('Link erstellen')));
      return;
    }
    const url = new URL(q.link, location.origin).toString();
    const field = h('input', { type: 'text', readonly: true, value: url, 'aria-label': t('Freigabe-Link'), onfocus: (e) => e.target.select() });
    body.replaceChildren(h('div', { class: 'linkbox' }, field,
      h('button', { class: 'btn primary', onclick: async () => {
        try { await navigator.clipboard.writeText(url); toast(t('Link kopiert')); } catch { field.select(); toast(t('Bitte manuell kopieren')); }
      } }, t('Kopieren'))),
      h('div', { class: 'row left' },
        navigator.share ? h('button', { class: 'btn', onclick: () => navigator.share({ title: t('Zitat'), text: `„${q.text}“ — ${q.person}`, url }).catch(() => {}) }, t('Teilen …')) : null,
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(t('Link deaktivieren? Wer ihn hat, kann das Zitat dann nicht mehr öffnen.'))) return;
          try { await api('DELETE', `/api/quotes/${q.id}/link`); q.link = null; draw(); reload(); toast(t('Link deaktiviert')); } catch (ex) { toast(ex.message); }
        } }, t('Link deaktivieren'))));
  };
  draw();
}

// ---------- Benachrichtigungen ----------
async function openNotifications() {
  const list = h('div', { class: 'notif-list' }, h('p', { class: 'hint' }, t('Wird geladen …')));
  const dlg = modal(h('h2', {}, t('Benachrichtigungen')), list,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Schließen'))));
  state.hideBanner?.();
  try {
    const { items, unread } = await api('GET', '/api/notifications');
    if (unread) { api('POST', '/api/notifications/read').catch(() => {}); state.updateBell?.(0); }
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'empty small' }, h('b', {}, t('Alles ruhig')), t('Wenn dich jemand markiert, etwas mit dir teilt oder dich zu einer Gruppe hinzufügt, siehst du es hier.')));
      return;
    }
    list.replaceChildren(...items.map((n) => {
      const what = {
        mention: [h('b', {}, `@${n.actor}`), t(' hat dich in einem Zitat markiert')],
        share: [h('b', {}, `@${n.actor}`), t(' hat ein Zitat mit dir geteilt')],
        group_add: [h('b', {}, `@${n.actor}`), t(' hat dich zur Gruppe '), h('b', {}, `„${n.groupName}“`), t(' hinzugefügt')],
        comment: [h('b', {}, `@${n.actor}`), t(' hat dein Zitat kommentiert')],
        comment_mention: [h('b', {}, `@${n.actor}`), t(' hat dich in einem Kommentar erwähnt')],
        follow: [h('b', {}, `@${n.actor}`), t(' folgt dir jetzt')],
        group_owner: [h('b', {}, `@${n.actor}`), t(' hat dir die Gruppe '), h('b', {}, `„${n.groupName}“`), t(' übertragen')],
        group_join: [h('b', {}, `@${n.actor}`), t(' ist über deine Einladung '), h('b', {}, `„${n.groupName}“`), t(' beigetreten')],
        suggestion: [h('b', {}, `@${n.actor}`), t(' schlägt eine Korrektur zu deinem Zitat vor')],
        suggestion_accepted: [h('b', {}, `@${n.actor}`), t(' hat deine Korrektur übernommen 🎉')],
        suggestion_rejected: [h('b', {}, `@${n.actor}`), t(' hat deine Korrektur nicht übernommen')],
      }[n.type] ?? [h('b', {}, `@${n.actor}`), t(' hat etwas mit dir geteilt')];
      const open = async () => {
        dlg.close();
        if (n.groupId) return openGroup(n.groupId);
        if (n.type === 'follow') return state.showProfile?.(n.actor);
        if (n.type === 'suggestion') return openSuggestions({ onChange: () => state.reload?.() });
        try {
          const q = await api('GET', `/api/quotes/${n.quoteId}`);
          if (n.type === 'comment' || n.type === 'comment_mention') openComments(q); else openQuote(q);
        } catch (ex) { toast(ex.message); }
      };
      return h('button', { class: `notif${n.read ? '' : ' unread'}`, onclick: open },
        h('div', {}, ...what),
        n.commentText ? h('div', { class: 'notif-comment' }, `„${n.commentText}${n.commentText.length >= 140 ? '…' : ''}“`) : null,
        n.quoteText && !n.commentText ? h('div', { class: 'notif-quote' }, `„${n.quoteText}${n.quoteText.length >= 140 ? '…' : ''}“ — ${n.quotePerson}`) : null,
        h('div', { class: 'notif-time' }, relTime(n.createdAt)));
    }));
  } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
}

function openQuote(q) {
  const dlg = modal(quoteCard(q, () => { dlg.close(); state.reload?.(); }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Schließen'))));
  dlg.classList.add('quote-dialog');
}

// ---------- Konto ----------
function usernameForm({ onDone, submitLabel = t('Speichern') }) {
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
  }, h('label', { for: 'acc-username' }, t('Benutzername')), h('div', { class: 'linkbox' }, input, btn),
  h('div', { class: 'hint' }, t('3–30 Zeichen: Buchstaben, Zahlen, _ . -  ·  Unter diesem Namen können andere dich finden und markieren.')), err);
  return { form, input };
}

/** Beim ersten SSO-Login: eigenen Benutzernamen wählen statt den SSO-Namen zu übernehmen. */
function chooseUsername() {
  const { form, input } = usernameForm({
    submitLabel: t('Weiter'),
    onDone: () => { dlg.close(); toast(t('Willkommen!')); renderMain(); },
  });
  const dlg = modal(h('h2', {}, t('Willkommen bei Quotes')),
    h('p', { class: 'hint' }, t('Wähle, unter welchem Namen du hier sichtbar sein möchtest. Der Vorschlag stammt aus deinem SSO-Konto – du kannst ihn übernehmen oder ändern, und später jederzeit im Konto anpassen.')),
    form);
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // nicht wegklickbar
  input.select();
}

function openAccount() {
  const sso = !!state.user.sso;
  const { form: nameForm } = usernameForm({ onDone: (u) => { toast(t('Du heißt jetzt @{0}', u)); dlg.close(); renderMain(); } });
  const err = h('p', { class: 'error', role: 'alert' });
  const pass = h('input', { type: sso ? 'text' : 'password', id: 'acc-del', autocomplete: sso ? 'off' : 'current-password', required: true, maxlength: 200, autocapitalize: 'none', spellcheck: 'false' });
  const delForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!confirm(t('Konto und alle Zitate endgültig löschen?'))) return;
      try { await api('DELETE', '/api/me', sso ? { confirm: pass.value } : { password: pass.value }); dlg.close(); clearOfflineData(); setUser(null); render(); toast(t('Konto gelöscht')); }
      catch (ex) { err.textContent = ex.message; }
    },
  },
  h('label', { for: 'acc-del' }, sso ? t('Konto löschen – Benutzernamen eintippen') : t('Konto löschen – Passwort bestätigen')), pass,
  sso ? h('div', { class: 'hint' }, t('Dein Konto wird über SSO verwaltet und hat kein Passwort.')) : null, err,
  h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, t('Konto endgültig löschen'))));
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, t('Konto')), h('button', { class: 'btn sm', onclick: () => { dlg.close(); logout(); } }, t('Abmelden'))),
    h('div', { class: 'acc-id' }, avatar(state.user.username), h('div', {}, h('b', {}, `@${state.user.username}`),
      h('span', { class: 'hint' }, state.user.sso ? t('Konto über SSO') : state.user.ssoLinked ? t('Passwort + SSO') : t('Passwort-Konto')))),
    h('div', { class: 'row left acc-links' },
      h('button', { class: 'btn', onclick: () => { dlg.close(); openStats(); } }, icon('chart', { size: 18 }), h('span', {}, t('Statistik'))),
      h('button', { class: 'btn', onclick: () => { dlg.close(); state.showProfile?.(state.user.username); } }, icon('user', { size: 18 }), h('span', {}, t('Mein Profil'))),
      h('button', { class: 'btn', onclick: () => { dlg.close(); openSuggestions({ onChange: () => state.reload?.() }); } }, icon('edit', { size: 18 }), h('span', {}, t('Vorschläge'))),
      h('button', { class: 'btn', onclick: () => { dlg.close(); openSecurity(); } }, icon('shield', { size: 18 }), h('span', {}, t('Sicherheit'))),
      h('button', { class: 'btn', onclick: () => { dlg.close(); openIntegrations(); } }, icon('plug', { size: 18 }), h('span', {}, t('Integrationen'))),
      state.user.isAdmin ? h('button', { class: 'btn primary', onclick: () => { dlg.close(); openAdmin(); } }, icon('sliders', { size: 18 }), h('span', {}, t('Admin-Bereich'))) : null),
    nameForm,
    themeSection(),
    h('section', { class: 'acc-section' }, h('label', {}, t('Zitate exportieren')),
      h('p', { class: 'hint' }, t('Alle deine Zitate inklusive Tags und Freigaben – als Sicherung oder für Excel.')),
      h('div', { class: 'row left' },
        h('a', { class: 'btn', href: '/api/export?format=csv', download: true }, icon('download'), h('span', {}, t('CSV (Excel)'))),
        h('a', { class: 'btn', href: '/api/export?format=json', download: true }, icon('download'), h('span', {}, 'JSON')))),
    importSection(() => state.reload?.()),
    deviceSection(),
    emailSection(),
    ssoSection(() => dlg),
    h('p', { class: 'hint shortcuts' }, t('Tastenkürzel: N – neues Zitat · / – Suche · Strg/⌘ + Enter – speichern')),
    h('details', { class: 'danger-zone' }, h('summary', {}, t('Konto löschen')), delForm),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Schließen'))));
}

function themeSection() {
  const current = getTheme();
  const seg = h('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': t('Farbschema') },
    [['system', t('System')], ['light', t('Hell')], ['dark', t('Dunkel')]].map(([v, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === current), 'aria-pressed': String(v === current),
      onclick: (e) => {
        setTheme(v);
        for (const b of seg.children) { const on = b === e.currentTarget; b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-pressed', String(on)); }
      },
    }, label)));
  const langSeg = h('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': t('Sprache') },
    Object.entries(LANGS).map(([code, name]) => h('button', {
      type: 'button', role: 'radio', lang: code, 'aria-checked': String(code === LANG), 'aria-pressed': String(code === LANG),
      onclick: async () => {
        if (code === LANG) return;
        await api('PUT', '/api/me/lang', { lang: code }).catch(() => {});
        setLang(code);
      },
    }, name)));
  return h('section', { class: 'acc-section' }, h('label', {}, t('Darstellung')), seg, h('label', { class: 'sub-label' }, t('Sprache')), langSeg);
}

/** Bereich „Anmeldung mit SSO“: bestehendes Konto verknüpfen bzw. Verknüpfung lösen. */
function ssoSection(getDlg) {
  const { sso } = state.config;
  if (!sso) return null;
  const box = h('section', { class: 'sso-box' });
  const err = h('p', { class: 'error', role: 'alert' });
  const pass = h('input', { type: 'password', id: 'acc-sso-pw', autocomplete: 'current-password', required: true, maxlength: 200 });
  const title = h('label', { for: state.user.sso ? null : 'acc-sso-pw' }, t('Anmeldung mit {0}', sso.name));

  if (state.user.ssoLinked) {
    const status = h('p', { class: 'sso-status' }, h('span', { class: 'badge public' }, t('Verknüpft')), ' ',
      h('span', {}, t('Du kannst dich mit {0} anmelden.', sso.name)));
    if (state.user.sso) { // reines SSO-Konto ohne Passwort: Lösen würde aussperren
      box.append(title, status);
      return box;
    }
    const btn = h('button', { class: 'btn danger', type: 'submit' }, t('Verknüpfung lösen'));
    box.append(title, status, h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        if (!confirm(t('Verknüpfung mit {0} lösen? Du meldest dich dann nur noch mit Passwort an.', sso.name))) return;
        btn.disabled = true;
        try {
          await api('DELETE', '/api/me/sso', { password: pass.value });
          state.user = { ...state.user, ssoLinked: false };
          getDlg().close(); toast(t('Verknüpfung gelöst')); openAccount();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      },
    }, h('div', { class: 'hint' }, t('Zum Lösen dein Passwort bestätigen:')), h('div', { class: 'linkbox' }, pass, btn), err));
    return box;
  }

  const btn = h('button', { class: 'btn primary', type: 'submit' }, t('Verknüpfen'));
  box.append(title, h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        const { url } = await api('POST', '/api/me/sso', { password: pass.value });
        location.assign(url); // weiter zum SSO-Anbieter, danach zurück mit ?sso_linked=1
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  }, h('div', { class: 'hint' }, t('Verknüpfe dein bestehendes Konto mit {0}, um dich künftig auch darüber anzumelden. Deine Zitate, Gruppen und dein Name bleiben erhalten. Bitte dein Passwort bestätigen:', sso.name)),
  h('div', { class: 'linkbox' }, pass, btn), err));
  return box;
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* egal */ }
  clearOfflineData();
  setUser(null); render();
}

// Tastenkürzel: N = neues Zitat, / = Suche
document.addEventListener('keydown', (e) => {
  if (!state.user || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openEditor(); }
  else if (e.key === '/') { e.preventDefault(); state.focusSearch?.(); }
});

function render(opts) {
  const inv = location.pathname.match(/^\/g\/([A-Za-z0-9_-]+)$/);
  if (inv) {
    if (!state.user) return renderAuth('login', t('Melde dich an (oder registriere dich), um der Gruppe beizutreten.'));
    return renderInvite(inv[1], { onDone: (g) => { renderMain(); setTimeout(() => state.showGroup?.(g), 50); } });
  }
  const c = location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)$/);
  if (c) return renderPublicCollection(c[1]);
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
  if (m) return renderPublic(m[1]);
  return state.user ? renderMain(opts) : renderAuth();
}

state.onUnauthorized = () => render();

initPwa();
document.title = t('Quotes – Zitate sammeln & teilen');

(async () => {
  if (/^\/[sc]\//.test(location.pathname)) return render();
  try { state.config = await api('GET', '/api/config'); } catch { /* Standard */ }
  const params = new URLSearchParams(location.search);
  if (params.has('sso_linked')) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(t('Konto mit {0} verknüpft', state.config.sso?.name ?? 'SSO')), 100);
  }
  if (params.has('sso_error')) {
    const code = params.get('sso_error');
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(SSO_ERRORS[code] || t('SSO-Anmeldung fehlgeschlagen.')), 100);
  }
  try {
    const r = await api('GET', '/api/me');
    setUser(r.user, r.csrf ?? null);
  } catch { /* nicht angemeldet */ }
  const actions = takeUrlActions();
  render({ justLoggedIn: true });
  if (actions.toast) setTimeout(() => toast(actions.toast), 100);
  if (state.user && actions.notifications) setTimeout(() => openNotifications(), 150);
  if (state.user && actions.newQuote) setTimeout(() => openEditor(), 150);
})();
