// Gruppen: Übersicht, Verwaltung (Rollen, Einladungen, Übertragen), Einladungs-Seite.
import { h, api, toast, modal, icon, plural, fmtDate, chipInput, state, avatar, popMenu, $app, t, LOCALE, LANG } from './core.js';

const ROLE = { owner: t('Besitzer'), admin: t('Admin'), member: t('Mitglied') };

export async function openGroups() {
  const list = h('div', { class: 'group-list' }, h('p', { class: 'hint' }, t('Wird geladen …')));
  const err = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { type: 'text', id: 'g-name', required: true, maxlength: 50, placeholder: t('z. B. Lesekreis') });
  const members = chipInput({ id: 'g-members' });
  const create = h('button', { class: 'btn primary', type: 'submit' }, t('Gruppe erstellen'));
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, t('Gruppen')), h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg.close() }, '✕')),
    h('p', { class: 'hint' }, t('Teile Zitate und Sammlungen mit allen Mitgliedern einer Gruppe auf einmal.')),
    list,
    h('details', { class: 'new-group' }, h('summary', {}, t('+ Neue Gruppe')),
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault(); err.textContent = ''; create.disabled = true;
          try {
            const g = await api('POST', '/api/groups', { name: name.value, members: members.values() });
            dlg.close(); toast(t('Gruppe „{0}“ erstellt', g.name)); openGroup(g.id);
          } catch (ex) { err.textContent = ex.message; create.disabled = false; }
        },
      }, h('label', { for: 'g-name' }, t('Name')), name, h('label', { for: 'g-members' }, t('Mitglieder (optional – oder später per Einladungslink)')), members.el, err,
      h('div', { class: 'row' }, create))));
  try {
    const { groups } = await api('GET', '/api/groups');
    if (!groups.length) dlg.querySelector('details').open = true;
    list.replaceChildren(...(groups.length ? groups.map((g) => h('button', { class: 'group-item', onclick: () => { dlg.close(); openGroup(g.id); } },
      h('span', { class: 'group-name' }, g.name),
      h('span', { class: 'hint' }, plural(g.memberCount, t('Mitglied'), t('Mitglieder')) + (g.role !== 'member' ? ` · ${ROLE[g.role]}` : '')), h('span', { 'aria-hidden': 'true' }, '›')))
      : [h('p', { class: 'hint' }, t('Du bist noch in keiner Gruppe.'))]));
  } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
}

