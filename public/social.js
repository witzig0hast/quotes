// Kommentare, Profile/Folgen, Statistik und der Dialog für die erweiterte Suche.
import { h, api, toast, modal, icon, plural, relTime, fmtDate, avatar, state } from './core.js';
import { openReport } from './moderation.js';

// ---------- Kommentare ----------
export async function openComments(q, { onCount } = {}) {
  const list = h('div', { class: 'comments' }, h('p', { class: 'hint' }, 'Wird geladen …'));
  const err = h('p', { class: 'error', role: 'alert' });
  const input = h('textarea', { id: 'cm-body', rows: 2, maxlength: 1000, placeholder: 'Schreib etwas … (@name erwähnt jemanden)', required: true });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Senden');
  let count = 0;
  const draw = (comments) => {
    count = comments.length; onCount?.(count);
    list.replaceChildren(...(comments.length ? comments.map((c) => commentEl(c)) : [h('p', { class: 'hint empty-comments' }, 'Noch keine Kommentare – schreib den ersten.')]));
  };
  const commentEl = (c) => {
    const el = h('article', { class: `comment${c.mine ? ' mine' : ''}` }, avatar(c.author),
      h('div', { class: 'comment-body' },
        h('div', { class: 'comment-head' }, h('b', {}, c.mine ? 'Du' : `@${c.author}`), h('span', {}, relTime(c.createdAt)),
          c.canDelete ? h('button', { class: 'link-btn sm', type: 'button', 'aria-label': 'Kommentar löschen', onclick: async () => {
            if (!confirm('Kommentar löschen?')) return;
            try { await api('DELETE', `/api/comments/${c.id}`); el.remove(); onCount?.(--count); if (!list.querySelector('.comment')) draw([]); } catch (ex) { toast(ex.message); }
          } }, 'Löschen') : null,
          !c.mine ? h('button', { class: 'link-btn sm', type: 'button', 'aria-label': 'Kommentar melden', onclick: () => openReport({ commentId: c.id }, 'Kommentar') }, 'Melden') : null),
        h('p', {}, ...withMentions(c.body))));
    return el;
  };
  const form = h('form', {
    class: 'comment-form',
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } },
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; send.disabled = true;
      try {
        const c = await api('POST', `/api/quotes/${q.id}/comments`, { body: input.value });
        list.querySelector('.empty-comments')?.remove();
        list.append(commentEl(c)); onCount?.(++count); input.value = '';
        list.lastElementChild.scrollIntoView({ block: 'nearest' });
      } catch (ex) { err.textContent = ex.message; } finally { send.disabled = false; input.focus(); }
    },
  }, input, h('div', { class: 'comment-actions' }, err, send));
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Kommentare'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Schließen', onclick: () => dlg.close() }, '✕')),
    h('p', { class: 'hint qpreview' }, `„${q.text.slice(0, 140)}${q.text.length > 140 ? '…' : ''}“ — ${q.person}`),
    list, form);
  dlg.classList.add('comments-dialog');
  try { draw((await api('GET', `/api/quotes/${q.id}/comments`)).comments); } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  input.focus();
}

