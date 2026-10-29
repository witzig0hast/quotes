// Installierbare App (Service Worker), Offline-Hinweis, Push pro Gerät, E-Mail & Wochenrückblick.
import { h, api, toast, icon, state, t, LOCALE, LANG } from './core.js';

let installPrompt = null;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function initPwa() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[sw]', e.message));
  }
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  addEventListener('appinstalled', () => { installPrompt = null; toast(t('Quotes ist jetzt installiert')); });
  const bar = h('div', { class: 'offline-bar', role: 'status', hidden: navigator.onLine },
    t('Offline – du siehst den zuletzt geladenen Stand.'));
  document.body.append(bar);
  addEventListener('offline', () => { bar.hidden = false; });
  addEventListener('online', () => { bar.hidden = true; toast(t('Wieder online')); state.reload?.(); });
}

/** Beim Abmelden: offline gespeicherte (private) API-Daten vom Gerät löschen. */
export function clearOfflineData() {
  navigator.serviceWorker?.controller?.postMessage('logout');
}

/** Rücksprünge aus E-Mails/Benachrichtigungen auswerten (?email=verified, ?notifications=1 …). */
export function takeUrlActions() {
  const params = new URLSearchParams(location.search);
  const actions = {};
  const msg = {
    email: { verified: t('E-Mail-Adresse bestätigt ✓'), invalid: t('Der Bestätigungslink ist ungültig oder abgelaufen.') },
    digest: { off: t('Wochenrückblick abbestellt.'), invalid: t('Der Abmeldelink ist ungültig.') },
  };
  for (const [key, texts] of Object.entries(msg)) if (params.has(key)) actions.toast = texts[params.get(key)];
  if (params.has('notifications')) actions.notifications = true;
  if (params.has('new')) actions.newQuote = true;
  if ([...params.keys()].some((k) => ['email', 'digest', 'notifications', 'new'].includes(k))) history.replaceState(null, '', location.pathname);
  return actions;
}

const b64ToBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** Konto-Bereich „Dieses Gerät“: App installieren + Push-Benachrichtigungen. */
export function deviceSection() {
  const box = h('section', { class: 'acc-section' }, h('label', {}, t('Dieses Gerät')));
  const rows = h('div', { class: 'device-rows' });
  box.append(rows);

  // Installieren
  if (!isStandalone()) {
    if (installPrompt) {
      rows.append(h('div', { class: 'device-row' }, h('div', {}, h('b', {}, t('Als App installieren')), h('small', {}, t('Startbildschirm, Vollbild, schneller Start.'))),
        h('button', { class: 'btn sm primary', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; } }, t('Installieren'))));
    } else if (isIos()) {
      rows.append(h('div', { class: 'device-row' }, h('div', {}, h('b', {}, t('Als App installieren')),
        h('small', {}, t('In Safari unten auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.')))));
    }
  } else {
    rows.append(h('div', { class: 'device-row' }, h('div', {}, h('b', {}, t('App installiert ✓')), h('small', {}, t('Zuletzt geladene Zitate sind auch offline lesbar.')))));
  }

  // Push
  const push = state.config.push;
  const status = h('small', {});
  const btn = h('button', { class: 'btn sm' }, '…');
  const test = h('button', { class: 'btn sm ghost', hidden: true, onclick: async () => { try { await api('POST', '/api/push/test'); toast(t('Test gesendet')); } catch (ex) { toast(ex.message); } } }, t('Test'));
  const row = h('div', { class: 'device-row' }, h('div', {}, h('b', {}, t('Benachrichtigungen aufs Gerät')), status), h('div', { class: 'row left' }, test, btn));
  if (!push) {
    status.textContent = t('Auf diesem Server nicht eingerichtet.'); btn.hidden = true;
  } else if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    status.textContent = isIos() && !isStandalone() ? t('Auf dem iPhone erst die App installieren (siehe oben).') : t('Dieser Browser unterstützt kein Push.'); btn.hidden = true;
  } else {
    const refresh = async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const denied = Notification.permission === 'denied';
      status.textContent = denied ? t('Im Browser blockiert – in den Website-Einstellungen erlauben.') : sub ? t('Aktiv auf diesem Gerät.') : t('Aus.');
      btn.textContent = sub ? t('Ausschalten') : t('Einschalten');
      btn.disabled = denied; test.hidden = !sub;
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          if (sub) {
            await api('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint });
            await sub.unsubscribe();
          } else {
            if (await Notification.requestPermission() !== 'granted') throw new Error(t('Benachrichtigungen wurden nicht erlaubt.'));
            const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(push.publicKey) });
            await api('POST', '/api/push/subscribe', { subscription: fresh.toJSON() });
            toast(t('Benachrichtigungen aktiv'));
          }
        } catch (ex) { toast(ex.message); } finally { btn.disabled = false; refresh(); }
      };
    };
    refresh().catch(() => { status.textContent = t('Nicht verfügbar.'); btn.hidden = true; });
  }
  rows.append(row);
  return box;
}

/** Konto-Bereich „E-Mail & Wochenrückblick“. */
export function emailSection() {
  const box = h('section', { class: 'acc-section' }, h('label', { for: 'acc-email' }, t('E-Mail & Wochenrückblick')));
  if (!state.config.email) { box.append(h('p', { class: 'hint' }, t('E-Mail ist auf diesem Server nicht eingerichtet.'))); return box; }
  const input = h('input', { type: 'email', id: 'acc-email', maxlength: 254, autocomplete: 'email', placeholder: 'du@example.com' });
  const status = h('p', { class: 'hint' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, t('Speichern'));
  const digest = h('input', { type: 'checkbox', id: 'acc-digest' });
  const digestRow = h('label', { class: 'check', for: 'acc-digest' }, digest,
    h('span', {}, t('Wochenrückblick per E-Mail'), h('small', {}, t('Einmal pro Woche: Neues von Leuten, denen du folgst, ungelesene Benachrichtigungen, Zitat der Woche.'))));
  const draw = (e) => {
    input.value = e.email ?? '';
    status.textContent = !e.email ? t('Optional – nur für den Wochenrückblick. Wird nie angezeigt oder weitergegeben.')
      : e.verified ? t('Bestätigt ✓') : t('Noch nicht bestätigt – bitte den Link in der Mail öffnen (gültig 24 Stunden).');
    digest.checked = e.digest; digest.disabled = !e.verified;
  };
  digest.addEventListener('change', async () => {
    try { await api('PUT', '/api/me/digest', { enabled: digest.checked }); toast(digest.checked ? t('Wochenrückblick aktiviert') : t('Wochenrückblick aus')); } catch (ex) { digest.checked = !digest.checked; toast(ex.message); }
  });
  box.append(h('form', { onsubmit: async (ev) => {
    ev.preventDefault(); save.disabled = true;
    try { draw(await api('PUT', '/api/me/email', { email: input.value })); toast(input.value ? t('Bestätigungsmail gesendet') : t('E-Mail entfernt')); }
    catch (ex) { toast(ex.message); } finally { save.disabled = false; }
  } }, h('div', { class: 'linkbox' }, input, save)), status, digestRow);
  api('GET', '/api/me/email').then(draw).catch(() => {});
  return box;
}

export { icon };