export async function openGroup(id) {
  let g;
  try { g = await api('GET', `/api/groups/${id}`); } catch (ex) { return toast(ex.message); }
  const body = h('div');
  const dlg = modal(body);
  dlg.classList.add('group-dialog');
  const close = () => dlg.close();
  const refresh = async () => { try { g = await api('GET', `/api/groups/${id}`); draw(); } catch (ex) { close(); toast(ex.message); } };
  const leaveGroupView = () => { if (state.group?.id === id) { state.scope = 'feed'; state.group = null; } state.reload?.(); };

  function memberRow(m) {
    const me = m.id === state.user.id;
    const canRemove = !me && m.role !== 'owner' && (g.myRole === 'owner' || (g.myRole === 'admin' && m.role === 'member'));
    const actions = [];
    if (g.myRole === 'owner' && m.role !== 'owner') {
      actions.push(['users', m.role === 'admin' ? t('Admin-Rechte entziehen') : t('Zum Admin machen'), async () => {
        try { g = await api('PATCH', `/api/groups/${id}/members/${m.id}`, { role: m.role === 'admin' ? 'member' : 'admin' }); draw(); } catch (ex) { toast(ex.message); }
      }]);
      actions.push(['user', t('Besitz übertragen …'), async () => {
        if (!confirm(t('Gruppe „{0}“ an @{1} übertragen? Du wirst danach Admin.', g.name, m.username))) return;
        try { g = await api('POST', `/api/groups/${id}/transfer`, { userId: m.id }); draw(); toast(t('@{0} ist jetzt Besitzer', m.username)); } catch (ex) { toast(ex.message); }
      }]);
    }
    if (canRemove) {
      actions.push(['trash', t('Aus der Gruppe entfernen'), async () => {
        if (!confirm(t('@{0} aus der Gruppe entfernen?', m.username))) return;
        try { await api('DELETE', `/api/groups/${id}/members/${m.id}`); refresh(); } catch (ex) { toast(ex.message); }
      }, 'danger']);
    }
    return h('li', {}, avatar(m.username),
      h('span', {}, `@${m.username}`, me ? h('small', {}, ' (du)') : null),
      m.role !== 'member' ? h('span', { class: `badge${m.role === 'owner' ? ' public' : ''}` }, ROLE[m.role]) : null,
      actions.length ? h('button', { class: 'act', 'aria-label': t('Aktionen für @{0}', m.username), 'aria-haspopup': 'menu',
        onclick: (e) => popMenu(e.currentTarget, actions) }, icon('more')) : null);
  }

  function draw() {
    const add = chipInput({ id: 'gm-add' });
    const err = h('p', { class: 'error', role: 'alert' });
    const rename = g.canManage ? h('button', { class: 'btn ghost sm', onclick: async () => {
      const n = prompt(t('Neuer Gruppenname'), g.name);
      if (n == null) return;
      try { g = await api('PATCH', `/api/groups/${id}`, { name: n }); if (state.group?.id === id) state.group.name = g.name; draw(); state.reload?.(); } catch (ex) { toast(ex.message); }
    } }, t('Umbenennen')) : null;
    body.replaceChildren(
      h('div', { class: 'dialog-head' }, h('h2', {}, g.name), h('div', { class: 'head-actions' }, rename,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: close }, '✕'))),
      h('p', { class: 'hint' }, t('Deine Rolle: {0}', ROLE[g.myRole])),
      h('button', { class: 'btn primary block', onclick: () => { close(); state.showGroup?.(g); } }, t('Zitate der Gruppe ansehen')),
      h('label', {}, plural(g.members.length, t('Mitglied'), t('Mitglieder'))),
      h('ul', { class: 'members' }, g.members.map(memberRow)),
      g.canManage ? h('form', {
        onsubmit: async (e) => {
          e.preventDefault(); err.textContent = '';
          const usernames = add.values();
          if (!usernames.length) return;
          try { g = await api('POST', `/api/groups/${id}/members`, { usernames }); draw(); toast(t('Hinzugefügt')); } catch (ex) { err.textContent = ex.message; }
        },
      }, h('label', { for: 'gm-add' }, t('Mitglieder hinzufügen')), add.el, err, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('Hinzufügen')))) : null,
      g.canManage ? invitesSection(id) : null,
      h('div', { class: 'row split' },
        g.myRole === 'owner'
          ? h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(t('Gruppe „{0}“ löschen? Mit ihr geteilte Zitate und Sammlungen sind dann für die Mitglieder nicht mehr sichtbar.', g.name))) return;
            try { await api('DELETE', `/api/groups/${id}`); close(); toast(t('Gruppe gelöscht')); leaveGroupView(); } catch (ex) { toast(ex.message); }
          } }, t('Gruppe löschen'))
          : h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(t('Gruppe „{0}“ verlassen?', g.name))) return;
            try { await api('DELETE', `/api/groups/${id}/members/${state.user.id}`); close(); toast(t('Gruppe verlassen')); leaveGroupView(); } catch (ex) { toast(ex.message); }
          } }, t('Gruppe verlassen')),
        h('button', { class: 'btn', type: 'button', onclick: close }, t('Schließen'))));
  }
  draw();
}

