// Sammlungen: Übersicht, Anlegen/Bearbeiten, "Zu Sammlung hinzufügen", Freigabe-Link, öffentliche Seite.
import { h, api, toast, modal, icon, plural, relTime, fmtDate, $app, t, LOCALE, LANG, quoteText } from './core.js';

/** Raster mit allen sichtbaren Sammlungen; onOpen(c) öffnet eine Sammlung. */
export async function collectionsView(onOpen) {
  const wrap = h('div', { class: 'coll-grid' }, h('div', { class: 'card skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  try {
    const { collections } = await api('GET', '/api/collections');
    const add = h('button', { class: 'coll-card coll-new', onclick: () => openCollectionEditor(null, (c) => onOpen(c)) },
      icon('plus', { size: 28 }), h('b', {}, t('Neue Sammlung')), h('span', {}, t('z. B. „Für schlechte Tage“')));
    if (!collections.length) {
      wrap.replaceChildren(h('div', { class: 'empty' }, h('b', {}, t('Noch keine Sammlungen')),
        h('p', {}, t('Ordne Zitate in Listen – für eine Rede, ein Geschenk oder einfach für dich. Teilen kannst du sie mit Gruppen oder per Link.')),
        h('button', { class: 'btn primary', onclick: () => openCollectionEditor(null, (c) => onOpen(c)) }, t('+ Erste Sammlung anlegen'))));
      return wrap;
    }
    wrap.replaceChildren(add, ...collections.map((c) => h('button', { class: 'coll-card', onclick: () => onOpen(c) },
      h('span', { class: 'coll-icon' }, icon('folder')),
      h('b', {}, c.name),
      c.description ? h('span', { class: 'coll-desc' }, c.description) : null,
      h('span', { class: 'coll-meta' }, plural(c.count, t('Zitat'), t('Zitate')),
        c.isOwner ? null : t(' · von @{0}', c.owner),
        c.isOwner && c.groups?.length ? ` · ${plural(c.groups.length, t('Gruppe'), t('Gruppen'))}` : null,
        c.isOwner && c.link ? t(' · Link') : null))));
  } catch (ex) { wrap.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  return wrap;
}

/** Anlegen (c = null) oder Bearbeiten einer Sammlung. */
export async function openCollectionEditor(c, onSaved, onDeleted) {
  const err = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { type: 'text', id: 'c-name', required: true, maxlength: 60, placeholder: t('z. B. Hochzeitsrede') }); name.value = c?.name ?? '';
  const desc = h('textarea', { id: 'c-desc', maxlength: 300, rows: 2, placeholder: t('Wofür ist diese Sammlung? (optional)') }); desc.value = c?.description ?? '';
  const groupBox = h('div', { class: 'check-group' }, h('span', { class: 'hint' }, t('Gruppen werden geladen …')));
  const save = h('button', { class: 'btn primary', type: 'submit' }, c ? t('Speichern') : t('Anlegen'));
  let dlg;
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; save.disabled = true;
      const body = { name: name.value, description: desc.value, groups: [...groupBox.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
      try {
        const saved = await (c ? api('PATCH', `/api/collections/${c.id}`, body) : api('POST', '/api/collections', body));
        dlg.close(); toast(c ? t('Gespeichert') : t('Sammlung „{0}“ angelegt', saved.name)); onSaved?.(saved);
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    },
  },
  h('div', { class: 'dialog-head' }, h('h2', {}, c ? t('Sammlung bearbeiten') : t('Neue Sammlung')),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg.close() }, '✕')),
  h('label', { for: 'c-name' }, t('Name')), name,
  h('label', { for: 'c-desc' }, t('Beschreibung')), desc,
  h('label', {}, t('Mit Gruppen teilen')), groupBox,
  h('div', { class: 'hint' }, t('Gruppenmitglieder sehen die Sammlung – darin deine eigenen Zitate und alle, die sie ohnehin sehen dürfen.')),
  err,
  h('div', { class: 'row split' },
    c ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!confirm(t('Sammlung „{0}“ löschen? Die Zitate selbst bleiben erhalten.', c.name))) return;
      try { await api('DELETE', `/api/collections/${c.id}`); dlg.close(); toast(t('Sammlung gelöscht')); onDeleted?.(); } catch (ex) { toast(ex.message); }
    } }, t('Löschen')) : h('span'),
    save));
  dlg = modal(form);
  name.focus();
  try {
    const { groups } = await api('GET', '/api/groups');
    const selected = new Set((c?.groups ?? []).map((g) => g.id));
    groupBox.replaceChildren(...(groups.length
      ? groups.map((g) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: g.id, checked: selected.has(g.id) }),
        h('span', {}, g.name, h('small', {}, plural(g.memberCount, t('Mitglied'), t('Mitglieder'))))))
      : [h('span', { class: 'hint' }, t('Du bist in keiner Gruppe – die Sammlung bleibt privat (Teilen per Link geht trotzdem).'))]));
  } catch { groupBox.replaceChildren(h('span', { class: 'hint' }, t('Gruppen konnten nicht geladen werden.'))); }
}

