/**
 * config.js — Constantes globales de l'application.
 *
 * ⚠️ La date de clôture est AUSSI écrite dans firestore.rules (fonction deadline()).
 *    Si vous la changez ici, changez-la là-bas : ce sont les règles Firestore
 *    qui verrouillent réellement les votes côté serveur.
 */

/** Clôture des votes : samedi 5 décembre 2026, 18h00 heure de Paris (CET = UTC+1). */
export const VOTE_DEADLINE = new Date('2026-12-05T18:00:00+01:00');

/** Nombre d'idées conseillé / autorisé par liste (cadeaux communs inclus). */
export const MIN_GIFTS = 3;
export const MAX_GIFTS = 5;

/** Durée de validité d'un code d'appairage (5 minutes). */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Clé localStorage où l'on garde le jeton d'appareil et l'ID utilisateur associé. */
export const LS_SESSION_KEY = 'noel.session';

/** Les votes sont-ils encore ouverts ? (affichage — le serveur fait foi) */
export function isVotingOpen(now = Date.now()) {
  return now < VOTE_DEADLINE.getTime();
}
