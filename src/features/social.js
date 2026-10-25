// Kommentare, Folgen und Profile.
import { bad, clean, notFound, forbidden, handler, intParam } from '../util.js';

const MENTION_RE = /(?:^|[^\w@])@([A-Za-z0-9_.-]{3,30})/g;

export function registerSocial(app, ctx) {
  const { db, requireAuth, writeLimiter, readLimiter, ACCESS, notify } = ctx;

  const canSee = (quoteId, me) => db.prepare(`SELECT q.id, q.user_id FROM quotes q WHERE q.id = @id AND ${ACCESS}`).get({ id: quoteId, me });
  const shapeComment = (c, me, quoteOwner) => ({
    id: c.id, body: c.body, author: c.author, createdAt: c.created_at,
    mine: c.user_id === me, canDelete: c.user_id === me || quoteOwner === me,
  });

  // --- Kommentare ---
  app.get('/api/quotes/:id/comments', requireAuth, handler((req, res) => {
    const q = canSee(intParam(req.params.id), req.user.id);
    if (!q) throw notFound();
    const rows = db.prepare(`SELECT c.*, u.username AS author FROM comments c JOIN users u ON u.id = c.user_id
                             WHERE c.quote_id = ? ORDER BY c.created_at, c.id LIMIT 500`).all(q.id);
    res.json({ comments: rows.map((c) => shapeComment(c, req.user.id, q.user_id)) });
  }));

  app.post('/api/quotes/:id/comments', requireAuth, writeLimiter, handler((req, res) => {
    const me = req.user.id;
    const q = canSee(intParam(req.params.id), me);
    if (!q) throw notFound();
    const body = clean(req.body?.body, 1000);
    if (!body) throw bad('Der Kommentar ist leer.');
    if (body.length > 1000) throw bad('Der Kommentar ist zu lang (max. 1000 Zeichen).');
    const id = Number(db.prepare('INSERT INTO comments (quote_id, user_id, body, created_at) VALUES (?,?,?,?)').run(q.id, me, body, Date.now()).lastInsertRowid);
    // @Erwähnungen: nur Nutzer benachrichtigen, die das Zitat auch sehen dürfen
    const names = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))].slice(0, 10);
    const mentioned = names.length
      ? db.prepare(`SELECT id FROM users WHERE username IN (${names.map(() => '?').join(',')})`).all(...names).map((r) => r.id)
        .filter((uid) => canSee(q.id, uid))
      : [];
    notify(mentioned, 'comment_mention', me, { quoteId: q.id, refId: id });
    if (!mentioned.includes(q.user_id)) notify([q.user_id], 'comment', me, { quoteId: q.id, refId: id });
    const row = db.prepare('SELECT c.*, u.username AS author FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(id);
    res.status(201).json(shapeComment(row, me, q.user_id));
  }));

  app.delete('/api/comments/:cid', requireAuth, writeLimiter, handler((req, res) => {
    const me = req.user.id;
    const c = db.prepare('SELECT c.id, c.user_id, q.user_id AS owner FROM comments c JOIN quotes q ON q.id = c.quote_id WHERE c.id = ?').get(intParam(req.params.cid));
    if (!c) throw notFound();
    if (c.user_id !== me && c.owner !== me) throw forbidden('Nur Autor oder Eigentümer des Zitats können den Kommentar löschen.');
    db.prepare("DELETE FROM notifications WHERE ref_id = ? AND type IN ('comment', 'comment_mention')").run(c.id);
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    res.json({ ok: true });
  }));

  // --- Profile & Folgen ---
  const userByName = (name) => {
    const u = db.prepare('SELECT id, username, created_at FROM users WHERE username = ?').get(clean(String(name ?? ''), 30));
    if (!u) throw notFound('Nutzer nicht gefunden.');
    return u;
  };

  app.get('/api/users/:name', requireAuth, readLimiter, handler((req, res) => {
    const me = req.user.id;
    const u = userByName(req.params.name);
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    res.json({
      username: u.username, joinedAt: u.created_at, isMe: u.id === me,
      quotes: db.prepare(`SELECT COUNT(*) AS n FROM quotes q WHERE q.user_id = @uid AND ${ACCESS}`).get({ uid: u.id, me }).n,
      followers: count('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', u.id),
      following: count('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', u.id),
      isFollowing: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(me, u.id),
      followsYou: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(u.id, me),
      tags: db.prepare(`SELECT t.tag, COUNT(*) AS count FROM quote_tags t JOIN quotes q ON q.id = t.quote_id
                        WHERE q.user_id = @uid AND ${ACCESS} GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 8`).all({ uid: u.id, me }),
    });
  }));

  app.post('/api/users/:name/follow', requireAuth, writeLimiter, handler((req, res) => {
    const u = userByName(req.params.name);
    if (u.id === req.user.id) throw bad('Du kannst dir nicht selbst folgen.');
    const r = db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)').run(req.user.id, u.id, Date.now());
    if (r.changes) notify([u.id], 'follow', req.user.id);
    res.json({ following: true });
  }));

  app.delete('/api/users/:name/follow', requireAuth, writeLimiter, handler((req, res) => {
    const u = userByName(req.params.name);
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, u.id);
    res.json({ following: false });
  }));

  // Liste: wem folge ich / wer folgt mir
  app.get('/api/me/follows', requireAuth, handler((req, res) => {
    const me = req.user.id;
    res.json({
      following: db.prepare('SELECT u.username FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY u.username').all(me).map((r) => r.username),
      followers: db.prepare('SELECT u.username FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY u.username').all(me).map((r) => r.username),
    });
  }));
}
