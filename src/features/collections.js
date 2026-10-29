// Sammlungen: eigene Listen von Zitaten ("Hochzeitsrede", "Für schlechte Tage" …).
// Sichtbar für den Eigentümer, für Mitglieder freigegebener Gruppen und – optional – per geheimem Link.
//
// Welche Zitate sieht ein Betrachter in einer Sammlung?
//   - alle, die er ohnehin sehen darf (ACCESS), und
//   - die eigenen Zitate des Sammlungs-Eigentümers (der teilt sie damit bewusst).
// Fremde, nicht sichtbare Zitate werden so nie über eine Sammlung weitergegeben.
import { randomBytes } from 'node:crypto';
import { bad, clean, notFound, forbidden, handler, intParam, placeholders } from '../util.js';

const MAX_COLLECTIONS = 100;
const MAX_ITEMS = 1000;

export function registerCollections(app, ctx) {
  const { db, requireAuth, writeLimiter, readLimiter, ACCESS, BASE, shape, tx, PAGE_SIZE } = ctx;

  const validate = (body) => {
    const name = clean(body.name, 60);
    const description = clean(body.description ?? '', 300);
    if (!name) throw bad('Bitte einen Namen angeben.');
    if (name.length > 60) throw bad('Der Name ist zu lang (max. 60 Zeichen).');
    if (description.length > 300) throw bad('Die Beschreibung ist zu lang (max. 300 Zeichen).');
    if (body.groups !== undefined && !Array.isArray(body.groups)) throw bad('Ungültige Gruppenliste.');
    const groups = [...new Set((body.groups ?? []).map(Number))];
    if (groups.length > 20 || groups.some((g) => !Number.isSafeInteger(g) || g < 1)) throw bad('Ungültige Gruppenliste.');
    return { name, description, groups };
  };

  // Darf der Nutzer die Sammlung sehen? (Eigentümer oder Mitglied einer freigegebenen Gruppe)
  const CAN_VIEW = `(c.owner_id = @me OR EXISTS(SELECT 1 FROM collection_groups cg JOIN group_members gm ON gm.group_id = cg.group_id
                     WHERE cg.collection_id = c.id AND gm.user_id = @me))`;
  // Sichtbare Zitate innerhalb einer Sammlung (siehe Kopfkommentar)
  const ITEM_VISIBLE = `(${ACCESS} OR q.user_id = c.owner_id)`;

  const loadCollection = (id, me) => {
    const c = db.prepare(`SELECT c.*, u.username AS owner FROM collections c JOIN users u ON u.id = c.owner_id
                          WHERE c.id = @id AND ${CAN_VIEW}`).get({ id, me });
    if (!c) throw notFound('Sammlung nicht gefunden.');
    return c;
  };

  const summary = (c, me) => {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM collection_quotes cq JOIN quotes q ON q.id = cq.quote_id
                              JOIN collections c ON c.id = cq.collection_id WHERE cq.collection_id = @cid AND ${ITEM_VISIBLE}`)
      .get({ cid: c.id, me });
    const isOwner = c.owner_id === me;
    return {
      id: c.id, name: c.name, description: c.description, owner: c.owner, isOwner, count: n,
      updatedAt: c.updated_at,
      ...(isOwner ? {
        groups: db.prepare(`SELECT g.id, g.name FROM collection_groups cg JOIN user_groups g ON g.id = cg.group_id
                            WHERE cg.collection_id = ? ORDER BY g.name`).all(c.id),
        link: c.share_token ? `/c/${c.share_token}` : null,
      } : {}),
    };
  };

  const saveGroups = (cid, ownerId, groups) => {
    if (groups.length) {
      const ok = db.prepare(`SELECT group_id FROM group_members WHERE user_id = ? AND group_id IN (${placeholders(groups)})`).all(ownerId, ...groups);
      if (ok.length !== groups.length) throw bad('Du kannst nur mit Gruppen teilen, in denen du Mitglied bist.');
    }
    db.prepare('DELETE FROM collection_groups WHERE collection_id = ?').run(cid);
    const ins = db.prepare('INSERT INTO collection_groups (collection_id, group_id) VALUES (?,?)');
    for (const g of groups) ins.run(cid, g);
  };

  const requireOwn = (req) => {
    const c = loadCollection(intParam(req.params.cid), req.user.id);
    if (c.owner_id !== req.user.id) throw forbidden('Nur der Eigentümer kann die Sammlung ändern.');
    return c;
  };

  // Meine + mit mir (über Gruppen) geteilte Sammlungen
  app.get('/api/collections', requireAuth, handler((req, res) => {
    const me = req.user.id;
    const rows = db.prepare(`SELECT c.*, u.username AS owner FROM collections c JOIN users u ON u.id = c.owner_id
                             WHERE ${CAN_VIEW} ORDER BY (c.owner_id = @me) DESC, c.updated_at DESC`).all({ me });
    // Optional: ?quote=ID -> zusätzlich markieren, welche eigenen Sammlungen dieses Zitat enthalten
    const qid = req.query.quote ? intParam(req.query.quote) : null;
    const contains = qid ? new Set(db.prepare('SELECT collection_id FROM collection_quotes WHERE quote_id = ?').all(qid).map((r) => r.collection_id)) : null;
    res.json({ collections: rows.map((c) => ({ ...summary(c, me), ...(contains ? { contains: contains.has(c.id) } : {}) })) });
  }));

  app.post('/api/collections', requireAuth, writeLimiter, handler((req, res) => {
    const v = validate(req.body);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM collections WHERE owner_id = ?').get(req.user.id);
    if (n >= MAX_COLLECTIONS) throw bad(`Du kannst höchstens ${MAX_COLLECTIONS} Sammlungen anlegen.`);
    const id = tx(() => {
      const now = Date.now();
      const id = Number(db.prepare('INSERT INTO collections (owner_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(req.user.id, v.name, v.description, now, now).lastInsertRowid);
      saveGroups(id, req.user.id, v.groups);
      return id;
    });
    res.status(201).json(summary(loadCollection(id, req.user.id), req.user.id));
  }));

  // Details + Zitate (seitenweise)
  app.get('/api/collections/:cid', requireAuth, handler((req, res) => {
    const me = req.user.id;
    const c = loadCollection(intParam(req.params.cid), me);
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    const rows = db.prepare(`${BASE} JOIN collection_quotes cq ON cq.quote_id = q.id JOIN collections c ON c.id = cq.collection_id
                             WHERE cq.collection_id = @cid AND ${ITEM_VISIBLE}
                             ORDER BY cq.added_at DESC, q.id DESC LIMIT @limit OFFSET @offset`)
      .all({ cid: c.id, me, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
    res.json({ collection: summary(c, me), quotes: shape(rows.slice(0, PAGE_SIZE)), hasMore: rows.length > PAGE_SIZE });
  }));

  app.patch('/api/collections/:cid', requireAuth, writeLimiter, handler((req, res) => {
    const c = requireOwn(req);
    const v = validate({ name: c.name, description: c.description, ...req.body });
    tx(() => {
      db.prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(v.name, v.description, Date.now(), c.id);
      if (req.body.groups !== undefined) saveGroups(c.id, req.user.id, v.groups);
    });
    res.json(summary(loadCollection(c.id, req.user.id), req.user.id));
  }));

  app.delete('/api/collections/:cid', requireAuth, writeLimiter, handler((req, res) => {
    const c = requireOwn(req);
    db.prepare('DELETE FROM collections WHERE id = ?').run(c.id);
    res.json({ ok: true });
  }));

  // Zitat hinzufügen: nur Zitate, die der Eigentümer selbst sehen darf
  app.post('/api/collections/:cid/quotes', requireAuth, writeLimiter, handler((req, res) => {
    const c = requireOwn(req);
    const qid = intParam(req.body.quoteId);
    if (!db.prepare(`SELECT 1 FROM quotes q WHERE q.id = @qid AND ${ACCESS}`).get({ qid, me: req.user.id })) throw notFound('Zitat nicht gefunden.');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM collection_quotes WHERE collection_id = ?').get(c.id);
    if (n >= MAX_ITEMS) throw bad(`Eine Sammlung fasst höchstens ${MAX_ITEMS} Zitate.`);
    tx(() => {
      db.prepare('INSERT OR IGNORE INTO collection_quotes (collection_id, quote_id, added_at) VALUES (?,?,?)').run(c.id, qid, Date.now());
      db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(Date.now(), c.id);
    });
    res.json({ ok: true });
  }));

  app.delete('/api/collections/:cid/quotes/:qid', requireAuth, writeLimiter, handler((req, res) => {
    const c = requireOwn(req);
    db.prepare('DELETE FROM collection_quotes WHERE collection_id = ? AND quote_id = ?').run(c.id, intParam(req.params.qid));
    res.json({ ok: true });
  }));

  // Geheimer Freigabe-Link (wie bei Zitaten)
  app.post('/api/collections/:cid/link', requireAuth, writeLimiter, handler((req, res) => {
    const c = requireOwn(req);
    let token = c.share_token;
    if (!token) {
      token = randomBytes(24).toString('base64url');
      db.prepare('UPDATE collections SET share_token = ? WHERE id = ?').run(token, c.id);
    }
    res.json({ link: `/c/${token}` });
  }));
  app.delete('/api/collections/:cid/link', requireAuth, writeLimiter, handler((req, res) => {
    const c = requireOwn(req);
    db.prepare('UPDATE collections SET share_token = NULL WHERE id = ?').run(c.id);
    res.json({ link: null });
  }));

  // Öffentlich (ohne Login): öffentliche Zitate + eigene Zitate des Eigentümers; keine Markierungen/Empfänger
  app.get('/api/public/collections/:token', readLimiter, handler((req, res) => {
    const token = req.params.token;
    const gone = () => notFound('Dieser Link ist ungültig oder wurde deaktiviert.');
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw gone();
    const c = db.prepare('SELECT c.*, u.username AS owner FROM collections c JOIN users u ON u.id = c.owner_id WHERE c.share_token = ?').get(token);
    if (!c) throw gone();
    const quotes = db.prepare(`SELECT q.text, q.person, q.source, q.lang, q.translation, q.created_at AS createdAt, u.username AS author
                               FROM collection_quotes cq JOIN quotes q ON q.id = cq.quote_id JOIN users u ON u.id = q.user_id
                               WHERE cq.collection_id = ? AND (q.visibility = 'public' OR q.user_id = ?)
                               ORDER BY cq.added_at DESC LIMIT 200`).all(c.id, c.owner_id);
    res.set('X-Robots-Tag', 'noindex');
    res.json({ name: c.name, description: c.description, owner: c.owner, quotes });
  }));
}
