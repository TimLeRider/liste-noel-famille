/**
 * session.js — Authentification par appareil.
 *
 * Principe :
 *  1. Chaque navigateur se connecte anonymement à Firebase → il reçoit un UID unique
 *     persisté dans le localStorage : c'est le « jeton d'appareil ».
 *  2. Le document devices/{uid} relie ce jeton à un profil users/{userId}.
 *  3. Au démarrage on écoute devices/{uid} :
 *       - il existe  → l'appareil est reconnu, connexion transparente ;
 *       - il n'existe pas → écran d'accueil (créer un profil ou associer l'appareil).
 */
import {
  auth, db, signInAnonymously, onAuthStateChanged,
  doc, collection, onSnapshot, writeBatch, serverTimestamp, arrayRemove, getDoc,
} from './firebase.js';
import { LS_SESSION_KEY } from './config.js';
import { deviceLabel } from './ui.js';

let unsubDevice = null;

/** Session mise en cache (affichage immédiat avant la réponse réseau). */
export function cachedSession() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION_KEY)) || null; } catch { return null; }
}

/**
 * Démarre la session et appelle onState({status, uid, userId, error}) à chaque changement.
 * status : 'loading' | 'guest' | 'member' | 'error'
 */
export function startSession(onState) {
  onAuthStateChanged(auth, async (user) => {
    unsubDevice?.();
    if (!user) {
      try { await signInAnonymously(auth); } // relance onAuthStateChanged avec l'utilisateur
      catch (error) { onState({ status: 'error', error }); }
      return;
    }
    unsubDevice = onSnapshot(
      doc(db, 'devices', user.uid),
      // includeMetadataChanges : on est prévenu quand l'écriture locale est confirmée par le serveur
      { includeMetadataChanges: true },
      (snap) => {
        // Juste après l'inscription, le document n'existe encore que localement :
        // on attend la confirmation du serveur, sinon les règles refusent les lectures
        // (« Missing or insufficient permissions »).
        if (snap.metadata.hasPendingWrites) return;
        if (snap.exists()) {
          const userId = snap.data().userId;
          localStorage.setItem(LS_SESSION_KEY, JSON.stringify({ deviceToken: user.uid, userId }));
          onState({ status: 'member', uid: user.uid, userId });
        } else {
          localStorage.removeItem(LS_SESSION_KEY);
          onState({ status: 'guest', uid: user.uid });
        }
      },
      (error) => onState({ status: 'error', error }),
    );
  });
}

/** UID anonyme de cet appareil (jeton d'appareil). */
export const currentUid = () => auth.currentUser?.uid ?? null;

/**
 * Clé d'unicité d'un nom : « Claudio Di Allano » et « claudio  di allano » donnent
 * la même clé « claudio_di_allano » (accents, majuscules et espaces ignorés).
 * Un document names/{clé} « réserve » le nom : impossible de créer un 2e profil identique.
 */
export function nameKey(prenom, nom) {
  return `${prenom} ${nom}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'sans_nom';
}

/** Erreur dédiée : ce prénom + nom est déjà utilisé par un autre profil. */
export class DuplicateNameError extends Error {
  constructor(prenom, nom) {
    super(`Un profil « ${prenom.trim()} ${nom.trim()} » existe déjà.`);
    this.code = 'duplicate-name';
  }
}

/** Le nom est-il déjà réservé par un autre profil que `exceptUserId` ? */
async function nameTaken(key, exceptUserId = null) {
  const snap = await getDoc(doc(db, 'names', key));
  return snap.exists() && snap.data().userId !== exceptUserId;
}

/**
 * Première connexion : crée le profil, réserve le nom et enregistre cet appareil,
 * en une seule écriture atomique (tout ou rien).
 * familyCode : code famille facultatif, vérifié par les règles si config/family existe.
 */
export async function registerProfile({ prenom, nom, familyCode }) {
  const uid = currentUid();
  if (!uid) throw new Error('Connexion Firebase pas encore prête, réessayez.');
  const key = nameKey(prenom, nom);
  if (await nameTaken(key)) throw new DuplicateNameError(prenom, nom);

  const userRef = doc(collection(db, 'users'));
  const batch = writeBatch(db);
  batch.set(userRef, {
    prenom: prenom.trim(),
    nom: nom.trim(),
    nameKey: key,
    deviceTokens: [uid],
    familyCode: (familyCode || '').trim(),
    createdAt: serverTimestamp(),
  });
  batch.set(doc(db, 'names', key), { userId: userRef.id, createdAt: serverTimestamp() });
  batch.set(doc(db, 'devices', uid), {
    userId: userRef.id,
    label: deviceLabel(),
    method: 'register',
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  return userRef.id;
}

/** Modifie prénom / nom (et déplace la réservation du nom). */
export async function updateProfile(userId, oldKey, { prenom, nom }) {
  const key = nameKey(prenom, nom);
  if (await nameTaken(key, userId)) throw new DuplicateNameError(prenom, nom);
  const batch = writeBatch(db);
  batch.update(doc(db, 'users', userId), { prenom: prenom.trim(), nom: nom.trim(), nameKey: key });
  if (key !== oldKey) {
    batch.set(doc(db, 'names', key), { userId, createdAt: serverTimestamp() });
    if (oldKey) batch.delete(doc(db, 'names', oldKey));
  }
  await batch.commit();
}

/**
 * Migration des profils créés avant l'unicité des noms : réserve le nom
 * automatiquement à l'ouverture de l'app. Échoue en silence si le nom est déjà
 * pris (doublon existant, à supprimer dans la console Firebase).
 */
export async function ensureNameReserved(user) {
  if (user.nameKey) return;
  const key = nameKey(user.prenom, user.nom);
  if (await nameTaken(key, user.id)) return;
  const batch = writeBatch(db);
  batch.set(doc(db, 'names', key), { userId: user.id, createdAt: serverTimestamp() });
  batch.update(doc(db, 'users', user.id), { nameKey: key });
  await batch.commit();
}

/** Retire un appareil du compte (y compris l'appareil courant = déconnexion). */
export async function removeDevice(userId, deviceUid) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'users', userId), { deviceTokens: arrayRemove(deviceUid) });
  batch.delete(doc(db, 'devices', deviceUid));
  await batch.commit();
}
