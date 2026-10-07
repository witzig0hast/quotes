// Bewusst ohne innerHTML: alle Nutzerinhalte werden per textContent gesetzt (XSS-sicher).
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const state = { user: null, csrf: null, scope: 'feed', q: '', page: 1 };

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

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : method === 'DELETE' ? { 'Content-Type': 'application/json' } : {}),
               ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : method === 'DELETE' ? '{}' : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; state.csrf = null; render(); }
    throw new Error(data.error || 'Etwas ist schiefgelaufen.');
  }
  return data;
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
        state.user = r.user; state.csrf = r.csrf; state.scope = 'feed'; state.q = ''; state.page = 1;
        render();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
  h('label', { for: 'u' }, 'Benutzername'), user,
  h('label', { for: 'p' }, 'Passwort'), pass,
  isReg ? h('div', { class: 'hint' }, 'Mindestens 10 Zeichen.') : null,
  err, btn);

  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'auth' },
    h('div', { class: 'logo auth-logo' }, h('i', {}, '“'), 'Quotes'),
    h('h1', {}, 'Worte, die bleiben.'),
    h('p', { class: 'lead' }, 'Sammle Zitate von Menschen, die dich inspirieren – privat oder geteilt mit anderen.'),
    h('div', { class: 'card' },
      h('div', { class: 'tabs', role: 'tablist' },
        h('button', { role: 'tab', 'aria-selected': String(!isReg), onclick: () => renderAuth('login') }, 'Anmelden'),
        h('button', { role: 'tab', 'aria-selected': String(isReg), onclick: () => renderAuth('register') }, 'Registrieren')),
      form))));
  user.focus();
}

// ---------- Hauptansicht ----------
const SCOPES = [['feed', 'Entdecken'], ['mine', 'Meine'], ['shared', 'Geteilt'], ['liked', 'Favoriten']];
const VIS = { private: 'Privat', shared: 'Mit Nutzern', public: 'Öffentlich' };
const fmtDate = (t) => new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });

async function renderMain() {
  const list = h('div', { class: 'list' });
  const more = h('button', { class: 'btn more' }, 'Mehr laden');
  more.hidden = true;
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Zitate durchsuchen…', 'aria-label': 'Suche', value: state.q, maxlength: 100 });

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load(true); }, 250); });
  more.addEventListener('click', () => { state.page++; load(false); });

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Ansicht' },
    SCOPES.map(([id, label]) => h('button', {
      'aria-pressed': String(state.scope === id),
      onclick: (e) => {
        state.scope = id;
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        load(true);
      },
    }, label)));

  $app.replaceChildren(
    h('header', { class: 'nav' }, h('div', { class: 'nav-in' },
      h('div', { class: 'logo' }, h('i', {}, '“'), 'Quotes'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'who' }, `@${state.user.username}`),
      h('button', { class: 'btn sm', onclick: openAccount }, 'Konto'),
      h('button', { class: 'btn sm', onclick: logout }, 'Abmelden'))),
    h('main', { class: 'container' }, h('div', { class: 'toolbar' }, seg, search), list, more),
    h('button', { class: 'btn primary fab', onclick: () => openEditor() }, '+ Neues Zitat'));

  let token = 0;
  async function load(reset) {
    const my = ++token;
    if (reset) { state.page = 1; list.replaceChildren(); }
    try {
      const qs = new URLSearchParams({ scope: state.scope, page: state.page, ...(state.q ? { q: state.q } : {}) });
      const { quotes, hasMore } = await api('GET', `/api/quotes?${qs}`);
      if (my !== token) return;
      for (const q of quotes) list.append(quoteCard(q, () => load(true)));
      more.hidden = !hasMore;
      if (!list.children.length) list.append(emptyState());
    } catch (ex) { if (my === token) toast(ex.message); }
  }
  load(true);
  state.reload = () => load(true);
}

function emptyState() {
  const msgs = {
    feed: ['Noch nichts los hier', 'Sobald jemand ein Zitat öffentlich teilt, erscheint es hier.'],
    mine: ['Deine Sammlung ist leer', 'Füge dein erstes Zitat hinzu – mit dem Button unten rechts.'],
    shared: ['Nichts mit dir geteilt', 'Hier landen Zitate, die andere gezielt mit dir teilen.'],
    liked: ['Keine Favoriten', 'Markiere Zitate mit ♥, um sie hier wiederzufinden.'],
  }[state.scope];
  return h('div', { class: 'empty' }, h('b', {}, state.q ? 'Keine Treffer' : msgs[0]), state.q ? 'Versuche einen anderen Suchbegriff.' : msgs[1]);
}

