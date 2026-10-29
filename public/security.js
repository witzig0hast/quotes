// Sicherheit (Passkeys, Zwei-Faktor) und Integrationen (API-Schlüssel, Webhooks).
import { h, api, toast, modal, icon, state, fmtDate, relTime, plural, t, LOCALE, LANG } from './core.js';

// ---------- WebAuthn: JSON <-> Binärdaten ----------
const toBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)).buffer;
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const passkeysSupported = () => !!window.PublicKeyCredential && !!navigator.credentials;

async function createCredential(o) {
  const cred = await navigator.credentials.create({ publicKey: {
    ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ ...c, id: toBuf(c.id) })),
  } });
  return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: { clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject),
      transports: cred.response.getTransports?.() ?? [] } };
}
async function getCredential(o) {
  const cred = await navigator.credentials.get({ publicKey: {
    ...o, challenge: toBuf(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((c) => ({ ...c, id: toBuf(c.id) })),
  } });
  const r = cred.response;
  return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature),
      userHandle: r.userHandle ? toB64u(r.userHandle) : undefined } };
}
/** Abbruch durch Nutzer (Dialog geschlossen) nicht als Fehler melden. */
const cancelled = (ex) => ex?.name === 'NotAllowedError' || ex?.name === 'AbortError';

// ---------- Login ----------
/** Knopf „Mit Passkey anmelden“. onResult bekommt die Login-Antwort (Sitzung oder twoFactor-Ticket). */
export function passkeyLoginButton(onResult, onError) {
  if (!passkeysSupported()) return null;
  const btn = h('button', { class: 'btn block passkey-btn', type: 'button', onclick: async () => {
    btn.disabled = true;
    try {
      const { flow, options } = await api('POST', '/api/login/passkey/options');
      const response = await getCredential(options);
      onResult(await api('POST', '/api/login/passkey', { flow, response }));
    } catch (ex) { if (!cancelled(ex)) onError(ex.message); } finally { btn.disabled = false; }
  } }, icon('fingerprint'), h('span', {}, t('Mit Passkey anmelden')));
  return btn;
}

/** Zweiter Login-Schritt: Code aus der Authenticator-App oder Wiederherstellungscode. */
export function twoFactorForm(ticket, { onUser, onBack }) {
  const err = h('p', { class: 'error', role: 'alert' });
  const code = h('input', { type: 'text', id: 'tf-code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 14,
    autocapitalize: 'none', spellcheck: 'false', placeholder: '123 456', class: 'code-input' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Bestätigen'));
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = '';
    try {
      const r = await api('POST', '/api/login/2fa', { ticket, code: code.value.replace(/\s+/g, '') });
      if (r.user.recoveryCodesLeft !== undefined) {
        toast(t('Wiederherstellungscode benutzt – noch {0} übrig. Neue erzeugst du unter Konto → Sicherheit.', r.user.recoveryCodesLeft), { ms: 7000 });
      }
      onUser(r);
    } catch (ex) {
      err.textContent = ex.message; btn.disabled = false; code.select();
      if (/abgelaufen/.test(ex.message)) setTimeout(onBack, 1800);
    }
  } },
  h('h2', { class: 'tf-title' }, icon('shield'), h('span', {}, t('Zwei-Faktor-Anmeldung'))),
  h('label', { for: 'tf-code' }, t('Code aus deiner Authenticator-App')), code,
  h('div', { class: 'hint' }, t('Handy verloren? Gib stattdessen einen deiner Wiederherstellungscodes ein (1234-5678-9012).')),
  err, btn,
  h('button', { class: 'btn ghost block', type: 'button', onclick: onBack }, t('Zurück')));
  setTimeout(() => code.focus(), 0);
  return form;
}

