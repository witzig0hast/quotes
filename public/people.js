// Personen-Kopf (mit Wikipedia), Zufallszitat, Duplikat-Hinweis, Personen-Vorschläge, Import.
import { h, api, toast, modal, icon, plural, fmtDate, t, LOCALE, LANG } from './core.js';

/** Kopfbereich über der Liste, wenn nach einer Person gefiltert wird. */
export async function personHeader(name, { onTag } = {}) {
  const box = h('section', { class: 'person-head', 'aria-label': t('Über {0}', name) }, h('div', { class: 'card skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
  try {
    const p = await api('GET', `/api/people/${encodeURIComponent(name)}`);
    const w = p.wiki;
    box.replaceChildren(
      w?.thumbnail ? h('img', { class: 'person-img', src: w.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'person-img ph', 'aria-hidden': 'true' }, p.name.slice(0, 1).toUpperCase()),
      h('div', { class: 'person-body' },
        h('span', { class: 'daily-label' }, t('Person')),
        h('h2', {}, p.name),
        w?.description ? h('p', { class: 'person-desc' }, w.description) : null,
        h('p', { class: 'person-stats' }, t('{0} · von {1} gesammelt · seit {2}', plural(p.count, t('Zitat'), t('Zitate')), plural(p.collectors, t('Person'), t('Personen')), fmtDate(p.firstAt))),
        w?.extract ? h('p', { class: 'person-extract' }, w.extract) : null,
        w?.url ? h('a', { class: 'person-wiki', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, t('Mehr auf Wikipedia ↗')) : null,
        p.tags.length ? h('div', { class: 'tags' }, p.tags.map((t) => h('button', { class: 'tag', onclick: () => onTag?.(t.tag) }, `#${t.tag} · ${t.count}`))) : null));
  } catch { box.replaceChildren(); }
  return box;
}

/** "Überrasch mich": zufälliges Zitat im Dialog, mit "Noch eins". */
export async function openRandom(scope, quoteCard) {
  const slot = h('div', { class: 'random-slot' });
  let last = null;
  const next = async () => {
    try {
      const { quote } = await api('GET', `/api/random?scope=${encodeURIComponent(scope)}${last ? `&not=${last}` : ''}`);
      if (!quote) { slot.replaceChildren(h('div', { class: 'empty small' }, h('b', {}, t('Hier gibt es noch nichts')), t('Sobald es Zitate gibt, ziehe ich dir eins.'))); again.hidden = true; return; }
      last = quote.id;
      slot.replaceChildren(quoteCard(quote, () => {}, { inDialog: true }));
    } catch (ex) { toast(ex.message); }
  };
  const again = h('button', { class: 'btn primary', type: 'button', onclick: next }, icon('shuffle'), h('span', {}, t('Noch eins')));
  const dlg = modal(h('div', { class: 'dialog-head' }, h('h2', {}, t('Überrasch mich')),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg.close() }, '✕')),
    slot, h('div', { class: 'row' }, again));
  dlg.classList.add('quote-dialog');
  next();
}

/** Hinweis im Editor, wenn es das Zitat schon gibt (nicht blockierend). */
export function duplicateHint(textEl, excludeId, { onOpen } = {}) {
  const box = h('div', { class: 'dup-hint', role: 'status', hidden: true });
  let timer, seq = 0;
  const check = async () => {
    const text = textEl.value.trim();
    if (text.length < 15) { box.hidden = true; return; }
    const my = ++seq;
    try {
      const r = await api('GET', `/api/quotes-check?text=${encodeURIComponent(text)}${excludeId ? `&exclude=${excludeId}` : ''}`);
      if (my !== seq) return;
      const q = r.own ?? r.existing;
      if (!q) { box.hidden = true; return; }
      box.replaceChildren(h('b', {}, r.own ? t('Hast du schon gespeichert') : t('Gibt es schon von @{0}', q.author)),
        h('span', {}, ` — ${q.person}${r.own ? '' : t(' · Du kannst es stattdessen favorisieren oder in eine Sammlung legen.')}`),
        h('button', { class: 'link-btn', type: 'button', onclick: () => onOpen?.(q) }, t('Ansehen')));
      box.hidden = false;
    } catch { /* optional */ }
  };
  textEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 500); });
  if (textEl.value) setTimeout(check, 0);
  return box;
}

/** Vorschläge für das Personen-Feld (aus sichtbaren Zitaten) per <datalist>. */
export function attachPersonSuggest(input) {
  const list = h('datalist', { id: `${input.id}-list` });
  input.setAttribute('list', list.id);
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const { people } = await api('GET', `/api/people?q=${encodeURIComponent(q)}`);
        list.replaceChildren(...people.filter((p) => p !== input.value).map((p) => h('option', { value: p })));
      } catch { /* optional */ }
    }, 200);
  });
  return list;
}

/** Konto-Bereich: CSV/JSON importieren. */
export function importSection(onDone) {
  const result = h('div', { class: 'import-result', role: 'status' });
  const file = h('input', { type: 'file', accept: '.csv,.json,text/csv,application/json', class: 'visually-hidden', id: 'imp-file' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { result.replaceChildren(h('p', { class: 'error' }, t('Die Datei ist größer als 2 MB.'))); return; }
    result.replaceChildren(h('p', { class: 'hint' }, t('„{0}“ wird importiert …', f.name)));
    try {
      const content = await f.text();
      const format = /\.json$/i.test(f.name) || content.trim().startsWith('{') || content.trim().startsWith('[') ? 'json' : 'csv';
      const r = await api('POST', '/api/import', { format, content });
      result.replaceChildren(h('p', {}, h('b', {}, t('{0} importiert', plural(r.imported, t('Zitat'), t('Zitate')))),
        r.skipped ? t(' · {0} schon vorhanden (übersprungen)', r.skipped) : null,
        r.errors.length ? t(' · {0} mit Fehlern', plural(r.errors.length, t('Zeile'), t('Zeilen'))) : null),
      ...(r.errors.length ? [h('ul', { class: 'import-errors' }, r.errors.map((e) => h('li', {}, e.row ? t('Zeile {0}: {1}', e.row, e.error) : e.error)))] : []));
      if (r.imported) { toast(t('{0} importiert', plural(r.imported, t('Zitat'), t('Zitate')))); onDone?.(); }
    } catch (ex) { result.replaceChildren(h('p', { class: 'error' }, ex.message)); }
    file.value = '';
  });
  return h('section', { class: 'acc-section' }, h('label', { for: 'imp-file' }, t('Zitate importieren')),
    h('p', { class: 'hint' }, t('CSV (z. B. aus Excel: Spalten „Zitat“/„text“ und „Person“, optional „Quelle“, „Tags“) oder JSON aus dem Export. Neue Zitate sind privat, Doppelte werden übersprungen.')),
    h('div', { class: 'row left' }, h('label', { class: 'btn', for: 'imp-file', tabindex: 0, role: 'button',
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } }, icon('upload'), h('span', {}, t('Datei wählen …'))), file),
    result);
}
