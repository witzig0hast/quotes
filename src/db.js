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
  `);
  return db;
}
