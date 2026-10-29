// Verbesserungsvorschläge, Melden und Admin-Bereich.
import { h, api, toast, modal, icon, plural, relTime, fmtDate, state } from './core.js';

const FIELD = { text: 'Zitat', person: 'Person', source: 'Quelle' };
const closeBtn = (dlg) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Schließen', onclick: () => dlg().close() }, '✕');

// ---------- Korrektur vorschlagen (fremdes Zitat) ----------
export function openSuggest(q) {
  const err = h('p', { class: 'error', role: 'alert' });
  const field = h('select', { id: 'sg-field' }, Object.entries(FIELD).map(([v, l]) => h('option', { value: v }, l)));
  const value = h('textarea', { id: 'sg-value', rows: 3, maxlength: 1000, required: false });
  const note = h('input', { type: 'text', id: 'sg-note', maxlength: 300, placeholder: 'z. B. „Laut Biografie lautet das Original …“ (optional)' });
  const sync = () => { value.value = q[field.value] ?? ''; value.rows = field.value === 'text' ? 4 : 1; };
  field.addEventListener('change', sync); sync();
  let dlg;
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      await api('POST', `/api/quotes/${q.id}/suggestions`, { field: field.value, value: value.value, note: note.value });
      dlg.close(); toast(`Vorschlag an @${q.author} geschickt`);
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'dialog-head' }, h('h2', {}, 'Korrektur vorschlagen'), closeBtn(() => dlg)),
  h('p', { class: 'hint' }, `@${q.author} entscheidet, ob die Änderung übernommen wird.`),
  h('label', { for: 'sg-field' }, 'Was ist falsch?'), field,
  h('label', { for: 'sg-value' }, 'Richtig wäre'), value,
  h('label', { for: 'sg-note' }, 'Begründung / Beleg'), note, err,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'), h('button', { class: 'btn primary', type: 'submit' }, 'Vorschlag senden')));
  dlg = modal(form);
  value.focus();
}

// ---------- Vorschläge verwalten ----------
export async function openSuggestions({ onChange } = {}) {
  const inc = h('div', { class: 'sugg-list' }, h('p', { class: 'hint' }, 'Wird geladen …'));
  const out = h('div', { class: 'sugg-list' });
  let dlg;
  dlg = modal(h('div', { class: 'dialog-head' }, h('h2', {}, 'Vorschläge'), closeBtn(() => dlg)),
    h('h3', { class: 'sub-head' }, 'Zu deinen Zitaten'), inc, h('h3', { class: 'sub-head' }, 'Von dir'), out);
  const STATUS = { open: 'offen', accepted: 'übernommen', rejected: 'abgelehnt' };
  const load = async () => {
    try {
      const { incoming, outgoing } = await api('GET', '/api/suggestions');
      inc.replaceChildren(...(incoming.length ? incoming.map((s) => h('article', { class: 'sugg' },
        h('div', { class: 'sugg-head' }, h('b', {}, `@${s.by}`), ` schlägt für „${FIELD[s.field]}“ vor · ${relTime(s.createdAt)}`),
        h('p', { class: 'hint qpreview' }, `„${s.quoteText}${s.quoteText.length >= 140 ? '…' : ''}“ — ${s.quotePerson}`),
        h('div', { class: 'diff' }, h('del', {}, s.current || '(leer)'), h('ins', {}, s.value || '(leer)')),
        s.note ? h('p', { class: 'sugg-note' }, `„${s.note}“`) : null,
        h('div', { class: 'row left' },
          h('button', { class: 'btn primary sm', onclick: () => decide(s, 'accept') }, 'Übernehmen'),
          h('button', { class: 'btn sm', onclick: () => decide(s, 'reject') }, 'Ablehnen'))))
        : [h('p', { class: 'hint' }, 'Keine offenen Vorschläge.')]));
      out.replaceChildren(...(outgoing.length ? outgoing.map((s) => h('div', { class: 'sugg small' },
        h('span', {}, `${FIELD[s.field]} → „${s.value.slice(0, 60)}${s.value.length > 60 ? '…' : ''}“`),
        h('span', { class: `badge${s.status === 'accepted' ? ' public' : ''}` }, STATUS[s.status]),
        s.status === 'open' ? h('button', { class: 'link-btn sm', onclick: async () => {
          try { await api('DELETE', `/api/suggestions/${s.id}`); load(); } catch (ex) { toast(ex.message); }
        } }, 'Zurückziehen') : null))
        : [h('p', { class: 'hint' }, 'Du hast noch nichts vorgeschlagen.')]));
    } catch (ex) { inc.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  };
  const decide = async (s, action) => {
    try { await api('POST', `/api/suggestions/${s.id}`, { action }); toast(action === 'accept' ? 'Übernommen' : 'Abgelehnt'); load(); onChange?.(); } catch (ex) { toast(ex.message); }
  };
  load();
}

// ---------- Melden ----------
export async function openReport(target, label) {
  let reasons = {};
  try { reasons = (await api('GET', '/api/reasons')).reasons; } catch (ex) { return toast(ex.message); }
  const err = h('p', { class: 'error', role: 'alert' });
  const note = h('textarea', { id: 'rp-note', rows: 2, maxlength: 500, placeholder: 'Was genau ist das Problem? (optional)' });
  let dlg;
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const reason = form.querySelector('input[name=reason]:checked')?.value;
    if (!reason) { err.textContent = 'Bitte einen Grund wählen.'; return; }
    try { await api('POST', '/api/reports', { ...target, reason, note: note.value }); dlg.close(); toast('Danke – wir schauen uns das an.'); } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'dialog-head' }, h('h2', {}, `${label} melden`), closeBtn(() => dlg)),
  h('p', { class: 'hint' }, 'Meldungen sehen nur Admins. Die Person erfährt nicht, wer gemeldet hat.'),
  h('div', { class: 'radio-group' }, Object.entries(reasons).map(([v, l]) => h('label', {}, h('input', { type: 'radio', name: 'reason', value: v }), h('span', {}, l)))),
  h('label', { for: 'rp-note' }, 'Anmerkung'), note, err,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'), h('button', { class: 'btn primary', type: 'submit' }, 'Melden')));
  dlg = modal(form);
}

