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
  doc, collection, onSnapshot, writeBatch, serverTimestamp, arrayRemove, updateDoc,
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
      (snap) => {
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
 * Première connexion : crée le profil + enregistre cet appareil, en une seule écriture atomique.
 * familyCode : code famille facultatif, vérifié par les règles si config/family existe.
 */
export async function registerProfile({ prenom, nom, familyCode }) {
  const uid = currentUid();
  if (!uid) throw new Error('Connexion Firebase pas encore prête, réessayez.');
  const userRef = doc(collection(db, 'users'));
  const batch = writeBatch(db);
  batch.set(userRef, {
    prenom: prenom.trim(),
    nom: nom.trim(),
    deviceTokens: [uid],
    familyCode: (familyCode || '').trim(),
    createdAt: serverTimestamp(),
  });
  batch.set(doc(db, 'devices', uid), {
    userId: userRef.id,
    label: deviceLabel(),
    method: 'register',
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  return userRef.id;
}

/** Modifie prénom / nom. */
export function updateProfile(userId, { prenom, nom }) {
  return updateDoc(doc(db, 'users', userId), { prenom: prenom.trim(), nom: nom.trim() });
}

/** Retire un appareil du compte (y compris l'appareil courant = déconnexion). */
export async function removeDevice(userId, deviceUid) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'users', userId), { deviceTokens: arrayRemove(deviceUid) });
  batch.delete(doc(db, 'devices', deviceUid));
  await batch.commit();
}