/** Einladungslinks: erstellen (Gültigkeit, Nutzungen), kopieren, widerrufen. */
function invitesSection(gid) {
  const list = h('div', { class: 'invite-list' });
  const days = h('select', { 'aria-label': t('Gültigkeit') }, [[1, t('1 Tag')], [7, t('7 Tage')], [30, t('30 Tage')]].map(([v, l]) => h('option', { value: v, selected: v === 7 }, l)));
  const uses = h('select', { 'aria-label': t('Maximale Nutzungen') }, [['', t('unbegrenzt')], [1, '1×'], [5, '5×'], [20, '20×']].map(([v, l]) => h('option', { value: v }, l)));
  const fresh = h('div', { class: 'fresh-invite' });
  const load = async () => {
    try {
      const { invites } = await api('GET', `/api/groups/${gid}/invites`);
      list.replaceChildren(...invites.map((i) => h('div', { class: 'invite' },
        h('span', {}, t('gültig bis {0}', fmtDate(i.expiresAt)), ' · ',
          i.maxUses ? t('{0}/{1} genutzt', i.uses, i.maxUses) : t('{0}× genutzt', i.uses), t(' · von @'), i.createdBy),
        h('button', { class: 'link-btn sm', type: 'button', onclick: async () => {
          try { await api('DELETE', `/api/groups/${gid}/invites/${i.id}`); load(); toast(t('Einladung widerrufen')); } catch (ex) { toast(ex.message); }
        } }, t('Widerrufen')))));
    } catch { /* optional */ }
  };
  const create = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try {
      const r = await api('POST', `/api/groups/${gid}/invites`, { days: Number(days.value), maxUses: uses.value ? Number(uses.value) : null });
      const url = new URL(r.link, location.origin).toString();
      const field = h('input', { type: 'text', readonly: true, value: url, 'aria-label': t('Einladungslink'), onfocus: (e) => e.target.select() });
      fresh.replaceChildren(h('p', { class: 'hint' }, t('Neuer Link – nur jetzt sichtbar, also gleich kopieren:')),
        h('div', { class: 'linkbox' }, field, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(url); toast(t('Link kopiert')); } catch { field.select(); }
        } }, t('Kopieren'))),
        navigator.share ? h('button', { class: 'btn sm', type: 'button', onclick: () => navigator.share({ title: t('Einladung'), url }).catch(() => {}) }, t('Teilen …')) : null);
      load();
    } catch (ex) { toast(ex.message); }
  } }, icon('link', { size: 16 }), h('span', {}, t('Link erstellen')));
  load();
  return h('section', { class: 'acc-section' }, h('label', {}, t('Per Link einladen')),
    h('p', { class: 'hint' }, t('Wer den Link öffnet und angemeldet ist, kann der Gruppe beitreten.')),
    h('div', { class: 'invite-create' }, days, uses, create), fresh, list);
}

/** Seite /g/<token>: Einladung ansehen und annehmen (nach dem Login). */
export async function renderInvite(token, { onDone } = {}) {
  const box = h('div', { class: 'card invite-card' }, h('p', { class: 'hint' }, t('Einladung wird geladen …')));
  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'public-page' },
    h('a', { class: 'logo auth-logo', href: '/' }, h('i', {}, '“'), t('Quotes')), box)));
  try {
    const inv = await api('GET', `/api/invites/${encodeURIComponent(token)}`);
    const join = h('button', { class: 'btn primary block', onclick: async () => {
      join.disabled = true;
      try {
        const g = await api('POST', `/api/invites/${encodeURIComponent(token)}/accept`);
        history.replaceState(null, '', '/'); toast(t('Willkommen in „{0}“', g.name)); onDone?.(g);
      } catch (ex) { toast(ex.message); join.disabled = false; }
    } }, inv.alreadyMember ? t('Zur Gruppe') : t('Gruppe beitreten'));
    if (inv.alreadyMember) join.onclick = () => { history.replaceState(null, '', '/'); onDone?.(inv.group); };
    box.replaceChildren(h('span', { class: 'daily-label' }, t('Einladung')), h('h1', { class: 'invite-title' }, inv.group.name),
      h('p', {}, t('@{0} lädt dich ein · {1}', inv.invitedBy, plural(inv.group.members, t('Mitglied'), t('Mitglieder')))),
      inv.alreadyMember ? h('p', { class: 'hint' }, t('Du bist bereits Mitglied.')) : null,
      join, h('a', { class: 'btn ghost block', href: '/' }, t('Nicht jetzt')));
  } catch (ex) {
    box.replaceChildren(h('b', {}, t('Einladung nicht verfügbar')), h('p', {}, ex.message), h('a', { class: 'btn', href: '/' }, t('Zur Startseite')));
  }
}