function quoteCard(q, reload) {
  const likeBtn = h('button', {
    class: 'btn ghost sm like', 'aria-pressed': String(q.liked), 'aria-label': 'Favorit',
    onclick: async () => {
      try {
        const r = await api('POST', `/api/quotes/${q.id}/like`);
        q.liked = r.liked; q.likes = r.likes;
        likeBtn.setAttribute('aria-pressed', String(r.liked));
        likeBtn.textContent = `${r.liked ? '♥' : '♡'} ${r.likes}`;
      } catch (ex) { toast(ex.message); }
    },
  }, `${q.liked ? '♥' : '♡'} ${q.likes}`);

  return h('article', { class: 'card quote' },
    h('blockquote', {}, q.text),
    h('div', {}, h('span', { class: 'person' }, `— ${q.person}`), q.source ? h('span', { class: 'source' }, `, ${q.source}`) : null),
    h('div', { class: 'meta' },
      h('span', {}, q.mine ? 'von dir' : `von @${q.author}`), h('span', {}, fmtDate(q.createdAt)),
      q.mine ? h('span', { class: `badge ${q.visibility}` }, VIS[q.visibility] + (q.visibility === 'shared' ? ` (${q.shareWith.length})` : '')) : null,
      h('div', { class: 'actions' }, likeBtn,
        q.mine ? [h('button', { class: 'btn ghost sm', onclick: () => openEditor(q) }, 'Bearbeiten'),
                  h('button', { class: 'btn ghost sm danger', onclick: async () => {
                    if (!confirm('Dieses Zitat wirklich löschen?')) return;
                    try { await api('DELETE', `/api/quotes/${q.id}`); toast('Gelöscht'); reload(); } catch (ex) { toast(ex.message); }
                  } }, 'Löschen')] : null)));
}

// ---------- Editor ----------
function openEditor(q) {
  const dlg = h('dialog');
  const err = h('p', { class: 'error', role: 'alert' });
  const text = h('textarea', { required: true, maxlength: 1000, placeholder: 'Was wurde gesagt?' }); text.value = q?.text ?? '';
  const person = h('input', { type: 'text', required: true, maxlength: 100, placeholder: 'z. B. Marie Curie' }); person.value = q?.person ?? '';
  const source = h('input', { type: 'text', maxlength: 150, placeholder: 'Buch, Rede, Interview … (optional)' }); source.value = q?.source ?? '';
  const share = h('input', { type: 'text', maxlength: 600, placeholder: 'Benutzernamen, durch Komma getrennt' }); share.value = (q?.shareWith ?? []).join(', ');
  const shareBox = h('div', {}, h('label', {}, 'Teilen mit'), share, h('div', { class: 'hint' }, 'Nur diese Nutzer können das Zitat sehen.'));
  const current = q?.visibility ?? 'private';
  const opts = [['private', 'Privat', 'Nur du siehst es.'], ['shared', 'Bestimmte Nutzer', 'Nur ausgewählte Nutzer sehen es.'], ['public', 'Öffentlich', 'Alle angemeldeten Nutzer sehen es unter „Entdecken“.']];
  const radios = opts.map(([v, t, d]) => h('label', {}, h('input', { type: 'radio', name: 'vis', value: v, checked: v === current }), h('span', {}, t, h('small', {}, d))));
  const sync = () => { shareBox.style.display = dlg.querySelector('input[name=vis]:checked').value === 'shared' ? '' : 'none'; };
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Speichern');
  const form = h('form', {
    method: 'dialog',
    onchange: sync,
    onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true; err.textContent = '';
      const visibility = dlg.querySelector('input[name=vis]:checked').value;
      const body = { text: text.value, person: person.value, source: source.value, visibility,
        shareWith: share.value.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean) };
      try {
        await (q ? api('PUT', `/api/quotes/${q.id}`, body) : api('POST', '/api/quotes', body));
        dlg.close(); toast('Gespeichert'); state.reload?.();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    },
  },
  h('h2', {}, q ? 'Zitat bearbeiten' : 'Neues Zitat'),
  h('label', {}, 'Zitat'), text, h('label', {}, 'Person'), person, h('label', {}, 'Quelle'), source,
  h('label', {}, 'Sichtbarkeit'), h('div', { class: 'radio-group' }, radios), shareBox, err,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'), save));
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  sync();
  dlg.showModal();
  text.focus();
}

// ---------- Konto ----------
function openAccount() {
  const dlg = h('dialog');
  const err = h('p', { class: 'error', role: 'alert' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!confirm('Konto und alle Zitate endgültig löschen?')) return;
      try { await api('DELETE', '/api/me', { password: pass.value }); dlg.close(); state.user = null; state.csrf = null; render(); toast('Konto gelöscht'); }
      catch (ex) { err.textContent = ex.message; }
    },
  },
  h('h2', {}, 'Konto'), h('p', { class: 'hint' }, `Angemeldet als @${state.user.username}`),
  h('label', {}, 'Konto löschen – Passwort bestätigen'), pass, err,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen'),
    h('button', { class: 'btn danger', type: 'submit' }, 'Konto löschen')));
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* egal */ }
  state.user = null; state.csrf = null; render();
}

function render() { state.user ? renderMain() : renderAuth(); }

(async () => {
  try {
    const r = await api('GET', '/api/me');
    state.user = r.user; state.csrf = r.csrf ?? null;
  } catch { /* nicht angemeldet */ }
  render();
})();
