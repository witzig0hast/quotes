// Verbesserungsvorschläge, Melden und Admin-Bereich.
import { h, api, toast, modal, icon, plural, relTime, fmtDate, state, t, LOCALE, LANG } from './core.js';

const FIELD = { text: t('Zitat'), person: t('Person'), source: t('Quelle') };
const closeBtn = (dlg) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg().close() }, '✕');

// ---------- Korrektur vorschlagen (fremdes Zitat) ----------
export function openSuggest(q) {
  const err = h('p', { class: 'error', role: 'alert' });
  const field = h('select', { id: 'sg-field' }, Object.entries(FIELD).map(([v, l]) => h('option', { value: v }, l)));
  const value = h('textarea', { id: 'sg-value', rows: 3, maxlength: 1000, required: false });
  const note = h('input', { type: 'text', id: 'sg-note', maxlength: 300, placeholder: t('z. B. „Laut Biografie lautet das Original …“ (optional)') });
  const sync = () => { value.value = q[field.value] ?? ''; value.rows = field.value === 'text' ? 4 : 1; };
  field.addEventListener('change', sync); sync();
  let dlg;
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      await api('POST', `/api/quotes/${q.id}/suggestions`, { field: field.value, value: value.value, note: note.value });
      dlg.close(); toast(t('Vorschlag an @{0} geschickt', q.author));
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'dialog-head' }, h('h2', {}, t('Korrektur vorschlagen')), closeBtn(() => dlg)),
  h('p', { class: 'hint' }, t('@{0} entscheidet, ob die Änderung übernommen wird.', q.author)),
  h('label', { for: 'sg-field' }, t('Was ist falsch?')), field,
  h('label', { for: 'sg-value' }, t('Richtig wäre')), value,
  h('label', { for: 'sg-note' }, t('Begründung / Beleg')), note, err,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Abbrechen')), h('button', { class: 'btn primary', type: 'submit' }, t('Vorschlag senden'))));
  dlg = modal(form);
  value.focus();
}

// ---------- Vorschläge verwalten ----------
export async function openSuggestions({ onChange } = {}) {
  const inc = h('div', { class: 'sugg-list' }, h('p', { class: 'hint' }, t('Wird geladen …')));
  const out = h('div', { class: 'sugg-list' });
  let dlg;
  dlg = modal(h('div', { class: 'dialog-head' }, h('h2', {}, t('Vorschläge')), closeBtn(() => dlg)),
    h('h3', { class: 'sub-head' }, t('Zu deinen Zitaten')), inc, h('h3', { class: 'sub-head' }, t('Von dir')), out);
  const STATUS = { open: 'offen', accepted: t('übernommen'), rejected: 'abgelehnt' };
  const load = async () => {
    try {
      const { incoming, outgoing } = await api('GET', '/api/suggestions');
      inc.replaceChildren(...(incoming.length ? incoming.map((s) => h('article', { class: 'sugg' },
        h('div', { class: 'sugg-head' }, h('b', {}, `@${s.by}`), t(' schlägt für „{0}“ vor · {1}', FIELD[s.field], relTime(s.createdAt))),
        h('p', { class: 'hint qpreview' }, `„${s.quoteText}${s.quoteText.length >= 140 ? '…' : ''}“ — ${s.quotePerson}`),
        h('div', { class: 'diff' }, h('del', {}, s.current || '(leer)'), h('ins', {}, s.value || '(leer)')),
        s.note ? h('p', { class: 'sugg-note' }, `„${s.note}“`) : null,
        h('div', { class: 'row left' },
          h('button', { class: 'btn primary sm', onclick: () => decide(s, 'accept') }, t('Übernehmen')),
          h('button', { class: 'btn sm', onclick: () => decide(s, 'reject') }, t('Ablehnen')))))
        : [h('p', { class: 'hint' }, t('Keine offenen Vorschläge.'))]));
      out.replaceChildren(...(outgoing.length ? outgoing.map((s) => h('div', { class: 'sugg small' },
        h('span', {}, `${FIELD[s.field]} → „${s.value.slice(0, 60)}${s.value.length > 60 ? '…' : ''}“`),
        h('span', { class: `badge${s.status === 'accepted' ? ' public' : ''}` }, STATUS[s.status]),
        s.status === 'open' ? h('button', { class: 'link-btn sm', onclick: async () => {
          try { await api('DELETE', `/api/suggestions/${s.id}`); load(); } catch (ex) { toast(ex.message); }
        } }, t('Zurückziehen')) : null))
        : [h('p', { class: 'hint' }, t('Du hast noch nichts vorgeschlagen.'))]));
    } catch (ex) { inc.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  };
  const decide = async (s, action) => {
    try { await api('POST', `/api/suggestions/${s.id}`, { action }); toast(action === 'accept' ? t('Übernommen') : t('Abgelehnt')); load(); onChange?.(); } catch (ex) { toast(ex.message); }
  };
  load();
}

// ---------- Melden ----------
export async function openReport(target, label) {
  let reasons = {};
  try { reasons = (await api('GET', '/api/reasons')).reasons; } catch (ex) { return toast(ex.message); }
  const err = h('p', { class: 'error', role: 'alert' });
  const note = h('textarea', { id: 'rp-note', rows: 2, maxlength: 500, placeholder: t('Was genau ist das Problem? (optional)') });
  let dlg;
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const reason = form.querySelector('input[name=reason]:checked')?.value;
    if (!reason) { err.textContent = t('Bitte einen Grund wählen.'); return; }
    try { await api('POST', '/api/reports', { ...target, reason, note: note.value }); dlg.close(); toast(t('Danke – wir schauen uns das an.')); } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'dialog-head' }, h('h2', {}, t('{0} melden', label)), closeBtn(() => dlg)),
  h('p', { class: 'hint' }, t('Meldungen sehen nur Admins. Die Person erfährt nicht, wer gemeldet hat.')),
  h('div', { class: 'radio-group' }, Object.entries(reasons).map(([v, l]) => h('label', {}, h('input', { type: 'radio', name: 'reason', value: v }), h('span', {}, t(l))))),
  h('label', { for: 'rp-note' }, t('Anmerkung')), note, err,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Abbrechen')), h('button', { class: 'btn primary', type: 'submit' }, t('Melden'))));
  dlg = modal(form);
}

