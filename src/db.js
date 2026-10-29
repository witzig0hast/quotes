import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normText } from './util.js';

export function openDb(file = process.env.DB_FILE || 'data/quotes.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      person     TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared','public')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quotes_user ON quotes(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotes_vis  ON quotes(visibility, created_at DESC);

    CREATE TABLE IF NOT EXISTS quote_shares (
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (quote_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shares_user ON quote_shares(user_id);

    -- SSO: Verknüpfung (Issuer, Subject) -> lokaler Nutzer. Nie per E-Mail/Username verknüpfen.
    CREATE TABLE IF NOT EXISTS identities (
      issuer  TEXT NOT NULL,
      sub     TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (issuer, sub)
    );

    -- Laufende Logins (einmalig verwendbar, 10 Minuten gültig)
    CREATE TABLE IF NOT EXISTS oidc_flows (
      state_hash TEXT PRIMARY KEY,
      bind_hash  TEXT NOT NULL,
      nonce      TEXT NOT NULL,
      verifier   TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS likes (
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (quote_id, user_id)
    );

    -- Markierte Nutzer: sehen das Zitat immer und werden benachrichtigt
    CREATE TABLE IF NOT EXISTS quote_mentions (
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (quote_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_user ON quote_mentions(user_id);

    -- Gruppen ("groups" ist in SQLite ein Schlüsselwort)
    CREATE TABLE IF NOT EXISTS user_groups (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
      added_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_user ON group_members(user_id);
    CREATE TABLE IF NOT EXISTS quote_groups (
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (quote_id, group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_quote_groups_group ON quote_groups(group_id);

    -- Schlagwörter (#tags), normalisiert: klein, ohne #
    CREATE TABLE IF NOT EXISTS quote_tags (
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      tag      TEXT NOT NULL,
      PRIMARY KEY (quote_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON quote_tags(tag);

    -- Sammlungen (Ordner) für Zitate; sichtbar für Eigentümer, freigegebene Gruppen und per geheimem Link
    CREATE TABLE IF NOT EXISTS collections (
      id          INTEGER PRIMARY KEY,
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      share_token TEXT UNIQUE,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_id);
    CREATE TABLE IF NOT EXISTS collection_quotes (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      quote_id      INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      added_at      INTEGER NOT NULL,
      PRIMARY KEY (collection_id, quote_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cq_quote ON collection_quotes(quote_id);
    CREATE TABLE IF NOT EXISTS collection_groups (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      group_id      INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (collection_id, group_id)
    );

    -- Kommentare unter Zitaten
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY,
      quote_id   INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_quote ON comments(quote_id, created_at);

    -- Folgen
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (follower_id, followee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

    -- Einladungslinks für Gruppen (Token nur als Hash gespeichert)
    CREATE TABLE IF NOT EXISTS group_invites (
      id         INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      group_id   INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      max_uses   INTEGER,
      uses       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Verbesserungsvorschläge zu fremden Zitaten (Text, Person, Quelle)
    CREATE TABLE IF NOT EXISTS suggestions (
      id         INTEGER PRIMARY KEY,
      quote_id   INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      field      TEXT NOT NULL CHECK (field IN ('text','person','source')),
      value      TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_quote ON suggestions(quote_id, status);

    -- Meldungen (Zitate oder Kommentare) mit Momentaufnahme des Inhalts für die Prüfung
    CREATE TABLE IF NOT EXISTS reports (
      id          INTEGER PRIMARY KEY,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      quote_id    INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
      comment_id  INTEGER REFERENCES comments(id) ON DELETE SET NULL,
      target_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason      TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      snapshot    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
      created_at  INTEGER NOT NULL,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

    -- Web-Push-Abos (ein Eintrag pro Gerät/Browser)
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

    -- Einstellungen der Instanz (z. B. zufälliges Geheimnis für Abmeldelinks)
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- API-Schlüssel (nur Hash gespeichert; prefix nur zur Anzeige)
    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      prefix       TEXT NOT NULL,
      scope        TEXT NOT NULL CHECK (scope IN ('read','write')),
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );

    -- Webhooks: bei Ereignissen eine signierte POST-Anfrage an eine URL
    CREATE TABLE IF NOT EXISTS webhooks (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      secret     TEXT NOT NULL,
      events     TEXT NOT NULL,
      format     TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json','slack','discord')),
      active     INTEGER NOT NULL DEFAULT 1,
      failures   INTEGER NOT NULL DEFAULT 0,
      last_status TEXT,
      last_at    INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Zwischenspeicher für Wikipedia-Kurzbeschreibungen (Personen-Seiten)
    CREATE TABLE IF NOT EXISTS wiki_cache (
      name       TEXT PRIMARY KEY,
      data       TEXT,
      fetched_at INTEGER NOT NULL
    );

    -- type wird in der App geprüft (mention, share, group_add, comment, follow, suggestion, …);
    -- ref_id verweist je nach Typ z. B. auf einen Kommentar oder Vorschlag.
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      quote_id   INTEGER REFERENCES quotes(id) ON DELETE CASCADE,
      group_id   INTEGER REFERENCES user_groups(id) ON DELETE CASCADE,
      ref_id     INTEGER,
      created_at INTEGER NOT NULL,
      read_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
  `);

  // Migrationen für bestehende Datenbanken
  // Alte notifications-Tabelle erlaubte per CHECK nur 3 Typen -> verlustfrei neu aufbauen
  const notifSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get()?.sql ?? '';
  if (/CHECK\s*\(type IN/i.test(notifSql)) {
    db.exec(`
      BEGIN;
      CREATE TABLE notifications_new (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE,
        group_id INTEGER REFERENCES user_groups(id) ON DELETE CASCADE,
        ref_id INTEGER,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );
      INSERT INTO notifications_new (id, user_id, type, actor_id, quote_id, group_id, created_at, read_at)
        SELECT id, user_id, type, actor_id, quote_id, group_id, created_at, read_at FROM notifications;
      DROP TABLE notifications;
      ALTER TABLE notifications_new RENAME TO notifications;
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
      COMMIT;
    `);
  }
  const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  // 0 = Benutzername wurde automatisch vergeben (SSO) und noch nicht bestätigt
  if (!hasColumn('users', 'username_set')) db.exec('ALTER TABLE users ADD COLUMN username_set INTEGER NOT NULL DEFAULT 1');
  // Gesetzt, wenn ein angemeldeter Nutzer sein bestehendes Konto mit SSO verknüpft (statt Login)
  if (!hasColumn('oidc_flows', 'link_user_id')) db.exec('ALTER TABLE oidc_flows ADD COLUMN link_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  // E-Mail (optional, nur bestätigt nutzbar) + Wochenrückblick
  for (const [col, def] of [['email', 'TEXT'], ['email_verified', 'INTEGER NOT NULL DEFAULT 0'], ['email_token_hash', 'TEXT'],
    ['email_token_expires', 'INTEGER'], ['digest', 'INTEGER NOT NULL DEFAULT 0'], ['last_digest_at', 'INTEGER']]) {
    if (!hasColumn('users', col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  }
  // Zwei-Faktor (TOTP) + Wiederherstellungscodes (nur Hashes)
  for (const [col, def] of [['totp_secret', 'TEXT'], ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['totp_last_step', 'INTEGER NOT NULL DEFAULT 0'], ['recovery_codes', 'TEXT']]) {
    if (!hasColumn('users', col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS login_tickets (
    ticket_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`);
  if (!hasColumn('users', 'is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('users', 'disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  // Gruppen-Rollen: alte Tabelle erlaubte nur owner/member -> um "admin" erweitern (verlustfrei)
  const gmSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_members'").get()?.sql ?? '';
  if (/role IN \('owner','member'\)/.test(gmSql)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE group_members_new (
        group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );
      INSERT INTO group_members_new SELECT group_id, user_id, role, added_at FROM group_members;
      DROP TABLE group_members;
      ALTER TABLE group_members_new RENAME TO group_members;
      CREATE INDEX IF NOT EXISTS idx_members_user ON group_members(user_id);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  if (!hasColumn('quotes', 'text_norm')) {
    db.exec("ALTER TABLE quotes ADD COLUMN text_norm TEXT NOT NULL DEFAULT ''");
    const upd = db.prepare('UPDATE quotes SET text_norm = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, text FROM quotes').all()) upd.run(normText(r.text), r.id);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_quotes_norm ON quotes(text_norm)');
  if (!hasColumn('quotes', 'share_token')) db.exec('ALTER TABLE quotes ADD COLUMN share_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_share_token ON quotes(share_token) WHERE share_token IS NOT NULL');
  return db;
}
