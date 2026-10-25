// Import aus CSV (z. B. Excel, unser eigener Export) oder JSON (unser Export oder einfache Liste).
import express from 'express';
import { bad, handler, normText } from '../util.js';

const MAX_ROWS = 1000;

/** RFC-4180-CSV mit automatischer Erkennung von , ; oder Tab als Trennzeichen. */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// Spaltennamen (deutsch/englisch) -> Feld
const COLUMNS = {
  text: ['text', 'zitat', 'quote'], person: ['person', 'autor', 'author', 'von', 'name'], source: ['source', 'quelle'],
  tags: ['tags', 'tag', 'schlagwörter', 'schlagworte'], visibility: ['visibility', 'sichtbarkeit'], createdAt: ['createdat', 'created_at', 'datum', 'date'],
};
// Unser Export entschärft Formeln mit einem führenden ' – beim Import wieder entfernen
const unguard = (s) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
const splitTags = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map((t) => String(t).trim()).filter(Boolean);

function rowsFromCsv(content) {
  const rows = parseCsv(content);
  if (rows.length < 2) throw bad('Die CSV-Datei braucht eine Kopfzeile und mindestens eine Zeile mit Zitaten.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.text < 0 || col.person < 0) throw bad('Die CSV-Datei braucht mindestens die Spalten „text“ (oder „Zitat“) und „person“.');
  return rows.slice(1).map((r) => {
    const get = (k) => (col[k] >= 0 ? unguard(r[col[k]] ?? '') : '');
    return { text: get('text'), person: get('person'), source: get('source'), tags: splitTags(get('tags')), visibility: get('visibility'), createdAt: get('createdAt') };
  });
}

function rowsFromJson(content) {
  let data;
  try { data = JSON.parse(content); } catch { throw bad('Die JSON-Datei ist ungültig.'); }
  const list = Array.isArray(data) ? data : data?.quotes;
  if (!Array.isArray(list)) throw bad('Erwartet wird eine Liste von Zitaten oder unser Export-Format ({ "quotes": [...] }).');
  return list.map((q) => ({ text: q?.text, person: q?.person, source: q?.source ?? '', tags: splitTags(q?.tags), visibility: q?.visibility, createdAt: q?.createdAt }));
}

export function registerImport(app, ctx) {
  const { db, requireAuth, writeLimiter, tx, validateQuote, insertQuote } = ctx;

  app.post('/api/import', requireAuth, writeLimiter, express.json({ limit: '2mb' }), handler((req, res) => {
    const { format, content } = req.body ?? {};
    if (typeof content !== 'string' || !content.trim()) throw bad('Die Datei ist leer.');
    const rows = format === 'csv' ? rowsFromCsv(content) : format === 'json' ? rowsFromJson(content) : (() => { throw bad('Format muss csv oder json sein.'); })();
    if (rows.length > MAX_ROWS) throw bad(`Höchstens ${MAX_ROWS} Zitate pro Import.`);

    const me = req.user.id;
    const existing = new Set(db.prepare('SELECT text_norm FROM quotes WHERE user_id = ?').all(me).map((r) => r.text_norm));
    const result = { imported: 0, skipped: 0, errors: [] };
    tx(() => {
      rows.forEach((r, i) => {
        try {
          // "shared" würde Empfänger voraussetzen -> beim Import privat; ohne Angabe ebenfalls privat
          const visibility = r.visibility === 'public' ? 'public' : 'private';
          const v = validateQuote({ text: r.text, person: r.person, source: r.source ?? '', tags: r.tags.slice(0, 10), visibility });
          const norm = normText(v.text);
          if (existing.has(norm)) { result.skipped++; return; }
          const created = Date.parse(r.createdAt);
          insertQuote(me, v, Number.isFinite(created) && created < Date.now() ? created : Date.now());
          existing.add(norm);
          result.imported++;
        } catch (e) {
          if (!e.status || e.status >= 500) throw e;
          if (result.errors.length < 20) result.errors.push({ row: i + 1, error: e.message });
          else result.errors.length === 20 && result.errors.push({ row: null, error: 'Weitere Fehler ausgelassen.' });
        }
      });
    });
    res.json(result);
  }));
}