// ---------- Hilfen ----------
const dialogHead = (title, dlg) => h('div', { class: 'dialog-head' }, h('h2', {}, title),
  h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Schließen'), onclick: () => dlg().close() }, '✕'));

/**
 * Kleiner Abfrage-Dialog. Passwort-Konten bestätigen sensible Aktionen mit dem Passwort
 * (SSO-Konten: der Server prüft stattdessen, ob die Anmeldung frisch ist).
 */
function ask({ title, text, password = true, fields = [], submit = t('Weiter') }) {
  const needPw = password && !state.user.sso;
  if (!needPw && !fields.length) return Promise.resolve({});
  return new Promise((resolve) => {
    let done = false;
    const inputs = {};
    if (needPw) inputs.password = h('input', { type: 'password', id: 'ask-pw', autocomplete: 'current-password', required: true, maxlength: 200 });
    for (const f of fields) inputs[f.name] = h('input', { type: 'text', id: `ask-${f.name}`, required: true, maxlength: f.max ?? 60, ...f.attrs });
    const dlg = modal(dialogHead(title, () => dlg),
      text ? h('p', { class: 'hint' }, text) : null,
      h('form', { onsubmit: (e) => {
        e.preventDefault(); done = true;
        resolve(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
        dlg.close();
      } },
      fields.map((f) => [h('label', { for: `ask-${f.name}` }, f.label), inputs[f.name]]).flat(),
      needPw ? [h('label', { for: 'ask-pw' }, t('Passwort bestätigen')), inputs.password] : null,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Abbrechen')),
        h('button', { class: 'btn primary', type: 'submit' }, submit))));
    dlg.addEventListener('close', () => { if (!done) resolve(null); });
    setTimeout(() => Object.values(inputs)[0]?.focus(), 0);
  });
}

function copyBtn(getText, label = t('Kopieren')) {
  return h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(getText()); toast(t('Kopiert')); } catch { toast(t('Kopieren nicht möglich – bitte markieren.')); }
  } }, icon('copy'), h('span', {}, label));
}
/** Geheimnis einmalig anzeigen (Schlüssel, Webhook-Secret). */
const secretBox = (value, hint) => h('div', { class: 'secret-once', role: 'status' },
  h('b', {}, t('Nur jetzt sichtbar – bitte sicher speichern')), h('p', { class: 'hint' }, hint),
  h('div', { class: 'linkbox' }, h('input', { type: 'text', readonly: true, value, 'aria-label': t('Geheimer Wert'), onfocus: (e) => e.target.select() }), copyBtn(() => value)));

