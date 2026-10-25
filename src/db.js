import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
      role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
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
  if (!hasColumn('quotes', 'share_token')) db.exec('ALTER TABLE quotes ADD COLUMN share_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_share_token ON quotes(share_token) WHERE share_token IS NOT NULL');
  return db;
}
