/**
 * results.js — Logique PURE (sans Firebase) du dépouillement des votes.
 * Testée par tests/results.test.mjs  →  node tests/results.test.mjs
 */

/** Membres autorisés à voir une info : tout le monde sauf les personnes masquées. */
export function visibleToFor(userIds, hiddenFrom) {
  return userIds.filter((id) => !hiddenFrom.includes(id));
}

/** Cadeaux figurant sur la liste d'une personne (personnels + communs). */
export function giftsOf(userId, gifts) {
  return gifts
    .filter((g) => g.ownerIds?.includes(userId))
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? a.createdAt ?? 0) - (b.createdAt?.toMillis?.() ?? b.createdAt ?? 0));
}

/**
 * Compte les votes valides pour la liste d'un destinataire.
 * Un vote est valide si :
 *  - il vise ce destinataire et un cadeau encore présent sur sa liste ;
 *  - son auteur n'est pas lui-même propriétaire du cadeau ;
 *  - c'est le seul vote de ce votant pour ce destinataire (sécurité : dédoublonnage).
 * @returns {Map<string, string[]>} giftId → liste des votants
 */
export function tally(targetUserId, gifts, votes) {
  const list = giftsOf(targetUserId, gifts);
  const byId = new Map(list.map((g) => [g.id, g]));
  const voters = new Map(list.map((g) => [g.id, []]));
  const seen = new Set();
  for (const v of votes) {
    if (v.targetUserId !== targetUserId) continue;
    const gift = byId.get(v.giftId);
    if (!gift || gift.ownerIds.includes(v.voterUserId) || seen.has(v.voterUserId)) continue;
    seen.add(v.voterUserId);
    voters.get(gift.id).push(v.voterUserId);
  }
  return voters;
}

/**
 * Résultat du vote pour un destinataire, avec GESTION DES ÉGALITÉS.
 * @returns {{
 *   status: 'empty'|'no-votes'|'winner'|'tie',
 *   giftIds: string[],     // cadeau(x) retenu(s), dans l'ordre de la liste
 *   tie: boolean,
 *   maxVotes: number,
 *   totalVotes: number,
 *   counts: Record<string, number>
 * }}
 *  - 'empty'    : la personne n'a aucune idée sur sa liste
 *  - 'no-votes' : personne n'a voté
 *  - 'winner'   : un seul cadeau en tête
 *  - 'tie'      : plusieurs cadeaux ex æquo en tête → « Égalité aux votes : Cadeaux retenus »
 */
export function computeResults(targetUserId, gifts, votes) {
  const voters = tally(targetUserId, gifts, votes);
  const counts = Object.fromEntries([...voters].map(([id, list]) => [id, list.length]));
  const values = Object.values(counts);
  const totalVotes = values.reduce((a, b) => a + b, 0);
  const maxVotes = values.length ? Math.max(...values) : 0;

  if (!values.length) return { status: 'empty', giftIds: [], tie: false, maxVotes: 0, totalVotes: 0, counts };
  if (maxVotes === 0) return { status: 'no-votes', giftIds: [], tie: false, maxVotes: 0, totalVotes: 0, counts };

  const giftIds = [...voters.keys()].filter((id) => counts[id] === maxVotes);
  const tie = giftIds.length > 1;
  return { status: tie ? 'tie' : 'winner', giftIds, tie, maxVotes, totalVotes, counts };
}

/**
 * Un membre peut-il calculer (et enregistrer) le résultat d'un destinataire ?
 * Il doit voir TOUS les votes : il ne doit être ni le destinataire,
 * ni co-propriétaire d'un cadeau commun de cette liste.
 */
export function canComputeFor(me, targetUserId, gifts) {
  return me !== targetUserId && !giftsOf(targetUserId, gifts).some((g) => g.ownerIds.includes(me));
}

/**
 * Document selectedGifts/{targetUserId} : masqué au destinataire ET aux
 * co-propriétaires des cadeaux retenus (ex. conjoint pour un cadeau commun).
 */
export function selectedPayload({ targetUserId, result, giftsById, userIds }) {
  const hidden = new Set([targetUserId]);
  for (const id of result.giftIds) for (const o of giftsById.get(id)?.ownerIds || []) hidden.add(o);
  const hiddenFrom = [...hidden];
  return {
    targetUserId,
    status: result.status,
    giftIds: result.giftIds,
    tie: result.tie,
    maxVotes: result.maxVotes,
    totalVotes: result.totalVotes,
    hiddenFrom,
    visibleTo: visibleToFor(userIds, hiddenFrom),
  };
}
