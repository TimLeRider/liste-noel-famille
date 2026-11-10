/**
 * Tests des règles de sécurité Firestore avec l'émulateur Firebase.
 *
 * Prérequis : Java 11+ et `npm install` (installe firebase-tools et les outils de test).
 * Lancement : npm run test:rules
 *
 * Ces tests s'exécutent AVANT la clôture (5/12/2026 18h) : ils vérifient le secret
 * des votes, l'appairage et la protection des listes pendant la phase de vote.
 */
import test, { before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, getDocs, collection, query, where, writeBatch,
  serverTimestamp, Timestamp, arrayUnion,
} from 'firebase/firestore';

let env;
const db = (uid) => env.authenticatedContext(uid).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-liste-noel',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env?.cleanup());

/* Famille de test : alice & bob (cadeau commun « weekend »), carol, dave. */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    await setDoc(doc(f, 'config/family'), { code: 'SAPIN' });
    for (const [uid, userId, prenom] of [['uA', 'alice', 'Alice'], ['uB', 'bob', 'Bob'], ['uC', 'carol', 'Carol'], ['uD', 'dave', 'Dave']]) {
      await setDoc(doc(f, 'users', userId), { prenom, nom: 'Test', deviceTokens: [uid], familyCode: 'SAPIN' });
      await setDoc(doc(f, 'devices', uid), { userId, label: 'Test', method: 'register' });
    }
    const g = (ownerIds, title) => ({ ownerIds, createdBy: ownerIds[0], title, price: 10, url: '', imageUrl: '', description: '', commentary: '' });
    await setDoc(doc(f, 'gifts/velo'), g(['alice'], 'Vélo'));
    await setDoc(doc(f, 'gifts/weekend'), g(['alice', 'bob'], 'Week-end'));
    await setDoc(doc(f, 'gifts/montre'), g(['bob'], 'Montre'));
  });
});

const vote = (voter, target, giftId, hiddenFrom, visibleTo) => ({
  giftId, voterUserId: voter, targetUserId: target, timestamp: serverTimestamp(), hiddenFrom, visibleTo,
});

/* ------------------------------------------------------------------ Accès */

test('un inconnu (connecté anonymement, sans profil) ne lit rien', async () => {
  await assertFails(getDocs(collection(db('stranger'), 'users')));
  await assertFails(getDocs(collection(db('stranger'), 'gifts')));
});

test('inscription : refusée avec un mauvais code famille, acceptée avec le bon', async () => {
  const tryRegister = (code) => {
    const f = db('newUid');
    const b = writeBatch(f);
    b.set(doc(f, 'users/newUser'), { prenom: 'Zoé', nom: 'Test', deviceTokens: ['newUid'], familyCode: code, createdAt: serverTimestamp() });
    b.set(doc(f, 'devices/newUid'), { userId: 'newUser', label: 'Test', method: 'register', createdAt: serverTimestamp() });
    return b.commit();
  };
  await assertFails(tryRegister('MAUVAIS'));
  await assertSucceeds(tryRegister('SAPIN'));
});

test("impossible de s'approprier un profil existant", async () => {
  const f = db('pirate');
  await assertFails(setDoc(doc(f, 'devices/pirate'), { userId: 'alice', label: 'x', method: 'register', createdAt: serverTimestamp() }));
});

/* ------------------------------------------------------- Secret des votes */

test('Carol vote pour Alice : Dave le voit, Alice ne peut pas le lire', async () => {
  await assertSucceeds(setDoc(doc(db('uC'), 'votes/carol_alice'),
    vote('carol', 'alice', 'velo', ['alice'], ['bob', 'carol', 'dave'])));

  const forDave = await getDocs(query(collection(db('uD'), 'votes'), where('visibleTo', 'array-contains', 'dave')));
  if (forDave.size !== 1) throw new Error('Dave devrait voir 1 vote');

  await assertFails(getDoc(doc(db('uA'), 'votes/carol_alice')));
  await assertFails(getDocs(collection(db('uA'), 'votes')));
  const forAlice = await getDocs(query(collection(db('uA'), 'votes'), where('visibleTo', 'array-contains', 'alice')));
  if (forAlice.size !== 0) throw new Error('Alice ne doit voir aucun vote');
});

test('un vote rendu visible au destinataire est refusé', async () => {
  await assertFails(setDoc(doc(db('uC'), 'votes/carol_alice'),
    vote('carol', 'alice', 'velo', ['alice'], ['alice', 'bob', 'carol', 'dave'])));
});

