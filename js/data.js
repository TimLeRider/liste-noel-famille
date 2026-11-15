/**
 * data.js — Lecture temps réel et écritures Firestore (membres, cadeaux, votes, résultats).
 *
 * Confidentialité des votes (appliquée par firestore.rules) :
 *  - chaque vote porte hiddenFrom[] (= propriétaires du cadeau, donc le destinataire)
 *    et visibleTo[] (= tous les autres membres) ;
 *  - on ne lit les votes QUE via where('visibleTo', 'array-contains', moi) :
 *    le destinataire ne reçoit donc jamais ses votes, même en bricolant le code.
 */
import {
  db, doc, collection, query, where, onSnapshot, setDoc, updateDoc, deleteDoc,
  serverTimestamp,
} from './firebase.js';
import { visibleToFor, selectedPayload } from './results.js';

const withId = (d) => ({ id: d.id, ...d.data() });

/* ------------------------------------------------------------ Abonnements */

/** Écoute une requête ; cb(liste, fromServer). Renvoie la fonction de désabonnement. */
function listen(q, cb, onError) {
  return onSnapshot(q, (snap) => cb(snap.docs.map(withId), !snap.metadata.fromCache), onError);
}

export const watchUsers = (cb, err) => listen(collection(db, 'users'), cb, err);
export const watchGifts = (cb, err) => listen(collection(db, 'gifts'), cb, err);
export const watchVotes = (me, cb, err) =>
  listen(query(collection(db, 'votes'), where('visibleTo', 'array-contains', me)), cb, err);
export const watchSelected = (me, cb, err) =>
  listen(query(collection(db, 'selectedGifts'), where('visibleTo', 'array-contains', me)), cb, err);
export const watchMyDevices = (me, cb, err) =>
  listen(query(collection(db, 'devices'), where('userId', '==', me)), cb, err);

/* ---------------------------------------------------------------- Cadeaux */

/** Champs éditables d'un cadeau, normalisés. */
function giftFields(g) {
  return {
    title: String(g.title || '').trim().slice(0, 200),
    price: typeof g.price === 'number' && Number.isFinite(g.price) ? g.price : null,
    url: String(g.url || '').trim().slice(0, 2000),
    imageUrl: String(g.imageUrl || '').trim().slice(0, 2000),
    description: String(g.description || '').trim().slice(0, 1000),
    commentary: String(g.commentary || '').trim().slice(0, 1000),
  };
}

export function createGift(me, data) {
  return setDoc(doc(collection(db, 'gifts')), {
    ...giftFields(data),
    ownerIds: [me],
    createdBy: me,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function updateGift(giftId, data) {
  return updateDoc(doc(db, 'gifts', giftId), { ...giftFields(data), updatedAt: serverTimestamp() });
}

export const deleteGift = (giftId) => deleteDoc(doc(db, 'gifts', giftId));

/** Combine le cadeau avec un partenaire (ou l'en retire si partnerId = null). */
export function setGiftPartner(gift, partnerId) {
  const ownerIds = partnerId ? [gift.createdBy, partnerId] : [gift.createdBy];
  return updateDoc(doc(db, 'gifts', gift.id), { ownerIds, updatedAt: serverTimestamp() });
}

/* ------------------------------------------------------------------ Votes */

/** ID déterministe : un seul vote par votant et par destinataire. */
export const voteId = (voter, target) => `${voter}_${target}`;

export function castVote({ me, targetUserId, gift, userIds }) {
  return setDoc(doc(db, 'votes', voteId(me, targetUserId)), {
    giftId: gift.id,
    voterUserId: me,
    targetUserId,
    timestamp: serverTimestamp(),
    hiddenFrom: [...gift.ownerIds],
    visibleTo: visibleToFor(userIds, gift.ownerIds),
  });
}

export const removeVote = (me, targetUserId) => deleteDoc(doc(db, 'votes', voteId(me, targetUserId)));

/**
 * « Réparation » de visibilité, faite silencieusement par chaque membre :
 *  - un membre inscrit après un vote est ajouté à visibleTo ;
 *  - si un cadeau a été combiné ensuite, le nouveau co-destinataire est retiré.
 * Les règles Firestore n'autorisent que ces deux modifications.
 */
const attempted = new Set();
export function repairVotes(votes, giftsById, userIds) {
  for (const v of votes) {
    const gift = giftsById.get(v.giftId);
    if (!gift) continue;
    const hidden = gift.ownerIds;
    const wanted = new Set([...(v.visibleTo || []).filter((id) => !hidden.includes(id)), ...visibleToFor(userIds, hidden)]);
    const sameHidden = hidden.length === (v.hiddenFrom || []).length && hidden.every((id) => v.hiddenFrom.includes(id));
    const sameVisible = wanted.size === (v.visibleTo || []).length && (v.visibleTo || []).every((id) => wanted.has(id));
    if (sameHidden && sameVisible) continue;
    const key = `${v.id}|${[...hidden].sort()}|${[...wanted].sort()}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    updateDoc(doc(db, 'votes', v.id), { hiddenFrom: [...hidden], visibleTo: [...wanted] }).catch(() => {});
  }
}

/* ------------------------------------------------------------- Résultats */

/** Enregistre le résultat figé d'un destinataire (première écriture gagnante). */
export function saveSelected({ me, targetUserId, result, giftsById, userIds }) {
  return setDoc(doc(db, 'selectedGifts', targetUserId), {
    ...selectedPayload({ targetUserId, result, giftsById, userIds }),
    computedBy: me,
    computedAt: serverTimestamp(),
  });
}

/** Ajoute aux résultats les membres inscrits après leur calcul. */
export function repairSelected(selectedDocs, userIds) {
  for (const s of selectedDocs) {
    const missing = visibleToFor(userIds, s.hiddenFrom).filter((id) => !s.visibleTo.includes(id));
    if (!missing.length) continue;
    const key = `sel|${s.id}|${missing.sort()}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    updateDoc(doc(db, 'selectedGifts', s.id), { visibleTo: [...s.visibleTo, ...missing] }).catch(() => {});
  }
}
