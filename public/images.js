// Bilder an Zitaten + „Zitat aus Foto erkennen“ (KI). Der Server kodiert jedes Bild neu;
// das KI-Ergebnis ist nur ein Vorschlag, der im Editor geprüft und selbst gespeichert wird.
import { h, api, toast, modal, icon, state, t } from './core.js';
import { tErr } from './i18n.js';

const MAX_SIDE = 2048;

/** Im Browser verkleinern (spart Upload; Foto-Drehung wird übernommen). Der Server kodiert ohnehin neu. */
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.9));
  } catch {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file; // Browser kann es nicht dekodieren -> Server versucht es
    throw new Error(t('Dieses Bildformat wird nicht unterstützt. Bitte JPEG, PNG oder WebP verwenden.'));
  }
}

export async function uploadImage(file) {
  const blob = await shrink(file);
  if (blob.size > 8 * 1024 * 1024) throw new Error(t('Das Bild ist zu groß (max. 8 MB).'));
  const res = await fetch('/api/images', {
    method: 'POST', body: blob, credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': blob.type || 'image/jpeg', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? tErr(data.error) : t('Etwas ist schiefgelaufen.'));
  return data;
}

const pickFile = () => new Promise((resolve) => {
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/*', class: 'visually-hidden' });
  input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); });
  document.body.append(input);
  input.click();
});

/** Großansicht */
export function openImage(src, alt) {
  const dlg = modal(h('img', { class: 'lightbox-img', src, alt }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Schließen'))));
  dlg.classList.add('lightbox');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

/** Bild auf der Karte (Platz wird anhand der Maße reserviert -> kein Springen beim Laden). */
export function quoteImage(q) {
  if (!q.image) return null;
  const alt = t('Bild zum Zitat von {0}', q.person);
  return h('button', { class: 'quote-img', type: 'button', 'aria-label': t('Bild vergrößern'), onclick: () => openImage(q.image.url, alt) },
    h('img', { src: q.image.url, alt, loading: 'lazy', decoding: 'async', width: q.image.width ?? null, height: q.image.height ?? null }));
}

/** Editor-Feld: Bild hinzufügen/ersetzen/entfernen. value(): undefined = unverändert, null = entfernen, sonst ID. */
export function imageField(initial) {
  let value; // undefined = unverändert
  let current = initial ?? null;
  const box = h('div', { class: 'image-field' });
  const status = h('span', { class: 'hint', role: 'status' });
  const draw = () => {
    box.replaceChildren(
      current ? h('img', { class: 'image-preview', src: current.url, alt: t('Vorschau'), width: current.width ?? null, height: current.height ?? null }) : null,
      h('div', { class: 'row left' },
        h('button', { class: 'btn sm', type: 'button', onclick: choose }, icon('image', { size: 16 }), h('span', {}, current ? t('Bild ersetzen') : t('Bild hinzufügen'))),
        current ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { current = null; value = null; draw(); } }, t('Entfernen')) : null,
        status));
  };
  async function choose() {
    const file = await pickFile();
    if (!file) return;
    status.textContent = t('Wird hochgeladen …');
    try { set(await uploadImage(file)); } catch (ex) { toast(ex.message); } finally { status.textContent = ''; }
  }
  function set(img) { current = img; value = img.id; draw(); }
  draw();
  return { el: box, value: () => value, set };
}

/**
 * „Zitat aus Foto erkennen“: Foto hochladen, KI liest es, Ergebnis landet als Vorschlag im Formular.
 * onResult(result, image) füllt die Felder – gespeichert wird erst beim Klick auf „Speichern“.
 */
export function aiScanButton(onResult) {
  if (!state.config.ai) return null;
  const note = h('div', { class: 'ai-note', role: 'status', hidden: true });
  const btn = h('button', { class: 'btn ai-btn', type: 'button', onclick: async () => {
    const file = await pickFile();
    if (!file) return;
    btn.disabled = true; note.hidden = false; note.className = 'ai-note';
    note.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('Bild wird gelesen … das kann bis zu einer Minute dauern.'));
    try {
      const img = await uploadImage(file);
      const r = await api('POST', '/api/ai/extract', { imageId: img.id });
      if (!r.found) {
        note.replaceChildren(t('Kein Zitat erkannt. Das Foto kannst du trotzdem anhängen.'));
        onResult(null, img);
        return;
      }
      onResult(r, img);
      note.className = `ai-note ${r.suspicious ? 'warn' : 'ok'}`;
      note.replaceChildren(h('b', {}, t('Von der KI erkannt – bitte prüfen, bevor du speicherst.')),
        r.suspicious ? h('span', {}, t(' Achtung: Der Text enthält Links oder Anweisungen. Sie werden nicht ausgeführt, sind aber oft ein Zeichen für manipulierte Bilder.')) : null);
    } catch (ex) { note.className = 'ai-note warn'; note.replaceChildren(ex.message); } finally { btn.disabled = false; }
  } }, icon('scan'), h('span', {}, t('Zitat aus Foto erkennen')));
  return h('div', { class: 'ai-scan' }, btn, note);
}
