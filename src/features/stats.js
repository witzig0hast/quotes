// Persönliche Statistik: Kennzahlen, Top-Personen/-Tags, Zitate pro Monat, Serien.
import { handler } from '../util.js';

const DAY = 86_400_000;

export function registerStats(app, ctx) {
  const { db, requireAuth, readLimiter } = ctx;

  app.get('/api/stats', requireAuth, readLimiter, handler((req, res) => {
    const me = req.user.id;
    const one = (sql, ...a) => db.prepare(sql).get(...a).n;
    const byVis = Object.fromEntries(db.prepare('SELECT visibility, COUNT(*) AS n FROM quotes WHERE user_id = ? GROUP BY visibility').all(me).map((r) => [r.visibility, r.n]));
    const total = (byVis.private ?? 0) + (byVis.shared ?? 0) + (byVis.public ?? 0);

    // Zitate pro Monat (letzte 12 Monate, UTC), auch leere Monate
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
      return d.toISOString().slice(0, 7);
    });
    const counts = Object.fromEntries(db.prepare(`SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS m, COUNT(*) AS n
                                                  FROM quotes WHERE user_id = ? AND created_at >= ? GROUP BY m`)
      .all(me, Date.parse(`${months[0]}-01T00:00:00Z`)).map((r) => [r.m, r.n]));

    // Serien: Tage (UTC) mit mindestens einem neuen Zitat
    const days = db.prepare(`SELECT DISTINCT CAST(created_at / ${DAY} AS INTEGER) AS d FROM quotes WHERE user_id = ? ORDER BY d`).all(me).map((r) => r.d);
    let longest = 0, run = 0;
    for (let i = 0; i < days.length; i++) { run = i && days[i] === days[i - 1] + 1 ? run + 1 : 1; longest = Math.max(longest, run); }
    const today = Math.floor(Date.now() / DAY);
    const set = new Set(days);
    let current = 0;
    for (let d = set.has(today) ? today : today - 1; set.has(d); d--) current++; // heute noch offen -> Serie bis gestern zählt

    res.json({
      total, byVisibility: { private: byVis.private ?? 0, shared: byVis.shared ?? 0, public: byVis.public ?? 0 },
      likesReceived: one('SELECT COUNT(*) AS n FROM likes l JOIN quotes q ON q.id = l.quote_id WHERE q.user_id = ? AND l.user_id != ?', me, me),
      likesGiven: one('SELECT COUNT(*) AS n FROM likes WHERE user_id = ?', me),
      comments: one('SELECT COUNT(*) AS n FROM comments WHERE user_id = ?', me),
      collections: one('SELECT COUNT(*) AS n FROM collections WHERE owner_id = ?', me),
      followers: one('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', me),
      topPeople: db.prepare('SELECT MIN(person) AS name, COUNT(*) AS count FROM quotes WHERE user_id = ? GROUP BY person COLLATE NOCASE ORDER BY count DESC, person LIMIT 5').all(me),
      topTags: db.prepare('SELECT t.tag, COUNT(*) AS count FROM quote_tags t JOIN quotes q ON q.id = t.quote_id WHERE q.user_id = ? GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 8').all(me),
      perMonth: months.map((m) => ({ month: m, count: counts[m] ?? 0 })),
      streak: { current, longest, activeToday: set.has(today) },
    });
  }));
}
