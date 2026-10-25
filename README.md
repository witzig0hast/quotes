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

## Docker

```bash
cp .env.example .env     # PUBLIC_URL und ggf. OIDC_* eintragen
docker compose up -d --build
```

Die App lauscht auf `127.0.0.1:3000` (Reverse-Proxy mit HTTPS davorschalten, z. B. Traefik/Caddy/nginx im selben Netzwerk wie authentik). Daten liegen im Volume `quotes-data` (`/data/quotes.db`). Der Container läuft als Nicht-Root, mit read-only-Dateisystem und ohne Linux-Capabilities.

## Caching (nginx, Cloudflare)

Die App sorgt selbst dafür, dass nach einem Deploy immer die neue Version geladen wird:

- **HTML** (`/`, `/s/…`) wird mit `Cache-Control: no-store` sowie `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control: no-store` und `X-Accel-Expires: 0` (nginx) ausgeliefert – kein Browser, Proxy oder CDN speichert es.
- **CSS/JS** liegen unter `/assets/<inhalts-hash>/app.js` bzw. `…/style.css`. Ändert sich eine Datei, ändert sich die URL; diese URLs sind daher `immutable` und dürfen beliebig lange gecacht werden – eine alte Version kann nicht mehr ausgeliefert werden.
- **API** wird nie gecacht. Jede Antwort enthält `X-App-Version`; offene Tabs zeigen nach einem Deploy „Neue Version verfügbar – Neu laden“.
- Die Version wird beim Start berechnet (Deploy = Neustart des Containers); in der Entwicklung bei jeder Anfrage.

Hinweise:
- **Cloudflare:** Keine Page-/Cache-Rule „Cache Everything“ für HTML bzw. `/api/*` setzen (falls vorhanden: für diese Pfade „Bypass“). Nach dem ersten Deploy dieser Version einmal *Caching → Purge Everything*, damit alte, noch bis zu 1 Stunde gültige Kopien von `/`, `/app.js` und `/style.css` verschwinden.
- **nginx:** Wenn `proxy_cache` aktiv ist, respektiert nginx `X-Accel-Expires: 0`. Header der App nicht mit `proxy_ignore_headers` oder eigenem `expires`/`add_header Cache-Control` überschreiben.

## Funktionen

- Registrierung/Login mit Passwort **oder SSO (OpenID Connect, z. B. authentik)**, Konto löschen
- **Benutzername frei wählbar und jederzeit änderbar** – SSO-Nutzer übernehmen ihren SSO-Namen nicht automatisch, sondern wählen beim ersten Login selbst (der SSO-Name ist nur ein Vorschlag)
- Zitate mit Person und Quelle anlegen, bearbeiten, löschen, durchsuchen
- **Personen markieren** (@benutzername mit Vorschlägen): Markierte sehen das Zitat – auch wenn es privat ist – und werden benachrichtigt
- **Benachrichtigungen** (Glocke + Hinweis direkt nach dem Einloggen), wenn man markiert wird, ein Zitat mit einem geteilt wird oder man zu einer Gruppe hinzugefügt wird
- Sichtbarkeit pro Zitat: **privat**, **geteilt** (mit Personen und/oder Gruppen) oder **öffentlich** (alle angemeldeten Nutzer)
- **Gruppen**: anlegen, Mitglieder hinzufügen/entfernen, umbenennen, verlassen, löschen; Zitate mit ganzen Gruppen teilen; eigene Gruppenansicht
- **Freigabe-Links**: Zitat per geheimem Link teilen, lesbar auch ohne Konto; jederzeit deaktivierbar
- Ansichten: Entdecken, Meine, Für mich (markiert/geteilt/Gruppen), Favoriten (♥)
- **#Tags** an Zitaten (mit Vorschlägen), Tag-Leiste mit den beliebtesten Tags; Klick auf Tag oder Person filtert
- Sortierung **Neueste / Beliebteste**, Suche über Text, Person, Quelle und Tags
- **Zitat des Tages** auf „Entdecken“ (aus den öffentlichen Zitaten, täglich neu)
- **Zitat als Bild** (1080 × 1350, hell oder dunkel) herunterladen oder direkt teilen; Zitat mit einem Tipp kopieren
- **Export** der eigenen Zitate als CSV (Excel) oder JSON – und **Import** aus CSV (Excel, Spalten „Zitat“/„text“, „Person“, optional „Quelle“, „Tags“) oder JSON; Doppelte werden übersprungen
- **Sammlungen**: eigene Listen („Für schlechte Tage“, „Hochzeitsrede“ …) unter *Meine → Sammlungen*; Zitate über das ⋯-Menü hinzufügen; mit Gruppen oder per geheimem Link teilen. Wer eine Sammlung sieht, sieht darin die eigenen Zitate des Eigentümers und alles, was er ohnehin sehen darf – fremde private Zitate nie
- **Personen-Seiten**: Klick auf eine Person zeigt Anzahl, Tags und (optional) eine Kurzbeschreibung von Wikipedia (`WIKIPEDIA=off` schaltet das ab, `WIKIPEDIA_LANG=en` wechselt die Sprache)
- **Überrasch mich**: zufälliges Zitat aus Entdecken, Meine oder Favoriten
- **Duplikat-Hinweis** beim Anlegen – erkennt dasselbe Zitat auch mit anderer Schreibweise (Groß/Klein, Satzzeichen, Umlaute)
- Löschen mit **Rückgängig**, automatisches Nachladen beim Scrollen, Ladeplatzhalter
- Handy: Navigationsleiste unten mit „+“ in der Mitte; Desktop: Tabs oben
- Farbschema **System / Hell / Dunkel** umschaltbar; Tastenkürzel `N` (neues Zitat), `/` (Suche), `Strg/⌘ + Enter` (speichern)
- Schwarz-Weiß-Design, Hell-/Dunkelmodus automatisch, responsiv (Handy bis Desktop)