// ---------- Admin-Bereich ----------
export function openAdmin() {
  const body = h('div', { class: 'admin-body' });
  const tabs = [['overview', 'Übersicht'], ['reports', 'Meldungen'], ['users', 'Nutzer']];
  const seg = h('div', { class: 'seg admin-seg', role: 'tablist' });
  let dlg;
  dlg = modal(h('div', { class: 'dialog-head' }, h('h2', {}, 'Admin-Bereich'), closeBtn(() => dlg)), seg, body);
  dlg.classList.add('admin-dialog');
  const show = (tab) => {
    seg.replaceChildren(...tabs.map(([id, l]) => h('button', { role: 'tab', 'aria-selected': String(id === tab), 'aria-pressed': String(id === tab), onclick: () => show(id) }, l)));
    ({ overview, reports, users })[tab]();
  };
  const fmtBytes = (b) => (b == null ? '–' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

  async function overview() {
    body.replaceChildren(h('p', { class: 'hint' }, 'Wird geladen …'));
    try {
      const o = await api('GET', '/api/admin/overview');
      const tile = (v, l, sub) => h('div', { class: 'stat-tile' }, h('b', {}, String(v)), h('span', {}, l), sub ? h('small', {}, sub) : null);
      body.replaceChildren(h('div', { class: 'stat-tiles' },
        tile(o.users, 'Nutzer', `+${o.newUsers7d} in 7 Tagen${o.disabled ? ` · ${o.disabled} gesperrt` : ''}`),
        tile(o.quotes, 'Zitate', `${o.publicQuotes} öffentlich · +${o.newQuotes7d} in 7 Tagen`),
        tile(o.openReports, 'offene Meldungen', o.openReports ? 'bitte prüfen' : 'alles erledigt'),
        tile(fmtBytes(o.dbSize), 'Datenbank', `${o.comments} Kommentare · ${o.groups} Gruppen · ${o.collections} Sammlungen`)),
      o.openReports ? h('button', { class: 'btn primary', onclick: () => show('reports') }, `${plural(o.openReports, 'Meldung', 'Meldungen')} prüfen`) : null);
    } catch (ex) { body.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  }

  async function reports(status = 'open') {
    const filter = h('div', { class: 'subseg' }, [['open', 'Offen'], ['resolved', 'Gelöscht'], ['dismissed', 'Verworfen']].map(([v, l]) =>
      h('button', { 'aria-pressed': String(v === status), onclick: () => reports(v) }, l)));
    const list = h('div', { class: 'report-list' }, h('p', { class: 'hint' }, 'Wird geladen …'));
    body.replaceChildren(filter, list);
    try {
      const { reports: rs } = await api('GET', `/api/admin/reports?status=${status}`);
      list.replaceChildren(...(rs.length ? rs.map((r) => h('article', { class: 'report' },
        h('div', { class: 'sugg-head' }, h('span', { class: 'badge' }, r.kind === 'comment' ? 'Kommentar' : 'Zitat'), ' ',
          h('b', {}, r.reasonLabel), ` · von @${r.reporter} · ${relTime(r.createdAt)}`),
        h('blockquote', { class: 'report-snap' }, r.snapshot),
        h('p', { class: 'hint' }, `Verfasst von @${r.target ?? 'gelöschtem Konto'}${r.stillExists ? '' : ' · Inhalt existiert nicht mehr'}`),
        r.note ? h('p', { class: 'sugg-note' }, `„${r.note}“`) : null,
        r.status === 'open' ? h('div', { class: 'row left' },
          r.stillExists ? h('button', { class: 'btn danger sm', onclick: () => act(r, 'delete') }, 'Inhalt löschen') : null,
          h('button', { class: 'btn sm', onclick: () => act(r, 'dismiss') }, 'Verwerfen'))
          : h('p', { class: 'hint' }, `${r.status === 'resolved' ? 'Gelöscht' : 'Verworfen'} von @${r.resolver ?? '?'} · ${fmtDate(r.resolvedAt)}`)))
        : [h('div', { class: 'empty small' }, h('b', {}, status === 'open' ? 'Keine offenen Meldungen' : 'Nichts hier'))]));
    } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
    async function act(r, action) {
      if (action === 'delete' && !confirm(`${r.kind === 'comment' ? 'Kommentar' : 'Zitat'} endgültig löschen?`)) return;
      try { await api('POST', `/api/admin/reports/${r.id}`, { action }); toast(action === 'delete' ? 'Gelöscht' : 'Verworfen'); reports(status); state.reload?.(); } catch (ex) { toast(ex.message); }
    }
  }

  async function users(q = '') {
    const search = h('input', { type: 'search', placeholder: 'Nutzer suchen …', value: q, 'aria-label': 'Nutzer suchen' });
    let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => draw(search.value), 250); });
    const list = h('div', { class: 'user-list' });
    body.replaceChildren(search, list);
    const draw = async (query) => {
      try {
        const { users: us } = await api('GET', `/api/admin/users?q=${encodeURIComponent(query)}`);
        list.replaceChildren(...us.map((u) => h('div', { class: `admin-user${u.disabled ? ' disabled' : ''}` },
          h('div', {}, h('b', {}, `@${u.username}`), u.admin ? h('span', { class: 'badge public' }, 'Admin') : null, u.disabled ? h('span', { class: 'badge' }, 'gesperrt') : null,
            h('small', {}, `${plural(u.quotes, 'Zitat', 'Zitate')} · seit ${fmtDate(u.createdAt)}${u.sso ? ' · SSO' : ''}${u.reports ? ` · ${plural(u.reports, 'Meldung', 'Meldungen')}` : ''}`)),
          u.id === state.user.id ? h('span', { class: 'hint' }, 'du') : h('div', { class: 'row left' },
            h('button', { class: `btn sm${u.disabled ? '' : ' danger'}`, onclick: () => set(u, { disabled: !u.disabled }, u.disabled ? 'entsperren' : 'sperren') }, u.disabled ? 'Entsperren' : 'Sperren'),
            u.fixedAdmin ? null : h('button', { class: 'btn sm', onclick: () => set(u, { admin: !u.admin }, u.admin ? 'die Admin-Rechte entziehen' : 'zum Admin machen') }, u.admin ? 'Admin entziehen' : 'Zum Admin')))));
      } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
    };
    const set = async (u, change, verb) => {
      if (!confirm(`@${u.username} ${verb}?`)) return;
      try { await api('POST', `/api/admin/users/${u.id}`, change); draw(search.value); } catch (ex) { toast(ex.message); }
    };
    draw(q);
  }
  show('overview');
}
