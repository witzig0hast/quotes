# Quotes

Moderne, sichere Web-App, um Zitate von Personen zu sammeln und mit anderen Nutzern zu teilen.

## Start

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Benötigt Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`). Daten liegen in `data/quotes.db`.

| Variable | Bedeutung |
|---|---|
| `PORT` | Port (Standard 3000) |
| `DB_FILE` | Pfad der SQLite-Datei |
| `NODE_ENV=production` | Secure-Cookies, HSTS – nur hinter HTTPS betreiben |
| `TRUST_PROXY` | Anzahl Proxys (z. B. `1`), damit Rate-Limits die echte Client-IP nutzen |
| `OIDC_*`, `PUBLIC_URL` | SSO, siehe unten |

## Funktionen

- Registrierung/Login mit Passwort **oder SSO (OpenID Connect, z. B. authentik)**, Konto löschen
- Zitate mit Person und Quelle anlegen, bearbeiten, löschen, durchsuchen
- Sichtbarkeit pro Zitat: **privat**, **bestimmte Nutzer** oder **öffentlich** (alle angemeldeten Nutzer)
- Ansichten: Entdecken, Meine, Geteilt (mit mir), Favoriten (♥)
- Schwarz-Weiß-Design, Hell-/Dunkelmodus automatisch, responsiv (Handy bis Desktop)

## Sicherheit

- Passwörter mit scrypt + Salt, Mindestlänge 10; Login ohne User-Enumeration (auch Timing)
- Session-Token zufällig, nur als SHA-256-Hash in der DB; Cookie `HttpOnly`, `SameSite=Strict`, `Secure` in Produktion
- CSRF-Token (Header) für alle schreibenden Requests
- Strikte CSP (kein Inline-Script/-Style), Helmet-Header; UI setzt Nutzerinhalte nur per `textContent`
- Parametrisierte SQL-Queries, serverseitige Validierung, Body-Limit, Rate-Limits für Login/Schreiben
- Zugriffsprüfung serverseitig für jedes Zitat (Fremde erhalten 404, sehen keine Empfängerlisten)

## SSO mit authentik (oder jedem OpenID-Connect-Anbieter)

Funktioniert mit authentik, Keycloak, Authelia, Google, Microsoft Entra ID u. a. (Authorization-Code-Flow mit PKCE).

**1. In authentik** → *Anwendungen → Anwendungen → Mit Provider erstellen* → Provider-Typ **OAuth2/OpenID**:

- Client-Typ: **Vertraulich**
- Umleitungs-URI (strikt): `https://quotes.example.com/api/auth/oidc/callback`
- Scopes: `openid`, `profile`, `email`
- **Signaturschlüssel: ein RSA-Zertifikat auswählen** (z. B. „authentik Self-signed Certificate"). Ohne Schlüssel signiert authentik mit HS256 – das akzeptiert die App aus Sicherheitsgründen nicht.
- Client-ID und Client-Secret notieren; die Anwendung bekommt z. B. den Slug `quotes`.

**2. Die App starten** mit:

```bash
PUBLIC_URL=https://quotes.example.com \
OIDC_ISSUER=https://auth.example.com/application/o/quotes/ \
OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... \
OIDC_NAME=authentik \
NODE_ENV=production npm start
```

| Variable | Bedeutung |
|---|---|
| `PUBLIC_URL` | Öffentliche URL der App (bestimmt die Redirect-URI – bewusst nicht aus dem Host-Header abgeleitet) |
| `OIDC_ISSUER` | Issuer-URL des Providers, **exakt** wie in `…/.well-known/openid-configuration` (bei authentik mit abschließendem `/`) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Zugangsdaten des Providers |
| `OIDC_NAME` | Beschriftung des Buttons („Mit … anmelden"), Standard `SSO` |
| `OIDC_SCOPES` | Standard `openid profile email` |
| `OIDC_ALLOW_SIGNUP=false` | Nur bereits bekannte SSO-Nutzer dürfen sich anmelden, keine Neuanlage |
| `OIDC_PASSWORD_LOGIN=false` | Passwort-Login und -Registrierung abschalten, nur SSO |

Neue SSO-Nutzer erhalten ihren Benutzernamen aus `preferred_username` (bei Konflikt mit Suffix). Konten werden **ausschließlich über (Issuer, `sub`)** verknüpft – nie über E-Mail oder Namen, damit niemand ein bestehendes Konto übernehmen kann.

Sicherheit des SSO-Flows: PKCE (S256), `state` + `nonce`, einmalig verwendbare Login-Vorgänge (10 min), Bindung an den Browser per HttpOnly-Cookie (gegen Login-CSRF), ID-Token-Prüfung (Signatur per JWKS, Issuer, Audience, Ablauf, Nonce; nur asymmetrische Algorithmen), Issuer-Abgleich der Discovery, HTTPS-Pflicht (außer localhost).
