/**
 * pairing.js — Appairage d'un nouvel appareil (ordinateur, tablette…).
 *
 * Déroulé :
 *  1. Le NOUVEL appareil (non connecté) crée pairings/{code} : code à 6 chiffres
 *     valable 5 minutes + son UID anonyme. Il affiche le code et un QR code.
 *  2. L'appareil DÉJÀ CONNECTÉ (téléphone) scanne le QR code ou tape le code,
 *     puis valide : il crée devices/{uidDuNouvelAppareil} → userId et ajoute
 *     l'UID au tableau users/{userId}.deviceTokens.
 *  3. Le nouvel appareil, qui écoute devices/{sonUid}, est connecté instantanément.
 */
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm';
import {
  db, doc, getDoc, setDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp, arrayUnion,
} from './firebase.js';
import { PAIRING_TTL_MS } from './config.js';
import { deviceLabel } from './ui.js';
import { currentUid } from './session.js';

/** Code aléatoire cryptographiquement sûr (Web Crypto API). */
function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

/** URL encodée dans le QR code : ouvre l'app directement sur l'écran de validation. */
export function pairingUrl(code) {
  return `${location.origin}${location.pathname}#/pair/${code}`;
}

/** Extrait un code à 6 chiffres d'un texte saisi ou d'une URL scannée. */
export function extractCode(text) {
  const s = String(text || '');
  const m = s.match(/pair\/(\d{6})/) || s.replace(/\s/g, '').match(/^(\d{6})$/);
  return m ? m[1] : null;
}

/** Côté nouvel appareil : crée une demande d'appairage. */
export async function createPairingRequest() {
  const uid = currentUid();
  if (!uid) throw new Error('Connexion Firebase pas encore prête, réessayez.');
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    try {
      await setDoc(doc(db, 'pairings', code), {
        code,
        requesterUid: uid,
        status: 'pending',
        label: deviceLabel(),
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(expiresAt),
      });
      return { code, expiresAt };
    } catch (err) {
      // Code déjà utilisé par une demande encore valide → on en tire un autre
      if (!String(err?.code).includes('permission-denied')) throw err;
    }
  }
  throw new Error("Impossible de générer un code d'appairage, réessayez.");
}

/** Côté nouvel appareil : annule la demande (quitter l'écran). */
export function cancelPairing(code) {
  return deleteDoc(doc(db, 'pairings', code)).catch(() => {});
}

/** Lit une demande (pour afficher « Autoriser Windows · Chrome ? »). */
export async function getPairing(code) {
  const snap = await getDoc(doc(db, 'pairings', code));
  if (!snap.exists()) return null;
  const data = snap.data();
  return { ...data, expired: data.expiresAt.toMillis() < Date.now() };
}

/** Côté appareil connecté : valide la demande et rattache l'appareil au compte. */
export async function approvePairing(code, userId) {
  const pairing = await getPairing(code);
  if (!pairing) throw new Error('Code inconnu. Vérifiez les 6 chiffres.');
  if (pairing.status !== 'pending') throw new Error('Ce code a déjà été utilisé.');
  if (pairing.expired) throw new Error('Ce code a expiré. Générez-en un nouveau sur l’autre appareil.');
  if (pairing.requesterUid === currentUid()) throw new Error('Utilisez un autre appareil pour valider ce code.');

  const batch = writeBatch(db);
  batch.set(doc(db, 'devices', pairing.requesterUid), {
    userId,
    label: pairing.label || 'Nouvel appareil',
    method: 'pairing',
    pairingCode: code,
    createdAt: serverTimestamp(),
  });
  batch.update(doc(db, 'users', userId), { deviceTokens: arrayUnion(pairing.requesterUid) });
  batch.update(doc(db, 'pairings', code), { status: 'approved', userId, approvedAt: serverTimestamp() });
  await batch.commit();
  return pairing;
}

/** Dessine le QR code dans un <canvas>. */
export function drawQr(canvas, text) {
  return QRCode.toCanvas(canvas, text, {
    width: 220, margin: 1, color: { dark: '#14342b', light: '#ffffff' },
  });
}

/** Le scan intégré est-il possible ? (BarcodeDetector : Chrome Android, Edge…) */
export const scannerSupported = () => 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

/**
 * Démarre la caméra et détecte un QR code. Appelle onCode(code) une fois trouvé.
 * Renvoie une fonction stop(). Sur iPhone, utilisez simplement l'appareil photo
 * natif : le QR code contient un lien qui ouvre l'app sur l'écran de validation.
 */
export async function startScanner(video, onCode) {
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = stream;
  await video.play();
  let running = true;
  const stop = () => { running = false; stream.getTracks().forEach((t) => t.stop()); };
  (async function loop() {
    while (running) {
      try {
        const found = await detector.detect(video);
        const code = found.map((f) => extractCode(f.rawValue)).find(Boolean);
        if (code) { stop(); onCode(code); return; }
      } catch { /* image pas prête */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  return stop;
}
