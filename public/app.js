// Bewusst ohne innerHTML: alle Nutzerinhalte werden per textContent gesetzt (XSS-sicher).
import {
  $app, $toast, state, h, ICONS, icon, toast, applyTheme, getTheme, setTheme, checkVersion, api, plural, fmtDate, relTime, modal, chipInput, setUser, VIS, quoteAsText, avatar, popMenu,
} from './core.js';
import { collectionsView, openCollectionEditor, openAddToCollection, openCollectionLink, renderPublicCollection } from './collections.js';
import { personHeader, openRandom, duplicateHint, attachPersonSuggest, importSection } from './people.js';
import { openComments, profileHeader, openStats, openFilters } from './social.js';
import { openGroups, openGroup, renderInvite } from './groups.js';
import { openSuggest, openSuggestions, openReport, openAdmin } from './moderation.js';
import { initPwa, clearOfflineData, takeUrlActions, deviceSection, emailSection } from './pwa.js';
import { passkeyLoginButton, twoFactorForm, openSecurity, openIntegrations } from './security.js';

const SSO_ERRORS = {
  access_denied: 'Anmeldung wurde abgebrochen oder abgelehnt.',
  signup_disabled: 'Für dieses SSO-Konto ist keine Registrierung erlaubt. Bitte einen Administrator kontaktieren.',
  invalid_state: 'Die Anmeldung ist abgelaufen. Bitte erneut versuchen.',
  invalid_token: 'Die Anmeldung konnte nicht verifiziert werden.',
  provider_error: 'Der SSO-Anbieter ist gerade nicht erreichbar.',
  account_disabled: 'Dieses Konto wurde gesperrt.',
  already_linked: 'Dieses SSO-Konto gehört bereits zu einem anderen Quotes-Konto und kann nicht verknüpft werden.',
  has_identity: 'Dein Konto ist bereits mit einem anderen SSO-Konto verknüpft. Löse zuerst die bestehende Verknüpfung.',
};

// ---------- Login / Registrierung ----------
function renderAuth(mode = 'login', notice = state.authNotice) {
  state.authNotice = notice;
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
        finishLogin(await api('POST', isReg ? '/api/register' : '/api/login', { username: user.value, password: pass.value }));
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
  h('label', { for: 'u' }, 'Benutzername'), user,
  h('label', { for: 'p' }, 'Passwort'), pass,
  isReg ? h('div', { class: 'hint' }, 'Mindestens 10 Zeichen.') : null,
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
  const ssoBtn = sso ? h('a', { class: 'btn primary block sso', href: '/api/auth/oidc/login' }, `Mit ${sso.name} anmelden`) : null;
  const passkeyBtn = isReg ? null : passkeyLoginButton(finishLogin, (msg) => { if (err.isConnected) err.textContent = msg; else toast(msg); });
  const pwBlock = passwordLogin ? [
    h('div', { class: 'tabs', role: 'tablist' },
      h('button', { role: 'tab', 'aria-selected': String(!isReg), onclick: () => renderAuth('login') }, 'Anmelden'),
      h('button', { role: 'tab', 'aria-selected': String(isReg), onclick: () => renderAuth('register') }, 'Registrieren')),
    form] : [];
  const divider = (ssoBtn || passkeyBtn) && passwordLogin ? h('div', { class: 'or' }, h('span', {}, 'oder mit Passwort')) : null;

  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'auth' },
    h('div', { class: 'logo auth-logo' }, h('i', {}, '“'), 'Quotes'),
    h('h1', {}, 'Worte, die bleiben.'),
    h('p', { class: 'lead' }, 'Sammle Zitate von Menschen, die dich inspirieren – privat oder geteilt mit anderen.'),
    notice ? h('p', { class: 'auth-notice' }, notice) : null,
    card)));
  card.append(ssoBtn, passkeyBtn, divider, ...pwBlock);
  if (passwordLogin) user.focus();
}

