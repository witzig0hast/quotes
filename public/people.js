// Personen-Kopf (mit Wikipedia), Zufallszitat, Duplikat-Hinweis, Personen-Vorschläge, Import.
import { h, api, toast, modal, icon, plural, fmtDate } from './core.js';

/** Kopfbereich über der Liste, wenn nach einer Person gefiltert wird. */
export async function personHeader(name, { onTag } = {}) {
  const box = h('section', { class: 'person-head', 'aria-label': `Über ${name}` }, h('div', { class: 'card skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
  try {
    const p = await api('GET', `/api/people/${encodeURIComponent(name)}`);
    const w = p.wiki;
    box.replaceChildren(
      w?.thumbnail ? h('img', { class: 'person-img', src: w.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'person-img ph', 'aria-hidden': 'true' }, p.name.slice(0, 1).toUpperCase()),
      h('div', { class: 'person-body' },
        h('span', { class: 'daily-label' }, 'Person'),
        h('h2', {}, p.name),
        w?.description ? h('p', { class: 'person-desc' }, w.description) : null,
        h('p', { class: 'person-stats' }, `${plural(p.count, 'Zitat', 'Zitate')} · von ${plural(p.collectors, 'Person', 'Personen')} gesammelt · seit ${fmtDate(p.firstAt)}`),
        w?.extract ? h('p', { class: 'person-extract' }, w.extract) : null,
        w?.url ? h('a', { class: 'person-wiki', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, 'Mehr auf Wikipedia ↗') : null,
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
      if (!quote) { slot.replaceChildren(h('div', { class: 'empty small' }, h('b', {}, 'Hier gibt es noch nichts'), 'Sobald es Zitate gibt, ziehe ich dir eins.')); again.hidden = true; return; }
      last = quote.id;
      slot.replaceChildren(quoteCard(quote, () => {}, { inDialog: true }));
    } catch (ex) { toast(ex.message); }
  };
  const again = h('button', { class: 'btn primary', type: 'button', onclick: next }, icon('shuffle'), h('span', {}, 'Noch eins'));
  const dlg = modal(h('div', { class: 'dialog-head' }, h('h2', {}, 'Überrasch mich'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Schließen', onclick: () => dlg.close() }, '✕')),
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
      box.replaceChildren(h('b', {}, r.own ? 'Hast du schon gespeichert' : `Gibt es schon von @${q.author}`),
        h('span', {}, ` — ${q.person}${r.own ? '' : ' · Du kannst es stattdessen favorisieren oder in eine Sammlung legen.'}`),
        h('button', { class: 'link-btn', type: 'button', onclick: () => onOpen?.(q) }, 'Ansehen'));
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
    if (f.size > 2 * 1024 * 1024) { result.replaceChildren(h('p', { class: 'error' }, 'Die Datei ist größer als 2 MB.')); return; }
    result.replaceChildren(h('p', { class: 'hint' }, `„${f.name}“ wird importiert …`));
    try {
      const content = await f.text();
      const format = /\.json$/i.test(f.name) || content.trim().startsWith('{') || content.trim().startsWith('[') ? 'json' : 'csv';
      const r = await api('POST', '/api/import', { format, content });
      result.replaceChildren(h('p', {}, h('b', {}, `${plural(r.imported, 'Zitat', 'Zitate')} importiert`),
        r.skipped ? ` · ${r.skipped} schon vorhanden (übersprungen)` : null,
        r.errors.length ? ` · ${plural(r.errors.length, 'Zeile', 'Zeilen')} mit Fehlern` : null),
      ...(r.errors.length ? [h('ul', { class: 'import-errors' }, r.errors.map((e) => h('li', {}, e.row ? `Zeile ${e.row}: ${e.error}` : e.error)))] : []));
      if (r.imported) { toast(`${plural(r.imported, 'Zitat', 'Zitate')} importiert`); onDone?.(); }
    } catch (ex) { result.replaceChildren(h('p', { class: 'error' }, ex.message)); }
    file.value = '';
  });
  return h('section', { class: 'acc-section' }, h('label', { for: 'imp-file' }, 'Zitate importieren'),
    h('p', { class: 'hint' }, 'CSV (z. B. aus Excel: Spalten „Zitat“/„text“ und „Person“, optional „Quelle“, „Tags“) oder JSON aus dem Export. Neue Zitate sind privat, Doppelte werden übersprungen.'),
    h('div', { class: 'row left' }, h('label', { class: 'btn', for: 'imp-file', tabindex: 0, role: 'button',
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } }, icon('upload'), h('span', {}, 'Datei wählen …')), file),
    result);
}
