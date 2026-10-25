// Personen-Seiten, Personen-Vorschläge, Zufallszitat und Duplikat-Prüfung.
import { clean, notFound, handler, intParam, escapeLike, normText } from '../util.js';

const WIKI_TTL = 7 * 24 * 3600 * 1000;

export function registerPeople(app, ctx) {
  const { db, requireAuth, readLimiter, ACCESS, BASE, shape, getOne } = ctx;
  const wikiEnabled = process.env.WIKIPEDIA !== 'off';
  const wikiLang = /^[a-z]{2,3}$/.test(process.env.WIKIPEDIA_LANG ?? '') ? process.env.WIKIPEDIA_LANG : 'de';

  // Kurzbeschreibung von Wikipedia (serverseitig, mit Zwischenspeicher; abschaltbar mit WIKIPEDIA=off)
  async function wiki(name) {
    if (!wikiEnabled) return null;
    const key = `${wikiLang}:${name.toLowerCase()}`;
    const cached = db.prepare('SELECT data, fetched_at FROM wiki_cache WHERE name = ?').get(key);
    if (cached && Date.now() - cached.fetched_at < WIKI_TTL) return cached.data ? JSON.parse(cached.data) : null;
    let data = null;
    try {
      const url = `https://${wikiLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, '_'))}?redirect=true`;
      const r = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json', 'user-agent': 'Quotes-App (Personen-Seiten)' } });
      if (r.ok) {
        const j = await r.json();
        // Nur echte Artikel (keine Begriffsklärungen), nur https-Links von Wikipedia/Wikimedia
        const thumb = j.thumbnail?.source;
        const page = j.content_urls?.desktop?.page;
        if (j.type === 'standard' && typeof j.extract === 'string') {
          data = {
            title: String(j.title ?? name).slice(0, 200),
            description: typeof j.description === 'string' ? j.description.slice(0, 200) : '',
            extract: j.extract.slice(0, 700),
            url: typeof page === 'string' && /^https:\/\/[a-z-]+\.wikipedia\.org\//.test(page) ? page : null,
            thumbnail: typeof thumb === 'string' && thumb.startsWith('https://upload.wikimedia.org/') ? thumb : null,
          };
        }
      } else if (r.status !== 404) return null; // Fehler nicht cachen
    } catch { return null; }
    db.prepare('INSERT OR REPLACE INTO wiki_cache (name, data, fetched_at) VALUES (?,?,?)').run(key, data ? JSON.stringify(data) : null, Date.now());
    return data;
  }

  // Personen-Seite: Kennzahlen aus allen für mich sichtbaren Zitaten + optional Wikipedia
  app.get('/api/people/:name', requireAuth, readLimiter, handler(async (req, res) => {
    const name = clean(req.params.name, 100);
    if (!name) throw notFound();
    const me = req.user.id;
    const stats = db.prepare(`SELECT COUNT(*) AS count, MIN(q.created_at) AS firstAt, MAX(q.person) AS person,
                                COUNT(DISTINCT q.user_id) AS collectors
                              FROM quotes q WHERE q.person = @name COLLATE NOCASE AND ${ACCESS}`).get({ name, me });
    if (!stats.count) throw notFound('Zu dieser Person gibt es keine sichtbaren Zitate.');
    const tags = db.prepare(`SELECT t.tag, COUNT(*) AS count FROM quote_tags t JOIN quotes q ON q.id = t.quote_id
                             WHERE q.person = @name COLLATE NOCASE AND ${ACCESS} GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 8`).all({ name, me });
    res.json({ name: stats.person, count: stats.count, collectors: stats.collectors, firstAt: stats.firstAt, tags, wiki: await wiki(stats.person) });
  }));

  // Vorschläge für das Personen-Feld im Editor (aus sichtbaren Zitaten)
  app.get('/api/people', requireAuth, readLimiter, handler((req, res) => {
    const q = clean(String(req.query.q ?? ''), 50).slice(0, 50);
    if (!q) return res.json({ people: [] });
    const rows = db.prepare(`SELECT q.person, COUNT(*) AS n FROM quotes q WHERE q.person LIKE @q ESCAPE '\\' AND ${ACCESS}
                             GROUP BY q.person COLLATE NOCASE ORDER BY n DESC, q.person LIMIT 8`).all({ q: `%${escapeLike(q)}%`, me: req.user.id });
    res.json({ people: rows.map((r) => r.person) });
  }));

  // Zufallszitat ("Überrasch mich") aus Entdecken, Meine oder Favoriten
  app.get('/api/random', requireAuth, readLimiter, handler((req, res) => {
    const me = req.user.id;
    const where = { mine: 'q.user_id = @me', liked: `${ACCESS} AND EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = @me)` }[req.query.scope]
      ?? ACCESS;
    const exclude = req.query.not ? intParam(req.query.not) : 0;
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM quotes q WHERE ${where} AND q.id != @ex`).get({ me, ex: exclude });
    if (!n) return res.json({ quote: null });
    const row = db.prepare(`${BASE} WHERE ${where} AND q.id != @ex ORDER BY q.id LIMIT 1 OFFSET @off`)
      .get({ me, ex: exclude, off: Math.floor(Math.random() * n) });
    res.json({ quote: shape([row])[0] });
  }));

  // Duplikat-Prüfung beim Anlegen: eigenes gleiches Zitat? Oder schon öffentlich vorhanden?
  app.get('/api/quotes-check', requireAuth, readLimiter, handler((req, res) => {
    const norm = normText(clean(String(req.query.text ?? ''), 1000));
    if (norm.length < 12) return res.json({ own: null, existing: null });
    const me = req.user.id;
    const exclude = req.query.exclude ? intParam(req.query.exclude) : 0;
    const own = db.prepare('SELECT id FROM quotes WHERE user_id = ? AND text_norm = ? AND id != ? LIMIT 1').get(me, norm, exclude);
    const other = own ? null : db.prepare(`SELECT q.id FROM quotes q WHERE q.text_norm = @norm AND q.user_id != @me AND ${ACCESS}
                                            ORDER BY (SELECT COUNT(*) FROM likes l WHERE l.quote_id = q.id) DESC LIMIT 1`).get({ norm, me });
    res.json({ own: own ? getOne(own.id, me) : null, existing: other ? getOne(other.id, me) : null });
  }));
}