/** Zitat zu eigenen Sammlungen hinzufügen / daraus entfernen (Häkchen wirken sofort). */
export async function openAddToCollection(q) {
  const list = h('div', { class: 'check-group' }, h('span', { class: 'hint' }, t('Wird geladen …')));
  const newName = h('input', { type: 'text', maxlength: 60, placeholder: t('Neue Sammlung …'), 'aria-label': t('Name der neuen Sammlung') });
  const dlg = modal(
    h('div', { class: 'dialog-head' }, h('h2', {}, t('Zu Sammlung hinzufügen')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg.close() }, '✕')),
    h('p', { class: 'hint qpreview' }, `„${q.text.slice(0, 120)}${q.text.length > 120 ? '…' : ''}“ — ${q.person}`),
    list,
    h('form', { class: 'linkbox new-coll', onsubmit: async (e) => {
      e.preventDefault();
      if (!newName.value.trim()) return;
      try {
        const c = await api('POST', '/api/collections', { name: newName.value });
        await api('POST', `/api/collections/${c.id}/quotes`, { quoteId: q.id });
        newName.value = ''; toast(t('In „{0}“ gespeichert', c.name)); draw();
      } catch (ex) { toast(ex.message); }
    } }, newName, h('button', { class: 'btn', type: 'submit' }, t('Anlegen'))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, t('Fertig'))));
  async function draw() {
    try {
      const { collections } = await api('GET', `/api/collections?quote=${q.id}`);
      const own = collections.filter((c) => c.isOwner);
      list.replaceChildren(...(own.length ? own.map((c) => {
        const box = h('input', { type: 'checkbox', checked: c.contains, onchange: async () => {
          box.disabled = true;
          try {
            if (box.checked) await api('POST', `/api/collections/${c.id}/quotes`, { quoteId: q.id });
            else await api('DELETE', `/api/collections/${c.id}/quotes/${q.id}`);
          } catch (ex) { box.checked = !box.checked; toast(ex.message); } finally { box.disabled = false; }
        } });
        return h('label', { class: 'check' }, box, h('span', {}, c.name, h('small', {}, plural(c.count, t('Zitat'), t('Zitate')))));
      }) : [h('span', { class: 'hint' }, t('Du hast noch keine Sammlung – leg unten eine an.'))]));
    } catch (ex) { list.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  }
  draw();
}

/** Freigabe-Link einer Sammlung erstellen/kopieren/deaktivieren. */
export function openCollectionLink(c, onChange) {
  const body = h('div');
  const dlg = modal(h('h2', {}, t('Sammlung per Link teilen')),
    h('p', { class: 'hint' }, t('Wer den Link hat, sieht die Sammlung ohne Konto – mit deinen eigenen Zitaten und öffentlichen Zitaten anderer. Fremde private Zitate bleiben verborgen.')),
    body, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Fertig'))));
  const draw = () => {
    if (!c.link) {
      body.replaceChildren(h('button', { class: 'btn primary block', onclick: async () => {
        try { c.link = (await api('POST', `/api/collections/${c.id}/link`)).link; draw(); onChange?.(); } catch (ex) { toast(ex.message); }
      } }, icon('link'), h('span', {}, t('Link erstellen'))));
      return;
    }
    const url = new URL(c.link, location.origin).toString();
    const field = h('input', { type: 'text', readonly: true, value: url, 'aria-label': t('Freigabe-Link'), onfocus: (e) => e.target.select() });
    body.replaceChildren(h('div', { class: 'linkbox' }, field, h('button', { class: 'btn primary', onclick: async () => {
      try { await navigator.clipboard.writeText(url); toast(t('Link kopiert')); } catch { field.select(); }
    } }, t('Kopieren'))),
    h('div', { class: 'row left' }, h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm(t('Link deaktivieren?'))) return;
      try { await api('DELETE', `/api/collections/${c.id}/link`); c.link = null; draw(); onChange?.(); toast(t('Link deaktiviert')); } catch (ex) { toast(ex.message); }
    } }, t('Link deaktivieren'))));
  };
  draw();
}

/** Öffentliche Ansicht einer Sammlung (ohne Login). */
export async function renderPublicCollection(token) {
  const body = h('div', { class: 'list' });
  $app.replaceChildren(h('main', { class: 'container' }, h('div', { class: 'public-page' },
    h('a', { class: 'logo auth-logo', href: '/' }, h('i', {}, '“'), t('Quotes')), body,
    h('p', { class: 'public-cta' }, h('a', { class: 'btn', href: '/' }, t('Eigene Zitate sammeln'))))));
  try {
    const c = await api('GET', `/api/public/collections/${encodeURIComponent(token)}`);
    document.title = t('{0} – Sammlung von @{1}', c.name, c.owner);
    body.append(h('header', { class: 'coll-public-head' }, h('span', { class: 'daily-label' }, t('Sammlung')), h('h1', {}, c.name),
      c.description ? h('p', {}, c.description) : null,
      h('p', { class: 'hint' }, t('von @{0} · {1}', c.owner, plural(c.quotes.length, t('Zitat'), t('Zitate'))))));
    for (const q of c.quotes) {
      body.append(h('article', { class: 'card quote' }, quoteText(q),
        h('div', { class: 'qsrc' }, h('span', { class: 'person-link static' }, `— ${q.person}`), q.source ? h('span', { class: 'source' }, `, ${q.source}`) : null),
        h('div', { class: 'meta' }, h('span', {}, q.author === c.owner ? fmtDate(q.createdAt) : t('von @{0} · {1}', q.author, relTime(q.createdAt))))));
    }
    if (!c.quotes.length) body.append(h('div', { class: 'empty' }, h('b', {}, t('Diese Sammlung ist noch leer'))));
  } catch (ex) {
    body.append(h('div', { class: 'empty' }, h('b', {}, t('Link nicht verfügbar')), ex.message));
  }
}