test('cadeau commun : masqué aux deux destinataires, Bob ne peut pas voter pour lui', async () => {
  await assertFails(setDoc(doc(db('uC'), 'votes/carol_alice'),
    vote('carol', 'alice', 'weekend', ['alice'], ['bob', 'carol', 'dave'])));          // Bob non masqué
  await assertSucceeds(setDoc(doc(db('uC'), 'votes/carol_alice'),
    vote('carol', 'alice', 'weekend', ['alice', 'bob'], ['carol', 'dave'])));
  await assertFails(getDoc(doc(db('uB'), 'votes/carol_alice')));
  await assertFails(setDoc(doc(db('uB'), 'votes/bob_alice'),
    vote('bob', 'alice', 'weekend', ['alice', 'bob'], ['carol', 'dave'])));
});

test('on ne peut ni voter au nom d’un autre, ni voter pour soi', async () => {
  await assertFails(setDoc(doc(db('uC'), 'votes/dave_alice'),
    vote('dave', 'alice', 'velo', ['alice'], ['bob', 'carol', 'dave'])));
  await assertFails(setDoc(doc(db('uA'), 'votes/alice_alice'),
    vote('alice', 'alice', 'velo', ['alice'], ['bob', 'carol', 'dave'])));
});

test('réparation : un nouvel inscrit peut être ajouté aux lecteurs, jamais le destinataire', async () => {
  await setDoc(doc(db('uC'), 'votes/carol_alice'), vote('carol', 'alice', 'velo', ['alice'], ['bob', 'carol']));
  await assertSucceeds(updateDoc(doc(db('uB'), 'votes/carol_alice'), { visibleTo: ['bob', 'carol', 'dave'] }));
  await assertFails(updateDoc(doc(db('uB'), 'votes/carol_alice'), { visibleTo: ['alice', 'bob', 'carol', 'dave'] }));
});

test('les résultats ne peuvent pas être écrits avant la clôture', async () => {
  await assertFails(setDoc(doc(db('uC'), 'selectedGifts/alice'), {
    targetUserId: 'alice', status: 'winner', giftIds: ['velo'], tie: false, maxVotes: 1, totalVotes: 1,
    hiddenFrom: ['alice'], visibleTo: ['bob', 'carol', 'dave'], computedBy: 'carol', computedAt: serverTimestamp(),
  }));
});

/* ---------------------------------------------------------------- Cadeaux */

test('cadeaux : seul un propriétaire modifie, seul le créateur choisit le partenaire', async () => {
  await assertFails(updateDoc(doc(db('uC'), 'gifts/velo'), { title: 'Piraté' }));
  await assertSucceeds(updateDoc(doc(db('uA'), 'gifts/velo'), { ownerIds: ['alice', 'carol'] }));
  await assertFails(updateDoc(doc(db('uB'), 'gifts/weekend'), { ownerIds: ['alice', 'dave'] }));
  await assertSucceeds(updateDoc(doc(db('uB'), 'gifts/weekend'), { ownerIds: ['alice'] })); // Bob se retire
});

/* -------------------------------------------------------------- Appairage */

test('appairage : le téléphone d’Alice valide le code de son ordinateur', async () => {
  const pc = db('uPC');
  await assertSucceeds(setDoc(doc(pc, 'pairings/123456'), {
    code: '123456', requesterUid: 'uPC', status: 'pending', label: 'Windows · Chrome',
    createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
  }));
  await assertFails(getDocs(collection(pc, 'users')));             // pas encore membre

  // Un inconnu ne peut pas valider
  const s = db('stranger');
  const bad = writeBatch(s);
  bad.set(doc(s, 'devices/uPC'), { userId: 'alice', label: 'x', method: 'pairing', pairingCode: '123456', createdAt: serverTimestamp() });
  await assertFails(bad.commit());

  const phone = db('uA');
  const b = writeBatch(phone);
  b.set(doc(phone, 'devices/uPC'), { userId: 'alice', label: 'Windows · Chrome', method: 'pairing', pairingCode: '123456', createdAt: serverTimestamp() });
  b.update(doc(phone, 'users/alice'), { deviceTokens: arrayUnion('uPC') });
  b.update(doc(phone, 'pairings/123456'), { status: 'approved', userId: 'alice', approvedAt: serverTimestamp() });
  await assertSucceeds(b.commit());

  await assertSucceeds(getDocs(collection(pc, 'users')));          // l'ordinateur est connecté
});

test('appairage : un code expiré ne peut pas être validé', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'pairings/654321'), {
    code: '654321', requesterUid: 'uPC', status: 'pending', label: 'x', expiresAt: Timestamp.fromMillis(Date.now() - 1000),
  }));
  const phone = db('uA');
  await assertFails(setDoc(doc(phone, 'devices/uPC'),
    { userId: 'alice', label: 'x', method: 'pairing', pairingCode: '654321', createdAt: serverTimestamp() }));
});