## Sicherheit

- Passwörter mit scrypt + Salt, Mindestlänge 10; Login ohne User-Enumeration (auch Timing)
- Session-Token zufällig, nur als SHA-256-Hash in der DB; Cookie `HttpOnly`, `SameSite=Strict`, `Secure` in Produktion
- CSRF-Token (Header) für alle schreibenden Requests
- Strikte CSP (kein Inline-Script/-Style), Helmet-Header; UI setzt Nutzerinhalte nur per `textContent`
- Parametrisierte SQL-Queries, serverseitige Validierung, Body-Limit, Rate-Limits für Login/Schreiben
- Zugriffsprüfung serverseitig für jedes Zitat (Fremde erhalten 404, sehen keine Empfängerlisten)
- Markierungen, Freigaben und Gruppen hängen an der Nutzer-ID, nicht am Namen – Umbenennen bricht nichts
- Benachrichtigungen werden nur angezeigt, solange man das Zitat noch sehen darf bzw. noch Gruppenmitglied ist
- Freigabe-Links: 192-Bit-Zufallstoken, nur vom Eigentümer erstell-/widerrufbar, Seite mit `noindex`; die öffentliche Ansicht zeigt nur Text, Person, Quelle und Autor (keine Markierungen, Empfänger oder Likes)
- Gruppen: nur der Besitzer verwaltet Mitglieder; teilen nur mit Gruppen, in denen man Mitglied ist

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

**Bestehendes Konto verknüpfen:** Wer schon ein Passwort-Konto hat, kann es unter *Konto → Anmeldung mit authentik* mit SSO verknüpfen (Passwort-Bestätigung nötig). Danach führt der SSO-Login in genau dieses Konto – Name, Zitate und Gruppen bleiben erhalten, der Passwort-Login funktioniert weiterhin. Die Verknüpfung lässt sich dort auch wieder lösen (ebenfalls mit Passwort; reine SSO-Konten ohne Passwort können sich so nicht aussperren). Eine SSO-Identität, die bereits zu einem anderen Konto gehört, wird nie übernommen.

Neue SSO-Nutzer bekommen ihren Benutzernamen aus `preferred_username` vorgeschlagen (bei Konflikt mit Suffix) und wählen beim ersten Login selbst. Konten werden **ausschließlich über (Issuer, `sub`)** verknüpft – nie über E-Mail oder Namen, damit niemand ein bestehendes Konto übernehmen kann.

Sicherheit des SSO-Flows: PKCE (S256), `state` + `nonce`, einmalig verwendbare Login-Vorgänge (10 min), Bindung an den Browser per HttpOnly-Cookie (gegen Login-CSRF), ID-Token-Prüfung (Signatur per JWKS, Issuer, Audience, Ablauf, Nonce; nur asymmetrische Algorithmen), Issuer-Abgleich der Discovery, HTTPS-Pflicht (außer localhost).
