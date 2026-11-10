/**
 * ui.js — Petits utilitaires d'interface : échappement HTML, formatage,
 * modales (<dialog> natif), toasts, confirmation.
 */

/** Échappe une chaîne avant de l'insérer dans du HTML (protection XSS). */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** N'accepte que les liens http(s) ; renvoie '' sinon (bloque javascript:, data:…). */
export function safeUrl(url) {
  const u = String(url ?? '').trim();
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
}

const priceFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
export function formatPrice(price) {
  return typeof price === 'number' && Number.isFinite(price) ? priceFmt.format(price) : '';
}

/**
 * Convertit « 1 299,99 € », « 29.90 », « EUR 15 » … en nombre (ou null).
 * Gère la virgule ou le point comme séparateur décimal.
 */
export function parsePrice(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input ?? '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  const decimalSep = lastComma > lastDot ? ',' : '.';
  const thousandSep = decimalSep === ',' ? '.' : ',';
  s = s.split(thousandSep).join('');
  // « 1.299.000 » : plusieurs points sans virgule = séparateurs de milliers
  if (decimalSep === '.' && (s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export const firstName = (u) => u?.prenom || '?';
export const fullName = (u) => (u ? `${u.prenom} ${u.nom}`.trim() : 'Membre inconnu');
export const initials = (u) => ((u?.prenom?.[0] || '') + (u?.nom?.[0] || '')).toUpperCase() || '?';

/** Couleur d'avatar stable dérivée de l'ID. */
export function avatarHue(id = '') {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Libellé lisible pour l'appareil courant, ex. « Android · Chrome ». */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X/i.test(ua) ? 'Mac'
    : /Linux/i.test(ua) ? 'Linux' : 'Appareil';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /(Chrome|CriOS)\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  return `${os} · ${browser}`;
}

/** « 24 j 19 h », « 5 h 12 min », « 3 min 05 s » */
export function formatCountdown(ms) {
  if (ms <= 0) return '0 s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min ${String(sec).padStart(2, '0')} s`;
}

export function formatDate(date) {
  return date.toLocaleString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
  });
}

/* ---------------------------------------------------------------- Toasts */

export function toast(message, type = 'info') {
  let zone = document.getElementById('toasts');
  if (!zone) {
    zone = document.createElement('div');
    zone.id = 'toasts';
    zone.setAttribute('aria-live', 'polite');
    document.body.append(zone);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  zone.append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

/* ---------------------------------------------------------------- Modales */

/**
 * Ouvre une modale basée sur <dialog>.
 * @param {{title:string, body:string, wide?:boolean, onClose?:Function}} opts
 * @returns {{el:HTMLDialogElement, close:Function}}
 */
export function openModal({ title, body, wide = false, onClose }) {
  const dlg = document.createElement('dialog');
  dlg.className = `modal${wide ? ' modal-wide' : ''}`;
  dlg.innerHTML = `
    <div class="modal-head">
      <h2>${esc(title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Fermer">✕</button>
    </div>
    <div class="modal-body">${body}</div>`;
  document.body.append(dlg);

  const close = () => { if (dlg.open) dlg.close(); };
  dlg.addEventListener('close', () => { onClose?.(); dlg.remove(); });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) close();
  });
  dlg.showModal();
  return { el: dlg, close };
}

/** Boîte de confirmation ; résout true/false. */
export function confirmDialog(message, { confirmLabel = 'Confirmer', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const { el, close } = openModal({
      title: 'Confirmation',
      body: `<p>${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-close>Annuler</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>
        </div>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    el.querySelector('[data-ok]').addEventListener('click', () => { answered = true; resolve(true); close(); });
  });
}

/** Traduit les erreurs Firebase les plus courantes. */
export function errorMessage(err) {
  const code = err?.code || '';
  if (code.includes('permission-denied')) return 'Action refusée (droits insuffisants, code incorrect ou votes clos).';
  if (code.includes('unavailable')) return 'Connexion impossible. Vérifiez votre réseau.';
  if (code.includes('admin-restricted-operation') || code.includes('operation-not-allowed'))
    return "La connexion anonyme n'est pas activée dans Firebase (voir README).";
  return err?.message || 'Une erreur est survenue.';
}