// ---------- Admin-Bereich ----------
export function openAdmin() {
  const body = h('div', { class: 'admin-body' });
  const tabs = [['overview', t('Übersicht')], ['reports', t('Meldungen')], ['users', t('Nutzer')]];
  const seg = h('div', { class: 'seg admin-seg', role: 'tablist' });
  let dlg;
  dlg = modal(h('div', { class: 'dialog-head' }, h('h2', {}, t('Admin-Bereich')), closeBtn(() => dlg)), seg, body);
  dlg.classList.add('admin-dialog');
  const show = (tab) => {
    seg.replaceChildren(...tabs.map(([id, l]) => h('button', { role: 'tab', 'aria-selected': String(id === tab), 'aria-pressed': String(id === tab), onclick: () => show(id) }, l)));
    ({ overview, reports, users })[tab]();
  };
  const fmtBytes = (b) => (b == null ? '–' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

  async function overview() {
    body.replaceChildren(h('p', { class: 'hint' }, t('Wird geladen …')));
    try {
      const o = await api('GET', '/api/admin/overview');
      const tile = (v, l, sub) => h('div', { class: 'stat-tile' }, h('b', {}, String(v)), h('span', {}, l), sub ? h('small', {}, sub) : null);
      body.replaceChildren(h('div', { class: 'stat-tiles' },
        tile(o.users, t('Nutzer'), t('+{0} in 7 Tagen{1}', o.newUsers7d, o.disabled ? t(' · {0} gesperrt', o.disabled) : '')),
        tile(o.quotes, t('Zitate'), t('{0} öffentlich · +{1} in 7 Tagen', o.publicQuotes, o.newQuotes7d)),
        tile(o.openReports, t('offene Meldungen'), o.openReports ? t('bitte prüfen') : 'alles erledigt'),
        tile(fmtBytes(o.dbSize), t('Datenbank'), t('{0} Kommentare · {1} Gruppen · {2} Sammlungen', o.comments, o.groups, o.collections))),
      o.openReports ? h('button', { class: 'btn primary', onclick: () => show('reports') }, t('{0} prüfen', plural(o.openReports, t('Meldung'), t('Meldungen')))) : null);
    } catch (ex) { body.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  }

  async function reports(status = 'open') {
    const filter = h('div', { class: 'subseg' }, [['open', t('Offen')], ['resolved', t('Gelöscht')], ['dismissed', t('Verworfen')]].map(([v, l]) =>
      h('button', { 'aria-pressed': String(v === status), onclick: () => reports(v) }, l)));
    const list = h('div', { class: 'report-list' }, h('p', { class: 'hint' }, t('Wird geladen …')));
    body.replaceChildren(filter, list);
    try {
      const { reports: rs } = await api('GET', `/api/admin/reports?status=${status}`);
      list.replaceChildren(...(rs.length ? rs.map((r) => h('article', { class: 'report' },
        h('div', { class: 'sugg-head' }, h('span', { class: 'badge' }, r.kind === 'comment' ? t('Kommentar') : t('Zitat')), ' ',
          h('b', {}, t(r.reasonLabel)), t(' · von @{0} · {1}', r.reporter, relTime(r.createdAt))),
        h('blockquote', { class: 'report-snap' }, r.snapshot),
        h('p', { class: 'hint' }, t('Verfasst von @{0}{1}', r.target ?? t('gelöschtem Konto'), r.stillExists ? '' : t(' · Inhalt existiert nicht mehr'))),
        r.note ? h('p', { class: 'sugg-note' }, `„${r.note}“`) : null,
        r.status === 'open' ? h('div', { class: 'row left' },
          r.stillExists ? h('button', { class: 'btn danger sm', onclick: () => act(r, 'delete') }, t('Inhalt löschen')) : null,
          h('button', { class: 'btn sm', onclick: () => act(r, 'dismiss') }, t('Verwerfen')))
          : h('p', { class: 'hint' }, t('{0} von @{1} · {2}', r.status === 'resolved' ? t('Gelöscht') : t('Verworfen'), r.resolver ?? '?', fmtDate(r.resolvedAt)))))
        : [h('div', { class: 'empty small' }, h('b', {}, status === 'open' ? t('Keine offenen Meldungen') : t('Nichts hier')))]));
    } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
    async function act(r, action) {
      if (action === 'delete' && !confirm(t('{0} endgültig löschen?', r.kind === 'comment' ? t('Kommentar') : t('Zitat')))) return;
      try { await api('POST', `/api/admin/reports/${r.id}`, { action }); toast(action === 'delete' ? t('Gelöscht') : t('Verworfen')); reports(status); state.reload?.(); } catch (ex) { toast(ex.message); }
    }
  }

  async function users(q = '') {
    const search = h('input', { type: 'search', placeholder: t('Nutzer suchen …'), value: q, 'aria-label': t('Nutzer suchen') });
    let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => draw(search.value), 250); });
    const list = h('div', { class: 'user-list' });
    body.replaceChildren(search, list);
    const draw = async (query) => {
      try {
        const { users: us } = await api('GET', `/api/admin/users?q=${encodeURIComponent(query)}`);
        list.replaceChildren(...us.map((u) => h('div', { class: `admin-user${u.disabled ? ' disabled' : ''}` },
          h('div', {}, h('b', {}, `@${u.username}`), u.admin ? h('span', { class: 'badge public' }, t('Admin')) : null, u.disabled ? h('span', { class: 'badge' }, t('gesperrt')) : null,
            h('small', {}, t('{0} · seit {1}{2}{3}', plural(u.quotes, t('Zitat'), t('Zitate')), fmtDate(u.createdAt), u.sso ? t(' · SSO') : '', u.reports ? ` · ${plural(u.reports, t('Meldung'), t('Meldungen'))}` : ''))),
          u.id === state.user.id ? h('span', { class: 'hint' }, 'du') : h('div', { class: 'row left' },
            h('button', { class: `btn sm${u.disabled ? '' : ' danger'}`, onclick: () => set(u, { disabled: !u.disabled }, u.disabled ? t('entsperren') : t('sperren')) }, u.disabled ? t('Entsperren') : t('Sperren')),
            u.fixedAdmin ? null : h('button', { class: 'btn sm', onclick: () => set(u, { admin: !u.admin }, u.admin ? t('die Admin-Rechte entziehen') : t('zum Admin machen')) }, u.admin ? t('Admin entziehen') : t('Zum Admin'))))));
      } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
    };
    const set = async (u, change, verb) => {
      if (!confirm(t('@{0} {1}?', u.username, verb))) return;
      try { await api('POST', `/api/admin/users/${u.id}`, change); draw(search.value); } catch (ex) { toast(ex.message); }
    };
    draw(q);
  }
  show('overview');
}