/** Text mit hervorgehobenen @Erwähnungen (als Textknoten, kein HTML). */
function withMentions(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/@([A-Za-z0-9_.-]{3,30})/g)) {
    out.push(text.slice(last, m.index));
    out.push(h('button', { class: 'mention-link', type: 'button', onclick: () => { document.querySelector('dialog[open]')?.close(); state.showProfile?.(m[1]); } }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

// ---------- Profil ----------
export async function profileHeader(username) {
  const box = h('section', { class: 'profile-head' }, h('div', { class: 'card skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
  try {
    const p = await api('GET', `/api/users/${encodeURIComponent(username)}`);
    const btn = p.isMe ? null : h('button', { class: `btn ${p.isFollowing ? '' : 'primary'}`, onclick: async () => {
      btn.disabled = true;
      try {
        const r = await api(p.isFollowing ? 'DELETE' : 'POST', `/api/users/${encodeURIComponent(p.username)}/follow`);
        p.isFollowing = r.following; p.followers += r.following ? 1 : -1;
        btn.className = `btn ${p.isFollowing ? '' : 'primary'}`; btn.textContent = p.isFollowing ? 'Folge ich' : 'Folgen';
        followers.textContent = plural(p.followers, 'Follower', 'Follower');
        toast(r.following ? `Du folgst jetzt @${p.username}` : `Du folgst @${p.username} nicht mehr`);
      } catch (ex) { toast(ex.message); } finally { btn.disabled = false; }
    } }, p.isFollowing ? 'Folge ich' : 'Folgen');
    const followers = h('span', {}, plural(p.followers, 'Follower', 'Follower'));
    box.replaceChildren(avatar(p.username),
      h('div', { class: 'profile-body' },
        h('span', { class: 'daily-label' }, p.isMe ? 'Dein Profil' : 'Profil'),
        h('h2', {}, `@${p.username}`),
        h('p', { class: 'person-stats' }, h('span', {}, plural(p.quotes, 'Zitat', 'Zitate')), ' · ', followers, ' · ',
          h('span', {}, `folgt ${p.following}`), ' · ', h('span', {}, `dabei seit ${fmtDate(p.joinedAt)}`)),
        p.followsYou ? h('span', { class: 'badge' }, 'Folgt dir') : null,
        p.tags.length ? h('div', { class: 'tags' }, p.tags.map((t) => h('span', { class: 'tag static' }, `#${t.tag}`))) : null),
      btn);
  } catch (ex) { box.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  return box;
}

// ---------- Statistik ----------
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

export async function openStats() {
  const body = h('div', { class: 'stats' }, h('p', { class: 'hint' }, 'Wird berechnet …'));
  const dlg = modal(h('div', { class: 'dialog-head' }, h('h2', {}, 'Deine Statistik'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Schließen', onclick: () => dlg.close() }, '✕')), body);
  dlg.classList.add('stats-dialog');
  try {
    const s = await api('GET', '/api/stats');
    const tile = (value, label, sub) => h('div', { class: 'stat-tile' }, h('b', {}, String(value)), h('span', {}, label), sub ? h('small', {}, sub) : null);
    const max = Math.max(1, ...s.perMonth.map((m) => m.count));
    const monthName = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
    // Einreihiges Balkendiagramm: dünne Balken, oben gerundet, auf der Grundlinie; Wert per Tooltip/Fokus, Tabelle für Screenreader
    const chart = h('div', { class: 'bars', role: 'img', 'aria-label': `Zitate pro Monat, letzte 12 Monate. Höchstwert ${max}.` },
      s.perMonth.map((m) => h('div', { class: 'bar-col', tabindex: 0, 'data-tip': `${monthName(m.month)}: ${plural(m.count, 'Zitat', 'Zitate')}` },
        h('div', { class: `bar${m.count ? '' : ' zero'}`, style: null, 'data-h': Math.round((m.count / max) * 100) }),
        h('span', { class: 'bar-label' }, MONTHS[Number(m.month.slice(5)) - 1].slice(0, 1)))));
    // Höhe per CSSOM setzen (inline-style-Attribute sind per CSP verboten)
    chart.querySelectorAll('.bar').forEach((b) => { b.style.height = `${Math.max(Number(b.dataset.h), 2)}%`; });
    const table = h('table', { class: 'visually-hidden' }, h('caption', {}, 'Zitate pro Monat'),
      h('tr', {}, h('th', { scope: 'col' }, 'Monat'), h('th', { scope: 'col' }, 'Zitate')),
      s.perMonth.map((m) => h('tr', {}, h('td', {}, monthName(m.month)), h('td', {}, String(m.count)))));
    const rankList = (items, fmt) => h('ol', { class: 'rank' }, items.map((i) => h('li', {}, h('span', {}, fmt(i)), h('b', {}, String(i.count)))));
    body.replaceChildren(
      h('div', { class: 'stat-tiles' },
        tile(s.total, 'Zitate', `${s.byVisibility.public} öffentlich · ${s.byVisibility.shared} geteilt · ${s.byVisibility.private} privat`),
        tile(s.streak.current, s.streak.current === 1 ? 'Tag in Folge' : 'Tage in Folge', s.streak.activeToday ? 'heute schon gesammelt ✓' : s.streak.current ? 'heute noch offen' : `Rekord: ${s.streak.longest}`),
        tile(s.likesReceived, 'Herzen erhalten', `${s.likesGiven} vergeben`),
        tile(s.followers, 'Follower', `${plural(s.comments, 'Kommentar', 'Kommentare')} · ${plural(s.collections, 'Sammlung', 'Sammlungen')}`)),
      h('h3', {}, 'Zitate pro Monat'), chart, table,
      h('div', { class: 'stat-cols' },
        h('div', {}, h('h3', {}, 'Am häufigsten zitiert'), s.topPeople.length ? rankList(s.topPeople, (p) => p.name) : h('p', { class: 'hint' }, 'Noch keine Zitate.')),
        h('div', {}, h('h3', {}, 'Deine Tags'), s.topTags.length ? rankList(s.topTags, (t) => `#${t.tag}`) : h('p', { class: 'hint' }, 'Noch keine Tags.'))));
  } catch (ex) { body.replaceChildren(h('p', { class: 'error' }, ex.message)); }
}

// ---------- Erweiterte Suche ----------
export function openFilters(current, apply) {
  const from = h('input', { type: 'date', id: 'flt-from', value: current.from ?? '' });
  const to = h('input', { type: 'date', id: 'flt-to', value: current.to ?? '' });
  const person = h('input', { type: 'text', id: 'flt-person', maxlength: 100, placeholder: 'z. B. Marie Curie', value: current.person ?? '' });
  const tag = h('input', { type: 'text', id: 'flt-tag', maxlength: 31, placeholder: 'z. B. mut', value: current.tag ? `#${current.tag}` : '' });
  const vis = h('select', { id: 'flt-vis' }, [['', 'Alle'], ['private', 'Privat'], ['shared', 'Geteilt'], ['public', 'Öffentlich']]
    .map(([v, l]) => h('option', { value: v, selected: (current.vis ?? '') === v }, l)));
  const quick = (days) => h('button', { class: 'fchip', type: 'button', onclick: () => {
    const d = new Date(Date.now() - days * 86_400_000); from.value = d.toISOString().slice(0, 10); to.value = '';
  } }, days === 7 ? 'Letzte 7 Tage' : days === 30 ? 'Letzte 30 Tage' : 'Letztes Jahr');
  let dlg;
  const form = h('form', { onsubmit: (e) => {
    e.preventDefault();
    const t = tag.value.trim().replace(/^#+/, '').toLowerCase();
    apply({ from: from.value || null, to: to.value || null, person: person.value.trim() || null, tag: t || null, vis: vis.value || null });
    dlg.close();
  } },
  h('div', { class: 'dialog-head' }, h('h2', {}, 'Filter'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Schließen', onclick: () => dlg.close() }, '✕')),
  h('label', {}, 'Zeitraum (gespeichert am)'), h('div', { class: 'grid2' }, h('div', {}, h('label', { for: 'flt-from', class: 'sub' }, 'von'), from), h('div', {}, h('label', { for: 'flt-to', class: 'sub' }, 'bis'), to)),
  h('div', { class: 'filters quick' }, quick(7), quick(30), quick(365)),
  h('div', { class: 'grid2' }, h('div', {}, h('label', { for: 'flt-person' }, 'Person'), person), h('div', {}, h('label', { for: 'flt-tag' }, 'Tag'), tag)),
  state.scope === 'mine' ? [h('label', { for: 'flt-vis' }, 'Sichtbarkeit'), vis] : null,
  h('div', { class: 'row split' },
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { apply({ from: null, to: null, person: null, tag: null, vis: null }); dlg.close(); } }, 'Zurücksetzen'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Anwenden')));
  dlg = modal(form);
}
