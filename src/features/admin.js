// Melden + Admin-Bereich: Übersicht, Meldungen prüfen, Nutzer sperren/Admin-Rechte vergeben.
// Erste Admins über ADMIN_USERS=name1,name2 (diese bleiben immer Admin); weitere können im Admin-Bereich ernannt werden.
import { statSync } from 'node:fs';
import { bad, clean, notFound, forbidden, handler, intParam, escapeLike } from '../util.js';

const REASONS = { spam: 'Spam', offensive: 'Beleidigend / Hass', false: 'Falsche Zuschreibung', private: 'Private Daten', other: 'Sonstiges' };

export function registerAdmin(app, ctx) {
  const { db, requireAuth, writeLimiter, readLimiter, ACCESS, tx } = ctx;
  const envAdmins = new Set((process.env.ADMIN_USERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

  const isAdmin = (userId) => {
    const u = db.prepare('SELECT username, is_admin FROM users WHERE id = ?').get(userId);
    return !!u && (u.is_admin === 1 || envAdmins.has(u.username.toLowerCase()));
  };
  ctx.isAdmin = isAdmin;
  const requireAdmin = (req, res, next) => (isAdmin(req.user.id) ? next() : next(notFound()));

  app.get('/api/reasons', requireAuth, (req, res) => res.json({ reasons: REASONS }));

  // --- Melden (jeder angemeldete Nutzer, nur sichtbare Inhalte) ---
  app.post('/api/reports', requireAuth, writeLimiter, handler((req, res) => {
    const me = req.user.id;
    const reason = req.body?.reason;
    if (!REASONS[reason]) throw bad('Bitte einen Grund wählen.');
    const note = clean(req.body?.note ?? '', 500);
    if (note.length > 500) throw bad('Die Anmerkung ist zu lang (max. 500 Zeichen).');
    let target;
    if (req.body?.quoteId) {
      const q = db.prepare(`SELECT q.id, q.user_id, q.text, q.person, q.source FROM quotes q WHERE q.id = @id AND ${ACCESS}`).get({ id: intParam(req.body.quoteId), me });
      if (!q) throw notFound();
      target = { quote_id: q.id, comment_id: null, target_user: q.user_id, snapshot: `„${q.text}“ — ${q.person}${q.source ? `, ${q.source}` : ''}` };
    } else if (req.body?.commentId) {
      const c = db.prepare(`SELECT c.id, c.user_id, c.body, c.quote_id FROM comments c JOIN quotes q ON q.id = c.quote_id WHERE c.id = @id AND ${ACCESS}`).get({ id: intParam(req.body.commentId), me });
      if (!c) throw notFound();
      target = { quote_id: c.quote_id, comment_id: c.id, target_user: c.user_id, snapshot: c.body };
    } else throw bad('Was soll gemeldet werden?');
    if (target.target_user === me) throw bad('Eigene Inhalte kannst du selbst löschen.');
    const dupe = db.prepare(`SELECT 1 FROM reports WHERE reporter_id = ? AND status = 'open' AND quote_id IS ? AND comment_id IS ?`)
      .get(me, target.quote_id, target.comment_id);
    if (dupe) return res.json({ ok: true, duplicate: true });
    db.prepare('INSERT INTO reports (reporter_id, quote_id, comment_id, target_user, reason, note, snapshot, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(me, target.quote_id, target.comment_id, target.target_user, reason, note, target.snapshot.slice(0, 1200), Date.now());
    res.status(201).json({ ok: true });
  }));

  // --- Admin ---
  app.get('/api/admin/overview', requireAuth, requireAdmin, handler((req, res) => {
    const n = (sql) => db.prepare(sql).get().n;
    let dbSize = null;
    try { const f = process.env.DB_FILE || 'data/quotes.db'; dbSize = statSync(f).size + (statSync(`${f}-wal`, { throwIfNoEntry: false })?.size ?? 0); } catch { /* :memory: */ }
    res.json({
      users: n('SELECT COUNT(*) AS n FROM users'), disabled: n('SELECT COUNT(*) AS n FROM users WHERE disabled = 1'),
      quotes: n('SELECT COUNT(*) AS n FROM quotes'), publicQuotes: n("SELECT COUNT(*) AS n FROM quotes WHERE visibility = 'public'"),
      comments: n('SELECT COUNT(*) AS n FROM comments'), groups: n('SELECT COUNT(*) AS n FROM user_groups'),
      collections: n('SELECT COUNT(*) AS n FROM collections'), openReports: n("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
      newUsers7d: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').get(Date.now() - 7 * 86_400_000).n,
      newQuotes7d: db.prepare('SELECT COUNT(*) AS n FROM quotes WHERE created_at > ?').get(Date.now() - 7 * 86_400_000).n,
      dbSize,
    });
  }));

  app.get('/api/admin/reports', requireAuth, requireAdmin, handler((req, res) => {
    const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
    const rows = db.prepare(`SELECT r.*, ru.username AS reporter, tu.username AS target, au.username AS resolver,
                               (r.comment_id IS NOT NULL) AS isComment,
                               (CASE WHEN r.comment_id IS NOT NULL THEN EXISTS(SELECT 1 FROM comments c WHERE c.id = r.comment_id)
                                     ELSE EXISTS(SELECT 1 FROM quotes q WHERE q.id = r.quote_id) END) AS stillExists
                             FROM reports r JOIN users ru ON ru.id = r.reporter_id
                             LEFT JOIN users tu ON tu.id = r.target_user LEFT JOIN users au ON au.id = r.resolved_by
                             WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`).all(status);
    res.json({ reports: rows.map((r) => ({
      id: r.id, kind: r.isComment ? 'comment' : 'quote', reason: r.reason, reasonLabel: REASONS[r.reason] ?? r.reason, note: r.note,
      snapshot: r.snapshot, reporter: r.reporter, target: r.target, status: r.status, createdAt: r.created_at,
      resolver: r.resolver, resolvedAt: r.resolved_at, stillExists: !!r.stillExists,
    })) });
  }));

  // Meldung erledigen: verwerfen oder Inhalt löschen (alle offenen Meldungen zum selben Inhalt werden mit erledigt)
  app.post('/api/admin/reports/:rid', requireAuth, requireAdmin, writeLimiter, handler((req, res) => {
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(intParam(req.params.rid));
    if (!r) throw notFound();
    const action = req.body?.action;
    if (!['dismiss', 'delete'].includes(action)) throw bad('Aktion muss dismiss oder delete sein.');
    // Erst alle offenen Meldungen zum selben Inhalt erledigen, dann löschen
    // (beim Löschen setzt die DB die Verweise in reports auf NULL – danach wären sie nicht mehr zuzuordnen)
    const base = { s: action === 'delete' ? 'resolved' : 'dismissed', me: req.user.id, now: Date.now(), id: r.id };
    const update = (cond, extra) => db.prepare(`UPDATE reports SET status = @s, resolved_by = @me, resolved_at = @now
                                                WHERE (id = @id OR (${cond})) AND status = 'open'`).run({ ...base, ...extra });
    tx(() => {
      if (r.comment_id) update('comment_id = @c', { c: r.comment_id });
      else if (r.quote_id) update('quote_id = @q AND comment_id IS NULL', { q: r.quote_id });
      else update('0', {});
      if (action === 'delete') {
        if (r.comment_id) db.prepare('DELETE FROM comments WHERE id = ?').run(r.comment_id);
        else if (r.quote_id) db.prepare('DELETE FROM quotes WHERE id = ?').run(r.quote_id);
      }
    });
    res.json({ ok: true });
  }));

  app.get('/api/admin/users', requireAuth, requireAdmin, readLimiter, handler((req, res) => {
    const q = clean(String(req.query.q ?? ''), 30).slice(0, 30);
    const rows = db.prepare(`SELECT u.id, u.username, u.created_at, u.is_admin, u.disabled,
                               (u.password_hash = '!') AS sso,
                               (SELECT COUNT(*) FROM quotes q WHERE q.user_id = u.id) AS quotes,
                               (SELECT COUNT(*) FROM reports r WHERE r.target_user = u.id) AS reports
                             FROM users u WHERE u.username LIKE ? ESCAPE '\\' ORDER BY u.created_at DESC LIMIT 100`).all(`%${escapeLike(q)}%`);
    res.json({ users: rows.map((u) => ({
      id: u.id, username: u.username, createdAt: u.created_at, sso: !!u.sso, quotes: u.quotes, reports: u.reports,
      disabled: !!u.disabled, admin: !!u.is_admin || envAdmins.has(u.username.toLowerCase()), fixedAdmin: envAdmins.has(u.username.toLowerCase()),
    })) });
  }));

  app.post('/api/admin/users/:uid', requireAuth, requireAdmin, writeLimiter, handler((req, res) => {
    const uid = intParam(req.params.uid);
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(uid);
    if (!u) throw notFound();
    if (uid === req.user.id) throw forbidden('Du kannst dich nicht selbst sperren oder deine Admin-Rechte entziehen.');
    if (typeof req.body?.disabled === 'boolean') {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(req.body.disabled ? 1 : 0, uid);
      if (req.body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid); // sofort abmelden
    }
    if (typeof req.body?.admin === 'boolean') {
      if (!req.body.admin && envAdmins.has(u.username.toLowerCase())) throw bad('Dieser Admin ist über ADMIN_USERS festgelegt.');
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.admin ? 1 : 0, uid);
    }
    res.json({ ok: true });
  }));
}