// ---------- Öffentliche Ansicht (Freigabe-Link, ohne Login) ----------
async function renderPublic(token) {
  const body = h('div', { class: 'list' });
  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'public-page' },
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
const SCOPES = [['feed', 'Entdecken', 'compass'], ['mine', 'Meine', 'bookmark'], ['shared', 'Für mich', 'inbox'], ['liked', 'Favoriten', 'heart']];
const pendingDeletes = new Map(); // Zitat-ID -> sofort ausführen (für "Rückgängig")

async function renderMain({ justLoggedIn = false } = {}) {
  Object.assign(state, { tag: state.tag ?? null, person: state.person ?? null, sort: state.sort ?? 'new' });
  const list = h('div', { class: 'list', 'aria-live': 'polite' });
  const banner = h('div', { class: 'banner', hidden: true });
  const groupBar = h('div', { class: 'groupbar', hidden: true });
  const collBar = h('section', { class: 'collhead', hidden: true });
  const subSeg = h('div', { class: 'subseg', role: 'group', hidden: true });
  const SUBS = {
    feed: [['feed', 'Alle'], ['following', 'Gefolgt']], following: [['feed', 'Alle'], ['following', 'Gefolgt']],
    mine: [['mine', 'Zitate'], ['collections', 'Sammlungen', 'folder']], collections: [['mine', 'Zitate'], ['collections', 'Sammlungen', 'folder']],
  };
  const filterBtn = h('button', { class: 'btn sort-btn filter-btn', title: 'Filter: Zeitraum, Person, Tag, Sichtbarkeit', 'aria-label': 'Filter',
    onclick: () => openFilters(state, (f) => { Object.assign(state, f); load(true); }) }, icon('sliders'));
  const randomBtn = h('button', { class: 'btn sort-btn random-btn', title: 'Überrasch mich – zufälliges Zitat', 'aria-label': 'Überrasch mich – zufälliges Zitat',
    onclick: () => openRandom(['mine', 'liked'].includes(state.scope) ? state.scope : 'feed', quoteCard) }, icon('shuffle'));
  const filterBar = h('div', { class: 'filters' });
  const daily = h('div', { class: 'daily-slot' });
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  const more = h('button', { class: 'btn more', hidden: true }, 'Mehr laden');
  const search = h('input', { type: 'search', id: 'search', class: 'search', placeholder: 'Suchen …', title: 'Durchsucht Text, Person, Quelle und #Tags (Taste /)', 'aria-label': 'Suche', value: state.q, maxlength: 100, enterkeyhint: 'search' });
  const sortBtn = h('button', { class: 'btn sort-btn', title: 'Sortierung', onclick: () => { state.sort = state.sort === 'top' ? 'new' : 'top'; load(true); } });
  const bellCount = h('span', { class: 'count', hidden: true });
  const bell = h('button', { class: 'icon-btn', 'aria-label': 'Benachrichtigungen', title: 'Benachrichtigungen', onclick: () => openNotifications() }, icon('bell'), bellCount);
  const newBtn = h('button', { class: 'btn primary new-btn', onclick: () => openEditor(), title: 'Neues Zitat (N)' }, icon('plus'), h('span', {}, 'Neues Zitat'));

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load(true); }, 250); });
  more.addEventListener('click', () => loadMore());

  const setScope = (id, extra = {}) => {
    Object.assign(state, { scope: id, group: null, collection: null, profile: null, tag: null, person: null, from: null, to: null, vis: null }, extra);
    load(true); window.scrollTo({ top: 0 });
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Ansicht' },
    SCOPES.map(([id, label]) => h('button', { 'data-scope': id, onclick: () => setScope(id) }, label)));
  // Handy: Navigationsleiste unten (Daumen-Reichweite), "+" in der Mitte
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Ansicht' },
    SCOPES.slice(0, 2).map(([id, label, ic]) => h('button', { 'data-scope': id, onclick: () => setScope(id) }, icon(ic), h('span', {}, label))),
    h('button', { class: 'tab-new', 'aria-label': 'Neues Zitat', onclick: () => openEditor() }, icon('plus')),
    SCOPES.slice(2).map(([id, label, ic]) => h('button', { 'data-scope': id, onclick: () => setScope(id) }, icon(ic), h('span', {}, label))));

  $app.replaceChildren(
    h('header', { class: 'nav' }, h('div', { class: 'nav-in' },
      h('button', { class: 'logo logo-btn', onclick: () => setScope('feed'), 'aria-label': 'Quotes – Startseite' }, h('i', {}, '“'), 'Quotes'),
      h('div', { class: 'spacer' }),
      newBtn, bell,
      h('button', { class: 'icon-btn', 'aria-label': 'Gruppen', title: 'Gruppen', onclick: () => openGroups() }, icon('users')),
      h('button', { class: 'icon-btn avatar-btn', 'aria-label': `Konto (@${state.user.username})`, title: `Konto (@${state.user.username})`, onclick: () => openAccount() }, avatar(state.user.username)))),
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
      subSeg.setAttribute('aria-label', state.scope === 'mine' || state.scope === 'collections' ? 'Meine' : 'Entdecken');
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
        h('div', { class: 'collhead-top' }, h('span', { class: 'daily-label' }, c.isOwner ? 'Sammlung' : `Sammlung von @${c.owner}`),
          h('button', { class: 'icon-btn sm', 'aria-label': 'Sammlung schließen', onclick: () => setScope(c.isOwner ? 'collections' : 'feed') }, '✕')),
        h('h2', {}, c.name),
        c.description ? h('p', { class: 'coll-intro' }, c.description) : null,
        c.isOwner ? h('div', { class: 'collhead-actions' },
          h('button', { class: 'btn sm', onclick: () => openCollectionLink(c, () => load(true)) }, icon('link', { size: 16 }), h('span', {}, c.link ? 'Link verwalten' : 'Per Link teilen')),
          h('button', { class: 'btn sm', onclick: () => openCollectionEditor(c, (sv) => { state.collection = { ...c, ...sv }; load(true); }, () => setScope('collections')) }, icon('edit', { size: 16 }), h('span', {}, 'Bearbeiten'))) : null);
    }
    sortBtn.replaceChildren(icon('sort'), h('span', {}, state.sort === 'top' ? 'Beliebteste' : 'Neueste'));
    sortBtn.classList.toggle('on', state.sort === 'top');
    sortBtn.setAttribute('aria-label', `Sortierung: ${state.sort === 'top' ? 'Beliebteste' : 'Neueste'} (umschalten)`);
    groupBar.hidden = state.scope !== 'group';
    if (state.scope === 'group') {
      groupBar.replaceChildren(
        h('span', {}, 'Gruppe'), h('b', {}, state.group.name), h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => openGroup(state.group.id) }, 'Mitglieder'),
        h('button', { class: 'btn sm ghost', 'aria-label': 'Gruppenansicht schließen', onclick: () => setScope('feed') }, '✕'));
    }
  }

  async function drawFilters() {
    const active = [];
    if (state.person) active.push(h('button', { class: 'fchip on', onclick: () => { state.person = null; load(true); }, 'aria-label': `Filter ${state.person} entfernen` }, h('span', {}, state.person), ' ✕'));
    if (state.tag) active.push(h('button', { class: 'fchip on', onclick: () => { state.tag = null; load(true); }, 'aria-label': `Filter #${state.tag} entfernen` }, `#${state.tag} ✕`));
    if (state.from || state.to) {
      const d = (v) => new Date(`${v}T00:00:00Z`).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      const label = state.from && state.to ? `${d(state.from)} – ${d(state.to)}` : state.from ? `ab ${d(state.from)}` : `bis ${d(state.to)}`;
      active.push(h('button', { class: 'fchip on', onclick: () => { state.from = state.to = null; load(true); }, 'aria-label': 'Zeitraum-Filter entfernen' }, `${label} ✕`));
    }
    if (state.vis) active.push(h('button', { class: 'fchip on', onclick: () => { state.vis = null; load(true); }, 'aria-label': 'Sichtbarkeits-Filter entfernen' }, `${VIS[state.vis]} ✕`));
    if (active.length) { filterBar.replaceChildren(h('span', { class: 'flabel' }, 'Filter'), ...active); return; }
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
      daily.replaceChildren(h('section', { class: 'daily', 'aria-label': 'Zitat des Tages' },
        h('div', { class: 'daily-label' }, 'Zitat des Tages'),
        h('blockquote', {}, q.text),
        h('div', { class: 'daily-foot' },
          h('button', { class: 'person-link', onclick: () => filterBy({ person: q.person }) }, `— ${q.person}`),
          h('div', { class: 'spacer' }),
          h('button', { class: 'icon-btn sm', 'aria-label': 'Kopieren', title: 'Kopieren', onclick: () => copyQuote(q) }, icon('copy')),
          h('button', { class: 'icon-btn sm', 'aria-label': 'Als Bild', title: 'Als Bild', onclick: () => openImage(q) }, icon('image')))));
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
        if (!list.querySelector('.quote')) list.append(h('div', { class: 'empty' }, h('b', {}, 'Noch leer'),
          h('p', {}, res.collection.isOwner ? 'Füge Zitate über das ⋯-Menü einer Karte hinzu („Zu Sammlung …“).' : 'In dieser Sammlung ist noch nichts, das du sehen kannst.')));
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

function emptyState(suggestion, onSuggest) {
  if (suggestion) {
    return h('div', { class: 'empty' }, h('b', {}, 'Keine Treffer'),
      h('p', {}, 'Meintest du ', h('button', { class: 'link-btn', onclick: () => onSuggest(suggestion) }, `„${suggestion}“`), '?'));
  }
  if (state.scope === 'following') {
    return h('div', { class: 'empty' }, h('b', {}, 'Noch niemandem gefolgt'),
      h('p', {}, 'Tippe bei einem Zitat auf den Namen, um das Profil zu öffnen, und folge Leuten, deren Zitate dir gefallen.'));
  }
  if (state.scope === 'user') return h('div', { class: 'empty' }, h('b', {}, 'Keine sichtbaren Zitate'));
  const filtered = state.q || state.tag || state.person || state.from || state.to || state.vis;
  const reset = filtered ? h('button', { class: 'btn', onclick: () => state.filterBy?.({}) }, 'Filter zurücksetzen') : null;
  if (filtered) return h('div', { class: 'empty' }, h('b', {}, 'Keine Treffer'), h('p', {}, 'Versuche einen anderen Suchbegriff oder Filter.'), reset);
  if (state.scope === 'group') {
    return h('div', { class: 'empty' }, h('b', {}, 'Noch keine Zitate in dieser Gruppe'), h('p', {}, 'Teile ein Zitat und wähle unter „Geteilt“ diese Gruppe aus.'));
  }
  const msgs = {
    feed: ['Noch nichts los hier', 'Sobald jemand ein Zitat öffentlich teilt, erscheint es hier.'],
    mine: ['Deine Sammlung ist leer', 'Halte fest, was dich bewegt – dein erstes Zitat ist nur einen Tipp entfernt.'],
    shared: ['Noch nichts für dich', 'Hier landen Zitate, in denen du markiert bist oder die mit dir bzw. deinen Gruppen geteilt wurden.'],
    liked: ['Keine Favoriten', 'Tippe bei einem Zitat auf ♡, um es hier wiederzufinden.'],
  }[state.scope];
  return h('div', { class: 'empty' }, h('b', {}, msgs[0]), h('p', {}, msgs[1]),
    state.scope === 'mine' ? h('button', { class: 'btn primary', onclick: () => openEditor() }, '+ Erstes Zitat hinzufügen') : null);
}

async function copyQuote(q) {
  try { await navigator.clipboard.writeText(quoteAsText(q)); toast('Zitat kopiert'); } catch { toast('Kopieren nicht möglich'); }
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
  toast('Zitat gelöscht', { action: 'Rückgängig', ms: 5000, onAction: () => {
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
    class: 'act like', 'aria-pressed': String(q.liked), 'aria-label': `Favorit (${q.likes})`, title: 'Favorit',
    onclick: async () => {
      try {
        const r = await api('POST', `/api/quotes/${q.id}/like`);
        q.liked = r.liked; q.likes = r.likes;
        likeBtn.setAttribute('aria-pressed', String(r.liked));
        likeBtn.setAttribute('aria-label', `Favorit (${r.likes})`);
        likeBtn.firstChild.replaceWith(heart());
        likeCount.textContent = String(r.likes);
        if (r.liked) { likeBtn.classList.remove('pop'); void likeBtn.offsetWidth; likeBtn.classList.add('pop'); }
      } catch (ex) { toast(ex.message); }
    },
  }, heart(), likeCount);

  const sharedCount = q.mine && q.visibility === 'shared' ? q.shareWith.length + q.shareGroups.length : 0;
  const commentCount = h('span', {}, String(q.comments ?? 0));
  const commentBtn = h('button', { class: 'act', 'aria-label': `Kommentare (${q.comments ?? 0})`, title: 'Kommentare',
    onclick: () => openComments(q, { onCount: (n) => { q.comments = n; commentCount.textContent = String(n); commentBtn.setAttribute('aria-label', `Kommentare (${n})`); } }) },
  icon('message'), commentCount);
  let card;
  const inOwnCollection = state.scope === 'collection' && state.collection?.isOwner;
  const moreBtn = !compact ? h('button', { class: 'act', 'aria-label': 'Weitere Aktionen', 'aria-haspopup': 'menu', title: 'Mehr',
    onclick: (e) => popMenu(e.currentTarget, [
      ['folder', 'Zu Sammlung …', () => openAddToCollection(q)],
      ...(inOwnCollection ? [['minus', 'Aus dieser Sammlung entfernen', async () => {
        try { await api('DELETE', `/api/collections/${state.collection.id}/quotes/${q.id}`); card.remove(); toast('Aus der Sammlung entfernt'); } catch (ex) { toast(ex.message); }
      }]] : []),
      ...(!q.mine ? [
        ['edit', 'Korrektur vorschlagen …', () => openSuggest(q)],
        ['flag', 'Melden …', () => openReport({ quoteId: q.id }, 'Zitat'), 'danger'],
      ] : []),
      ...(q.mine ? [
        ['edit', 'Bearbeiten', () => openEditor(q)],
        ['link', q.link ? 'Link verwalten' : 'Per Link teilen', () => openLink(q, reload)],
        ['trash', 'Löschen', () => deleteWithUndo(q, card), 'danger'],
      ] : []),
    ]) }, icon('more')) : null;

  card = h('article', { class: 'card quote' },
    h('header', { class: 'qhead' }, avatar(q.mine ? state.user.username : q.author),
      h('span', { class: 'qwho' }, h('button', { class: 'author-link', title: `Profil von @${q.author}`, onclick: () => { document.querySelector('dialog[open]')?.close(); state.showProfile?.(q.author); } },
        q.mine ? 'Du' : `@${q.author}`), h('span', {}, relTime(q.createdAt))),
      q.mine ? h('span', { class: `badge ${q.visibility}`, title: q.visibility === 'shared' ? `Geteilt mit ${plural(sharedCount, 'Empfänger', 'Empfängern')}` : null },
        VIS[q.visibility] + (sharedCount ? ` · ${sharedCount}` : '')) : null,
      q.mine && q.link ? h('span', { class: 'badge', title: 'Per Link geteilt' }, icon('link', { size: 12 })) : null),
    h('blockquote', {}, q.text),
    h('div', { class: 'qsrc' },
      h('button', { class: 'person-link', title: `Alle Zitate von ${q.person}`, onclick: () => state.filterBy?.({ person: q.person }) }, `— ${q.person}`),
      q.source ? h('span', { class: 'source' }, `, ${q.source}`) : null),
    q.tags?.length ? h('div', { class: 'tags' }, q.tags.map((t) => h('button', { class: 'tag', onclick: () => state.filterBy?.({ tag: t }) }, `#${t}`))) : null,
    q.mentions.length ? h('div', { class: 'mentions' }, h('span', {}, 'Markiert'),
      q.mentions.map((m) => h('span', { class: `mention${m === state.user?.username ? ' me' : ''}` }, `@${m}`))) : null,
    compact ? null : h('footer', { class: 'qactions' }, likeBtn,
      commentBtn,
      h('button', { class: 'act', 'aria-label': 'Kopieren', title: 'Kopieren', onclick: () => copyQuote(q) }, icon('copy')),
      h('button', { class: 'act', 'aria-label': 'Als Bild teilen', title: 'Als Bild', onclick: () => openImage(q) }, icon('image')),
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
  const serif = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
  const sans = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
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
  x.fillText('“ Quotes', PAD, H - 90);
  return c;
}

function openImage(q) {
  let dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  let canvas;
  const img = h('img', { class: 'qimg', alt: `Bild des Zitats: ${quoteAsText(q)}` });
  const fileName = () => `zitat-${q.person.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'quotes'}.png`;
  const draw = () => { canvas = renderQuoteImage(q, dark); img.src = canvas.toDataURL('image/png'); toggle.textContent = dark ? 'Hell' : 'Dunkel'; };
  const toggle = h('button', { class: 'btn', type: 'button', onclick: () => { dark = !dark; draw(); } });
  const download = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    const a = h('a', { href: canvas.toDataURL('image/png'), download: fileName() }); document.body.append(a); a.click(); a.remove();
  } }, icon('download'), h('span', {}, 'Herunterladen'));
  const share = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => canvas.toBlob(async (blob) => {
    try { await navigator.share({ files: [new File([blob], fileName(), { type: 'image/png' })], text: quoteAsText(q) }); } catch { /* abgebrochen */ }
  }) }, 'Teilen …');
  try { share.hidden = !navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] }); } catch { share.hidden = true; }
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Als Bild'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Schließen', onclick: () => dlg.close() }, '✕')),
    h('p', { class: 'hint' }, 'Perfekt für Instagram, WhatsApp-Status oder zum Ausdrucken (1080 × 1350).'),
    img, h('div', { class: 'img-actions' }, download, share, toggle));
  dlg.classList.add('image-dialog');
  draw();
}

