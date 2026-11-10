/**
 * Tests de la logique de dépouillement (égalités incluses).
 * Lancement :  node tests/results.test.mjs   (aucune dépendance)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeResults, canComputeFor, selectedPayload, tally } from '../js/results.js';

const gift = (id, ownerIds, createdAt = 0) => ({ id, ownerIds, createdBy: ownerIds[0], title: id, createdAt });
const vote = (voterUserId, targetUserId, giftId) => ({ voterUserId, targetUserId, giftId });

const gifts = [
  gift('velo', ['alice'], 1),
  gift('livre', ['alice'], 2),
  gift('casque', ['alice'], 3),
  gift('weekend', ['alice', 'bob'], 4),   // cadeau commun Alice + Bob
  gift('montre', ['bob'], 5),
];

test('un gagnant unique', () => {
  const r = computeResults('alice', gifts, [
    vote('carol', 'alice', 'velo'), vote('dave', 'alice', 'velo'), vote('eve', 'alice', 'livre'),
  ]);
  assert.equal(r.status, 'winner');
  assert.deepEqual(r.giftIds, ['velo']);
  assert.equal(r.tie, false);
  assert.equal(r.maxVotes, 2);
  assert.equal(r.totalVotes, 3);
});

test('égalité à deux : les deux cadeaux sont retenus, dans l’ordre de la liste', () => {
  const r = computeResults('alice', gifts, [
    vote('carol', 'alice', 'livre'), vote('dave', 'alice', 'velo'),
    vote('eve', 'alice', 'livre'), vote('fred', 'alice', 'velo'), vote('gina', 'alice', 'casque'),
  ]);
  assert.equal(r.status, 'tie');
  assert.equal(r.tie, true);
  assert.deepEqual(r.giftIds, ['velo', 'livre']);
  assert.equal(r.maxVotes, 2);
});

test('égalité à trois (un vote chacun)', () => {
  const r = computeResults('alice', gifts, [
    vote('carol', 'alice', 'velo'), vote('dave', 'alice', 'livre'), vote('eve', 'alice', 'casque'),
  ]);
  assert.equal(r.status, 'tie');
  assert.deepEqual(r.giftIds, ['velo', 'livre', 'casque']);
});

test('aucun vote / liste vide', () => {
  assert.equal(computeResults('alice', gifts, []).status, 'no-votes');
  assert.equal(computeResults('zoe', gifts, []).status, 'empty');
});

test('votes ignorés : propriétaire, cadeau supprimé, mauvaise liste, doublon', () => {
  const r = computeResults('alice', gifts, [
    vote('bob', 'alice', 'weekend'),     // Bob vote pour un cadeau dont il est co-propriétaire
    vote('carol', 'alice', 'supprime'),  // cadeau qui n'existe plus
    vote('dave', 'alice', 'montre'),     // cadeau qui n'est pas sur la liste d'Alice
    vote('eve', 'alice', 'casque'),
    vote('eve', 'alice', 'velo'),        // doublon (ne devrait pas exister) : seul le 1er compte
  ]);
  assert.equal(r.status, 'winner');
  assert.deepEqual(r.giftIds, ['casque']);
  assert.equal(r.totalVotes, 1);
});

test('le cadeau commun compte séparément sur chaque liste', () => {
  const votes = [vote('carol', 'alice', 'weekend'), vote('carol', 'bob', 'weekend'), vote('dave', 'bob', 'montre')];
  assert.deepEqual(computeResults('alice', gifts, votes).giftIds, ['weekend']);
  const rb = computeResults('bob', gifts, votes);
  assert.equal(rb.status, 'tie');
  assert.deepEqual(rb.giftIds, ['weekend', 'montre']);
  assert.deepEqual(tally('bob', gifts, votes).get('montre'), ['dave']);
});

test('qui peut calculer le résultat', () => {
  assert.equal(canComputeFor('carol', 'alice', gifts), true);
  assert.equal(canComputeFor('alice', 'alice', gifts), false);  // destinataire
  assert.equal(canComputeFor('bob', 'alice', gifts), false);    // co-propriétaire du cadeau commun
});

test('résultat masqué au destinataire et aux co-propriétaires des cadeaux retenus', () => {
  const giftsById = new Map(gifts.map((g) => [g.id, g]));
  const userIds = ['alice', 'bob', 'carol', 'dave'];
  const withShared = selectedPayload({
    targetUserId: 'alice', giftsById, userIds,
    result: { status: 'tie', giftIds: ['velo', 'weekend'], tie: true, maxVotes: 1, totalVotes: 2 },
  });
  assert.deepEqual(withShared.hiddenFrom.sort(), ['alice', 'bob']);
  assert.deepEqual(withShared.visibleTo, ['carol', 'dave']);

  const personal = selectedPayload({
    targetUserId: 'alice', giftsById, userIds,
    result: { status: 'winner', giftIds: ['velo'], tie: false, maxVotes: 2, totalVotes: 2 },
  });
  assert.deepEqual(personal.hiddenFrom, ['alice']);
  assert.deepEqual(personal.visibleTo, ['bob', 'carol', 'dave']);
});
