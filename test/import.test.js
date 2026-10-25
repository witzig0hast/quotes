import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, clientFactory, quote } from './helpers.js';
import { parseCsv } from '../src/features/import.js';

let app, signup;
before(() => { app = startApp(); ({ signup } = clientFactory(app.base)); });
after(() => app.server.close());

test('CSV-Parser: Anführungszeichen, Zeilenumbrüche, Semikolon (Excel), BOM', () => {
  assert.deepEqual(parseCsv('﻿text;person\r\n"Er sagte ""Hallo"";\nzweite Zeile";Anna\r\n\r\n'),
    [['text', 'person'], ['Er sagte "Hallo";\nzweite Zeile', 'Anna']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('Import CSV mit deutschen Spaltennamen, Tags, Formel-Schutz, Fehlern pro Zeile', async () => {
  const a = await signup();
  const csv = 'Zitat;Person;Quelle;Tags;Sichtbarkeit\n'
    + '"Phantasie ist wichtiger als Wissen.";Albert Einstein;Interview;"wissen, phantasie";public\n'
    + "\"'=1+1 ist zwei\";Mathe;;;\n"
    + ';Ohne Text;;;\n'
    + '"Geteilt wird privat";X;;;shared\n';
  const r = (await a.req('POST', '/api/import', { format: 'csv', content: csv })).data;
  assert.equal(r.imported, 3); assert.equal(r.errors.length, 1); assert.equal(r.errors[0].row, 3);
  const mine = (await a.get('/api/quotes?scope=mine')).quotes;
  const ein = mine.find((q) => q.person === 'Albert Einstein');
  assert.deepEqual([ein.visibility, ein.source, ein.tags], ['public', 'Interview', ['phantasie', 'wissen']]);
  assert.ok(mine.some((q) => q.text === '=1+1 ist zwei'));
  assert.equal(mine.find((q) => q.person === 'X').visibility, 'private');
  // Erneut importieren -> alles übersprungen
  const again = (await a.req('POST', '/api/import', { format: 'csv', content: csv })).data;
  assert.deepEqual([again.imported, again.skipped], [0, 3]);
  assert.equal((await a.req('POST', '/api/import', { format: 'csv', content: 'foo,bar\n1,2' })).status, 400);
});

test('Export -> Import (JSON) in ein anderes Konto: Inhalte, Tags und Datum bleiben erhalten', async () => {
  const a = await signup(), b = await signup();
  await a.req('POST', '/api/quotes', quote({ text: 'Erstes Zitat zum Umziehen', person: 'P1', tags: ['umzug'] }));
  await a.req('POST', '/api/quotes', quote({ text: 'Zweites Zitat zum Umziehen', person: 'P2', visibility: 'public' }));
  const exp = await (await fetch(`${app.base}/api/export?format=json`, { headers: { cookie: a.cookie } })).text();
  const r = (await b.req('POST', '/api/import', { format: 'json', content: exp })).data;
  assert.deepEqual([r.imported, r.skipped, r.errors.length], [2, 0, 0]);
  const bq = (await b.get('/api/quotes?scope=mine')).quotes;
  assert.deepEqual(bq.map((q) => q.text).sort(), ['Erstes Zitat zum Umziehen', 'Zweites Zitat zum Umziehen']);
  assert.deepEqual(bq.find((q) => q.person === 'P1').tags, ['umzug']);
  const orig = JSON.parse(exp).quotes[0];
  assert.equal(new Date(bq.find((q) => q.person === 'P1').createdAt).toISOString(), orig.createdAt);
  assert.equal((await b.req('POST', '/api/import', { format: 'json', content: '{kaputt' })).status, 400);
});

test('Import: große Dateien erlaubt (bis 2 MB), andere Anfragen weiter auf 20 KB begrenzt; max. 1000 Zeilen', async () => {
  const a = await signup();
  const rows = Array.from({ length: 300 }, (_, i) => `"Ein ziemlich langes Zitat Nummer ${i} ${'x'.repeat(60)}";Person ${i}`);
  const big = `text,person\n${rows.join('\n').replace(/;/g, ',')}`;
  assert.ok(big.length > 20_000);
  const r = await a.req('POST', '/api/import', { format: 'csv', content: big });
  assert.equal(r.status, 200); assert.equal(r.data.imported, 300);
  assert.equal((await a.req('POST', '/api/quotes', { ...quote(), source: 'y'.repeat(25_000) })).status, 413);
  const tooMany = `text,person\n${Array.from({ length: 1001 }, (_, i) => `Zitat ${i},P`).join('\n')}`;
  assert.equal((await a.req('POST', '/api/import', { format: 'csv', content: tooMany })).status, 400);
});