// ---------- Sicherheit ----------
export function openSecurity() {
  const passkeys = h('div', {});
  const twofa = h('div', {});
  const dlg = modal(dialogHead(t('Sicherheit'), () => dlg),
    h('section', { class: 'sec-section' }, h('h3', {}, icon('fingerprint'), h('span', {}, t('Passkeys'))),
      h('p', { class: 'hint' }, t('Anmelden mit Fingerabdruck, Gesicht oder Geräte-PIN – ohne Passwort. Passkeys funktionieren nur auf dieser Website und sind damit sicher gegen Phishing.')),
      passkeys),
    h('section', { class: 'sec-section' }, h('h3', {}, icon('shield'), h('span', {}, t('Zwei-Faktor-Anmeldung'))),
      h('p', { class: 'hint' }, t('Zusätzlich zum Passwort ein Code aus einer Authenticator-App (z. B. Aegis, 2FAS, Google Authenticator, 1Password).')),
      twofa),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Schließen'))));
  dlg.classList.add('wide-dialog');

  // Passkeys
  const drawPasskeys = (items) => {
    const add = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const id = await ask({ title: t('Passkey hinzufügen'), text: t('Danach fragt dein Gerät nach Fingerabdruck, Gesicht oder PIN.') });
      if (!id) return;
      add.disabled = true;
      try {
        const { flow, options } = await api('POST', '/api/me/passkeys/options', id);
        const response = await createCredential(options);
        drawPasskeys((await api('POST', '/api/me/passkeys', { flow, response })).items);
        toast(t('Passkey gespeichert ✓'));
      } catch (ex) {
        if (ex?.name === 'InvalidStateError') toast(t('Dieses Gerät hat schon einen Passkey für dein Konto.'));
        else if (!cancelled(ex)) toast(ex.message);
      } finally { add.disabled = false; }
    } }, icon('plus'), h('span', {}, t('Passkey hinzufügen')));
    passkeys.replaceChildren(
      items.length ? h('ul', { class: 'members' }, items.map((p) => h('li', {},
        h('span', {}, p.name, h('small', {}, t(' · seit {0}{1}{2}', fmtDate(p.createdAt), p.lastUsedAt ? t(' · zuletzt {0}', relTime(p.lastUsedAt)) : '', p.synced ? t(' · synchronisiert') : ''))),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('{0} umbenennen', p.name), title: t('Umbenennen'), onclick: async () => {
          const r = await ask({ title: t('Passkey umbenennen'), password: false, fields: [{ name: 'name', label: t('Name'), attrs: { value: p.name } }], submit: t('Speichern') });
          if (r) try { drawPasskeys((await api('PATCH', `/api/me/passkeys/${p.id}`, r)).items); } catch (ex) { toast(ex.message); }
        } }, icon('edit', { size: 18 })),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('{0} entfernen', p.name), title: t('Entfernen'), onclick: async () => {
          if (!confirm(t('Passkey „{0}“ entfernen? Auf dem Gerät selbst bleibt er gespeichert, funktioniert hier aber nicht mehr.', p.name))) return;
          try { drawPasskeys((await api('DELETE', `/api/me/passkeys/${p.id}`)).items); toast(t('Passkey entfernt')); } catch (ex) { toast(ex.message); }
        } }, icon('trash', { size: 18 })))))
        : h('p', { class: 'hint' }, t('Noch keine Passkeys.')),
      passkeysSupported() ? h('div', { class: 'row left' }, add) : h('p', { class: 'hint' }, t('Dieser Browser unterstützt keine Passkeys.')));
  };
  api('GET', '/api/me/passkeys').then((r) => drawPasskeys(r.items)).catch((ex) => passkeys.replaceChildren(h('p', { class: 'error' }, ex.message)));

  // Zwei-Faktor
  const showCodes = (codes) => {
    const text = codes.join('\n');
    twofa.replaceChildren(h('div', { class: 'secret-once' },
      h('b', {}, t('Deine Wiederherstellungscodes')),
      h('p', { class: 'hint' }, t('Jeder Code funktioniert genau einmal, falls du keinen Zugriff auf die App hast. Bewahre sie sicher auf (z. B. im Passwort-Manager) – sie werden nur jetzt angezeigt.')),
      h('ol', { class: 'recovery-codes' }, codes.map((c) => h('li', {}, c))),
      h('div', { class: 'row left' }, copyBtn(() => text),
        h('a', { class: 'btn', download: 'quotes-wiederherstellungscodes.txt', href: `data:text/plain;charset=utf-8,${encodeURIComponent(t('Quotes – Wiederherstellungscodes für @{0}\n\n{1}\n', state.user.username, text))}` },
          icon('download'), h('span', {}, t('Herunterladen'))),
        h('button', { class: 'btn primary', type: 'button', onclick: loadTwofa }, t('Gespeichert')))));
  };
  const startSetup = async () => {
    const id = await ask({ title: t('Zwei-Faktor einrichten') });
    if (!id) return;
    let s;
    try { s = await api('POST', '/api/me/2fa/setup', id); } catch (ex) { toast(ex.message); return; }
    const err = h('p', { class: 'error', role: 'alert' });
    const code = h('input', { type: 'text', id: 'tf-new', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 7, class: 'code-input', placeholder: '123 456' });
    twofa.replaceChildren(h('ol', { class: 'steps' },
      h('li', {}, t('QR-Code mit der Authenticator-App scannen'), h('img', { class: 'qr', src: s.qr, alt: t('QR-Code für die Authenticator-App'), width: 200, height: 200 }),
        h('details', {}, h('summary', {}, t('Scannen nicht möglich? Schlüssel manuell eingeben')),
          h('div', { class: 'linkbox' }, h('input', { type: 'text', readonly: true, value: s.secret, 'aria-label': t('Geheimer Schlüssel') }), copyBtn(() => s.secret)))),
      h('li', {}, h('form', { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try { showCodes((await api('POST', '/api/me/2fa/enable', { code: code.value.replace(/\s+/g, '') })).recoveryCodes); toast(t('Zwei-Faktor ist aktiv ✓')); }
        catch (ex) { err.textContent = ex.message; code.select(); }
      } }, h('label', { for: 'tf-new' }, t('Angezeigten 6-stelligen Code eingeben')),
      h('div', { class: 'linkbox' }, code, h('button', { class: 'btn primary', type: 'submit' }, t('Aktivieren'))), err))),
    h('div', { class: 'row left' }, h('button', { class: 'btn ghost', type: 'button', onclick: loadTwofa }, t('Abbrechen'))));
    code.focus();
  };
  async function loadTwofa() {
    try {
      const s = await api('GET', '/api/me/2fa');
      if (!s.available) { twofa.replaceChildren(h('p', { class: 'hint' }, t('Dein Konto meldet sich per SSO an – richte die Zwei-Faktor-Anmeldung bei deinem Anbieter ein. Passkeys kannst du trotzdem hier nutzen.'))); return; }
      if (!s.enabled) {
        twofa.replaceChildren(h('div', { class: 'device-row' }, h('div', {}, h('b', {}, t('Aus')), h('small', {}, t('Empfohlen, wenn du dich mit Passwort anmeldest.'))),
          h('button', { class: 'btn primary sm', type: 'button', onclick: startSetup }, t('Einrichten'))));
        return;
      }
      twofa.replaceChildren(h('div', { class: 'device-row' },
        h('div', {}, h('b', {}, t('Aktiv ✓')), h('small', {}, t('{0} übrig', plural(s.recoveryLeft, t('Wiederherstellungscode'), t('Wiederherstellungscodes'))))),
        h('div', { class: 'row left' },
          h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            const id = await ask({ title: t('Neue Wiederherstellungscodes'), text: t('Die alten Codes werden damit ungültig.') });
            if (id) try { showCodes((await api('POST', '/api/me/2fa/recovery', id)).recoveryCodes); } catch (ex) { toast(ex.message); }
          } }, t('Neue Codes')),
          h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
            const r = await ask({ title: t('Zwei-Faktor ausschalten'), submit: t('Ausschalten'),
              fields: [{ name: 'code', label: t('Aktueller Code (oder Wiederherstellungscode)'), max: 14, attrs: { inputmode: 'numeric', autocomplete: 'one-time-code' } }] });
            if (r) try { await api('POST', '/api/me/2fa/disable', r); toast(t('Zwei-Faktor ausgeschaltet')); loadTwofa(); } catch (ex) { toast(ex.message); }
          } }, t('Ausschalten')))));
    } catch (ex) { twofa.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  }
  loadTwofa();
}

