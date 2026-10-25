// Verbesserungsvorschläge: Andere schlagen Korrekturen an Text, Person oder Quelle vor; der Eigentümer entscheidet.
import { bad, clean, notFound, forbidden, handler, intParam, normText } from '../util.js';

const FIELDS = { text: ['Zitat', 1000], person: ['Person', 100], source: ['Quelle', 150] };

export function registerSuggestions(app, ctx) {
  const { db, requireAuth, writeLimiter, ACCESS, notify, tx } = ctx;

  const shape = (s) => ({
    id: s.id, quoteId: s.quote_id, field: s.field, value: s.value, note: s.note, status: s.status,
    current: s.current ?? undefined, quoteText: s.quote_text?.slice(0, 140), quotePerson: s.quote_person,
    by: s.by, createdAt: s.created_at, decidedAt: s.decided_at,
  });

  app.post('/api/quotes/:id/suggestions', requireAuth, writeLimiter, handler((req, res) => {
    const me = req.user.id;
    const q = db.prepare(`SELECT q.* FROM quotes q WHERE q.id = @id AND ${ACCESS}`).get({ id: intParam(req.params.id), me });
    if (!q) throw notFound();
    if (q.user_id === me) throw bad('Eigene Zitate kannst du direkt bearbeiten.');
    const field = req.body?.field;
    if (!FIELDS[field]) throw bad('Feld muss text, person oder source sein.');
    const [label, max] = FIELDS[field];
    const value = clean(req.body?.value, max);
    const note = clean(req.body?.note ?? '', 300);
    if (!value && field !== 'source') throw bad(`${label} darf nicht leer sein.`);
    if (value.length > max) throw bad(`${label} ist zu lang (max. ${max} Zeichen).`);
    if (note.length > 300) throw bad('Die Begründung ist zu lang (max. 300 Zeichen).');
    if (value === q[field]) throw bad('Das ist schon der aktuelle Wert.');
    if (db.prepare("SELECT 1 FROM suggestions WHERE quote_id = ? AND user_id = ? AND field = ? AND status = 'open'").get(q.id, me, field)) {
      throw bad('Du hast für dieses Feld schon einen offenen Vorschlag.');
    }
    const id = Number(db.prepare('INSERT INTO suggestions (quote_id, user_id, field, value, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(q.id, me, field, value, note, Date.now()).lastInsertRowid);
    notify([q.user_id], 'suggestion', me, { quoteId: q.id, refId: id });
    res.status(201).json({ id, status: 'open' });
  }));

  // Offene Vorschläge zu meinen Zitaten + meine eigenen Vorschläge
  app.get('/api/suggestions', requireAuth, handler((req, res) => {
    const me = req.user.id;
    const incoming = db.prepare(`SELECT s.*, u.username AS by, q.text AS quote_text, q.person AS quote_person,
                                   CASE s.field WHEN 'text' THEN q.text WHEN 'person' THEN q.person ELSE q.source END AS current
                                 FROM suggestions s JOIN quotes q ON q.id = s.quote_id JOIN users u ON u.id = s.user_id
                                 WHERE q.user_id = ? AND s.status = 'open' ORDER BY s.created_at DESC LIMIT 100`).all(me);
    const outgoing = db.prepare(`SELECT s.*, u.username AS by, q.text AS quote_text, q.person AS quote_person
                                 FROM suggestions s JOIN quotes q ON q.id = s.quote_id JOIN users u ON u.id = s.user_id
                                 WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 50`).all(me);
    res.json({ incoming: incoming.map(shape), outgoing: outgoing.map(shape) });
  }));

  // Annehmen (Wert übernehmen) oder ablehnen – nur der Eigentümer des Zitats
  app.post('/api/suggestions/:sid', requireAuth, writeLimiter, handler((req, res) => {
    const me = req.user.id;
    const s = db.prepare('SELECT s.*, q.user_id AS owner FROM suggestions s JOIN quotes q ON q.id = s.quote_id WHERE s.id = ?').get(intParam(req.params.sid));
    if (!s || s.owner !== me) throw notFound('Vorschlag nicht gefunden.');
    if (s.status !== 'open') throw bad('Über diesen Vorschlag wurde schon entschieden.');
    const action = req.body?.action;
    if (!['accept', 'reject'].includes(action)) throw bad('Aktion muss accept oder reject sein.');
    tx(() => {
      if (action === 'accept') {
        // Feldname stammt aus der CHECK-Liste (text/person/source), nie aus der Anfrage
        const col = { text: 'text', person: 'person', source: 'source' }[s.field];
        db.prepare(`UPDATE quotes SET ${col} = ?, updated_at = ?${col === 'text' ? ', text_norm = ?' : ''} WHERE id = ?`)
          .run(...(col === 'text' ? [s.value, Date.now(), normText(s.value), s.quote_id] : [s.value, Date.now(), s.quote_id]));
        // Andere offene Vorschläge zum selben Feld sind damit überholt
        db.prepare("UPDATE suggestions SET status = 'rejected', decided_at = ? WHERE quote_id = ? AND field = ? AND status = 'open' AND id != ?")
          .run(Date.now(), s.quote_id, s.field, s.id);
      }
      db.prepare('UPDATE suggestions SET status = ?, decided_at = ? WHERE id = ?').run(action === 'accept' ? 'accepted' : 'rejected', Date.now(), s.id);
    });
    notify([s.user_id], action === 'accept' ? 'suggestion_accepted' : 'suggestion_rejected', me, { quoteId: s.quote_id, refId: s.id });
    res.json({ status: action === 'accept' ? 'accepted' : 'rejected' });
  }));

  // Eigenen offenen Vorschlag zurückziehen
  app.delete('/api/suggestions/:sid', requireAuth, writeLimiter, handler((req, res) => {
    const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(intParam(req.params.sid));
    if (!s || s.user_id !== req.user.id) throw notFound('Vorschlag nicht gefunden.');
    if (s.status !== 'open') throw forbidden('Entschiedene Vorschläge bleiben erhalten.');
    db.prepare('DELETE FROM suggestions WHERE id = ?').run(s.id);
    db.prepare("DELETE FROM notifications WHERE ref_id = ? AND type = 'suggestion'").run(s.id);
    res.json({ ok: true });
  }));
}