// ---------- Editor ----------
async function openEditor(q) {
  const err = h('p', { class: 'error', role: 'alert' });
  const text = h('textarea', { id: 'f-text', required: true, maxlength: 1000, placeholder: 'Was wurde gesagt?', rows: 4 }); text.value = q?.text ?? '';
  const counter = h('span', { class: 'counter' });
  const updateCounter = () => { counter.textContent = `${text.value.length}/1000`; counter.classList.toggle('warn', text.value.length > 900); };
  text.addEventListener('input', updateCounter); updateCounter();
  const person = h('input', { id: 'f-person', type: 'text', required: true, maxlength: 100, placeholder: 'z. B. Marie Curie', autocomplete: 'off' }); person.value = q?.person ?? '';
  const source = h('input', { id: 'f-source', type: 'text', maxlength: 150, placeholder: 'Buch, Rede, Interview … (optional)' }); source.value = q?.source ?? '';
  let tagCache = null;
  const tags = chipInput({ id: 'f-tags', initial: q?.tags ?? [], prefix: '#', placeholder: '#tag', suggest: async (s) => {
    tagCache ??= (await api('GET', '/api/tags').catch(() => ({ tags: [] }))).tags.map((t) => t.tag);
    return tagCache.filter((t) => t.startsWith(s.toLowerCase())).slice(0, 8);
  } });
  const mentions = chipInput({ id: 'f-mentions', initial: q?.mentions ?? [], placeholder: '@benutzername' });
  const shareUsers = chipInput({ id: 'f-share', initial: q?.shareWith ?? [], placeholder: '@benutzername' });
  const groupBox = h('div', { class: 'check-group' }, h('span', { class: 'hint' }, 'Gruppen werden geladen …'));
  const shareBox = h('div', { class: 'share-box' },
    h('label', { for: 'f-share' }, 'Teilen mit Personen'), shareUsers.el,
    h('label', {}, 'Teilen mit Gruppen'), groupBox);
  const current = q?.visibility ?? 'private';
  const opts = [['private', 'Privat', 'Nur du (und Markierte)'], ['shared', 'Geteilt', 'Personen & Gruppen'], ['public', 'Öffentlich', 'Alle Nutzer']];
  const radios = opts.map(([v, t, d]) => h('label', {}, h('input', { type: 'radio', name: 'vis', value: v, checked: v === current }), h('span', {}, t, h('small', {}, d))));
  const save = h('button', { class: 'btn primary', type: 'submit', title: 'Speichern (Strg/⌘ + Enter)' }, 'Speichern');
  let dlg;
  const sync = () => { shareBox.hidden = dlg.querySelector('input[name=vis]:checked').value !== 'shared'; };
  const form = h('form', {
    onchange: sync,
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } },
    onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true; err.textContent = '';
      const visibility = dlg.querySelector('input[name=vis]:checked').value;
      const body = { text: text.value, person: person.value, source: source.value, visibility, tags: tags.values(), mentions: mentions.values(),
        shareWith: shareUsers.values(), shareGroups: [...groupBox.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
      try {
        await (q ? api('PUT', `/api/quotes/${q.id}`, body) : api('POST', '/api/quotes', body));
        dlg.close(); toast(q ? 'Gespeichert' : 'Zitat hinzugefügt'); state.reload?.();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    },
  },
  h('div', { class: 'dialog-head' }, h('h2', {}, q ? 'Zitat bearbeiten' : 'Neues Zitat'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Schließen', onclick: () => dlg.close() }, '✕')),
  h('div', { class: 'label-row' }, h('label', { for: 'f-text' }, 'Zitat'), counter), text,
  duplicateHint(text, q?.id, { onOpen: (d) => { dlg.close(); openQuote(d); } }), attachPersonSuggest(person),
  h('div', { class: 'grid2' },
    h('div', {}, h('label', { for: 'f-person' }, 'Person'), person),
    h('div', {}, h('label', { for: 'f-source' }, 'Quelle'), source)),
  h('label', { for: 'f-tags' }, 'Tags'), tags.el,
  h('label', { for: 'f-mentions' }, 'Personen markieren'), mentions.el,
  h('div', { class: 'hint' }, 'Markierte Nutzer sehen das Zitat immer und werden benachrichtigt.'),
  h('label', {}, 'Sichtbarkeit'), h('div', { class: 'radio-group vis-group' }, radios), shareBox, err,
  h('div', { class: 'row sticky-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'), save));
  dlg = modal(form);
  dlg.classList.add('editor');
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
        comment: [h('b', {}, `@${n.actor}`), ' hat dein Zitat kommentiert'],
        comment_mention: [h('b', {}, `@${n.actor}`), ' hat dich in einem Kommentar erwähnt'],
        follow: [h('b', {}, `@${n.actor}`), ' folgt dir jetzt'],
        group_owner: [h('b', {}, `@${n.actor}`), ' hat dir die Gruppe ', h('b', {}, `„${n.groupName}“`), ' übertragen'],
        group_join: [h('b', {}, `@${n.actor}`), ' ist über deine Einladung ', h('b', {}, `„${n.groupName}“`), ' beigetreten'],
        suggestion: [h('b', {}, `@${n.actor}`), ' schlägt eine Korrektur zu deinem Zitat vor'],
        suggestion_accepted: [h('b', {}, `@${n.actor}`), ' hat deine Korrektur übernommen 🎉'],
        suggestion_rejected: [h('b', {}, `@${n.actor}`), ' hat deine Korrektur nicht übernommen'],
      }[n.type] ?? [h('b', {}, `@${n.actor}`), ' hat etwas mit dir geteilt'];
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
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')));
  dlg.classList.add('quote-dialog');
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
      try { await api('DELETE', '/api/me', sso ? { confirm: pass.value } : { password: pass.value }); dlg.close(); clearOfflineData(); setUser(null); render(); toast('Konto gelöscht'); }
      catch (ex) { err.textContent = ex.message; }
    },
  },
  h('label', { for: 'acc-del' }, sso ? 'Konto löschen – Benutzernamen eintippen' : 'Konto löschen – Passwort bestätigen'), pass,
  sso ? h('div', { class: 'hint' }, 'Dein Konto wird über SSO verwaltet und hat kein Passwort.') : null, err,
  h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'submit' }, 'Konto endgültig löschen')));
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Konto'), h('button', { class: 'btn sm', onclick: () => { dlg.close(); logout(); } }, 'Abmelden')),
    h('div', { class: 'acc-id' }, avatar(state.user.username), h('div', {}, h('b', {}, `@${state.user.username}`),
      h('span', { class: 'hint' }, state.user.sso ? 'Konto über SSO' : state.user.ssoLinked ? 'Passwort + SSO' : 'Passwort-Konto'))),
    h('div', { class: 'row left acc-links' },
      h('button', { class: 'btn', onclick: () => { dlg.close(); openStats(); } }, icon('chart', { size: 18 }), h('span', {}, 'Statistik')),
      h('button', { class: 'btn', onclick: () => { dlg.close(); state.showProfile?.(state.user.username); } }, icon('user', { size: 18 }), h('span', {}, 'Mein Profil')),
      h('button', { class: 'btn', onclick: () => { dlg.close(); openSuggestions({ onChange: () => state.reload?.() }); } }, icon('edit', { size: 18 }), h('span', {}, 'Vorschläge')),
      h('button', { class: 'btn', onclick: () => { dlg.close(); openSecurity(); } }, icon('shield', { size: 18 }), h('span', {}, 'Sicherheit')),
      h('button', { class: 'btn', onclick: () => { dlg.close(); openIntegrations(); } }, icon('plug', { size: 18 }), h('span', {}, 'Integrationen')),
      state.user.isAdmin ? h('button', { class: 'btn primary', onclick: () => { dlg.close(); openAdmin(); } }, icon('sliders', { size: 18 }), h('span', {}, 'Admin-Bereich')) : null),
    nameForm,
    themeSection(),
    h('section', { class: 'acc-section' }, h('label', {}, 'Zitate exportieren'),
      h('p', { class: 'hint' }, 'Alle deine Zitate inklusive Tags und Freigaben – als Sicherung oder für Excel.'),
      h('div', { class: 'row left' },
        h('a', { class: 'btn', href: '/api/export?format=csv', download: true }, icon('download'), h('span', {}, 'CSV (Excel)')),
        h('a', { class: 'btn', href: '/api/export?format=json', download: true }, icon('download'), h('span', {}, 'JSON')))),
    importSection(() => state.reload?.()),
    deviceSection(),
    emailSection(),
    ssoSection(() => dlg),
    h('p', { class: 'hint shortcuts' }, 'Tastenkürzel: N – neues Zitat · / – Suche · Strg/⌘ + Enter – speichern'),
    h('details', { class: 'danger-zone' }, h('summary', {}, 'Konto löschen'), delForm),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')));
}

function themeSection() {
  const current = getTheme();
  const seg = h('div', { class: 'seg theme-seg', role: 'radiogroup', 'aria-label': 'Farbschema' },
    [['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === current), 'aria-pressed': String(v === current),
      onclick: (e) => {
        setTheme(v);
        for (const b of seg.children) { const on = b === e.currentTarget; b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-pressed', String(on)); }
      },
    }, label)));
  return h('section', { class: 'acc-section' }, h('label', {}, 'Darstellung'), seg);
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
    if (!state.user) return renderAuth('login', 'Melde dich an (oder registriere dich), um der Gruppe beizutreten.');
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

(async () => {
  if (/^\/[sc]\//.test(location.pathname)) return render();
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
  const actions = takeUrlActions();
  render({ justLoggedIn: true });
  if (actions.toast) setTimeout(() => toast(actions.toast), 100);
  if (state.user && actions.notifications) setTimeout(() => openNotifications(), 150);
  if (state.user && actions.newQuote) setTimeout(() => openEditor(), 150);
})();