// ---------- Integrationen ----------
export function openIntegrations() {
  const keys = h('div', {});
  const hooks = h('div', {});
  const origin = location.origin;
  const dlg = modal(dialogHead(t('Integrationen'), () => dlg),
    h('p', { class: 'hint' }, t('Verbinde Quotes mit eigenen Skripten, Kurzbefehlen (iOS/Android), Home-Assistant, Slack oder Discord.')),
    h('section', { class: 'sec-section' }, h('h3', {}, icon('key'), h('span', {}, t('API-Schlüssel'))), keys,
      h('details', { class: 'api-docs' }, h('summary', {}, t('So benutzt du die API')),
        h('pre', {}, h('code', {}, t('curl -H "Authorization: Bearer qk_…" \\\n  {0}/api/v1/quotes?scope=mine', origin))),
        h('ul', {},
          h('li', {}, h('code', {}, t('GET /api/v1/quotes')), t(' – Liste (scope=mine|feed|shared, q, tag, page)')),
          h('li', {}, h('code', {}, t('GET /api/v1/random')), ' · ', h('code', {}, '/api/v1/daily'), t(' – auch als '), h('code', {}, '?format=text'), t(' für Widgets')),
          h('li', {}, h('code', {}, t('POST /api/v1/quotes')), t(' – { text, person, source, tags, visibility } (Schlüssel mit Schreibrecht)')),
          h('li', {}, h('code', {}, t('GET /api/v1')), t(' – Übersicht'))))),
    h('section', { class: 'sec-section' }, h('h3', {}, icon('plug'), h('span', {}, t('Webhooks'))),
      h('p', { class: 'hint' }, t('Quotes schickt bei Ereignissen eine Nachricht an deine Adresse – als JSON (signiert mit HMAC-SHA256 im Header X-Quotes-Signature) oder direkt im Slack-/Discord-Format.')),
      hooks),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Schließen'))));
  dlg.classList.add('wide-dialog');

  // API-Schlüssel
  const keyName = h('input', { type: 'text', id: 'key-name', maxlength: 40, placeholder: t('z. B. Kurzbefehl iPhone') });
  const keyScope = h('select', { id: 'key-scope', 'aria-label': t('Berechtigung') }, h('option', { value: 'read' }, t('Nur lesen')), h('option', { value: 'write' }, t('Lesen + Zitate anlegen')));
  const keyOut = h('div', {});
  const keyList = h('div', {});
  const drawKeys = async () => {
    try {
      const { keys: items } = await api('GET', '/api/me/keys');
      keyList.replaceChildren(items.length ? h('ul', { class: 'members' }, items.map((k) => h('li', {},
        h('span', {}, k.name, h('small', {}, ` · ${k.prefix}… · ${k.scope === 'write' ? t('lesen + schreiben') : t('nur lesen')} · ${k.lastUsedAt ? t('zuletzt {0}', relTime(k.lastUsedAt)) : t('nie benutzt')}`)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('{0} widerrufen', k.name), title: t('Widerrufen'), onclick: async () => {
          if (!confirm(t('Schlüssel „{0}“ widerrufen? Skripte damit funktionieren sofort nicht mehr.', k.name))) return;
          try { await api('DELETE', `/api/me/keys/${k.id}`); keyOut.replaceChildren(); drawKeys(); } catch (ex) { toast(ex.message); }
        } }, icon('trash', { size: 18 }))))) : h('p', { class: 'hint' }, t('Noch keine Schlüssel.')));
    } catch (ex) { keyList.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  };
  keys.append(keyList, h('form', { class: 'invite-create', onsubmit: async (e) => {
    e.preventDefault();
    const id = await ask({ title: t('API-Schlüssel erstellen') });
    if (!id) return;
    try {
      const k = await api('POST', '/api/me/keys', { ...id, name: keyName.value, scope: keyScope.value });
      keyOut.replaceChildren(secretBox(k.token, t('Der Schlüssel gibt Zugriff auf deine Zitate. Nicht weitergeben; bei Verdacht einfach widerrufen.')));
      keyName.value = ''; drawKeys();
    } catch (ex) { toast(ex.message); }
  } }, keyName, keyScope, h('button', { class: 'btn primary', type: 'submit' }, t('Erstellen'))), keyOut);
  drawKeys();

  // Webhooks
  const hookOut = h('div', {});
  const drawHooks = async () => {
    try {
      const { webhooks, events, allowPrivate } = await api('GET', '/api/me/webhooks');
      const url = h('input', { type: 'url', id: 'hook-url', required: true, maxlength: 500, placeholder: 'https://hooks.slack.com/…', autocomplete: 'off' });
      const format = h('select', { 'aria-label': t('Format') }, h('option', { value: 'json' }, t('JSON (signiert)')), h('option', { value: 'slack' }, t('Slack')), h('option', { value: 'discord' }, t('Discord')));
      const boxes = Object.entries(events).map(([k, label]) => h('input', { type: 'checkbox', value: k, checked: true, 'aria-label': t(label) }));
      hooks.replaceChildren(
        webhooks.length ? h('ul', { class: 'members' }, webhooks.map((w) => h('li', {},
          h('span', {}, h('span', { class: 'hook-url' }, w.url),
            h('small', {}, ` · ${w.format} · ${w.events.join(', ')}`,
              w.active ? (w.lastStatus ? t(' · zuletzt {0}', w.lastStatus) : '') : t(' · deaktiviert nach Fehlern'))),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            try { const r = await api('POST', `/api/me/webhooks/${w.id}/test`); toast(r.ok ? t('Test angekommen ({0})', r.status) : t('Fehlgeschlagen: {0}', r.status)); drawHooks(); } catch (ex) { toast(ex.message); }
          } }, t('Test')),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Webhook löschen'), title: t('Löschen'), onclick: async () => {
            if (!confirm(t('Webhook löschen?'))) return;
            try { await api('DELETE', `/api/me/webhooks/${w.id}`); hookOut.replaceChildren(); drawHooks(); } catch (ex) { toast(ex.message); }
          } }, icon('trash', { size: 18 }))))) : h('p', { class: 'hint' }, t('Noch keine Webhooks.')),
        h('form', { class: 'hook-form', onsubmit: async (e) => {
          e.preventDefault();
          const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
          if (!chosen.length) { toast(t('Bitte mindestens ein Ereignis wählen.')); return; }
          const id = await ask({ title: t('Webhook hinzufügen') });
          if (!id) return;
          try {
            const w = await api('POST', '/api/me/webhooks', { ...id, url: url.value, format: format.value, events: chosen });
            await drawHooks();
            if (w.format === 'json') hookOut.replaceChildren(secretBox(w.secret, t('Damit prüfst du die Signatur: HMAC-SHA256 über den Rohtext, Header X-Quotes-Signature: sha256=…')));
            toast(t('Webhook gespeichert'));
          } catch (ex) { toast(ex.message); }
        } },
        h('label', { for: 'hook-url' }, t('Neue Ziel-Adresse (https)')), url,
        Object.entries(events).map(([, label], i) => h('label', { class: 'check' }, boxes[i], h('span', {}, t(label)))),
        h('div', { class: 'linkbox' }, format, h('button', { class: 'btn primary', type: 'submit' }, t('Hinzufügen'))),
        allowPrivate ? null : h('p', { class: 'hint' }, t('Aus Sicherheitsgründen nur öffentliche Adressen (keine internen IPs).'))),
        hookOut);
    } catch (ex) { hooks.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  };
  drawHooks();
}
