/**
 * firebase.js — Initialisation de Firebase (SDK modulaire chargé depuis le CDN Google).
 *
 * Aucune étape de build n'est nécessaire : les modules ES sont importés directement
 * par le navigateur. La configuration vient de /firebase-config.js, fichier :
 *   - généré automatiquement par GitHub Actions à partir des secrets du dépôt ;
 *   - ou copié à la main depuis firebase-config.example.js pour tester en local.
 */
const SDK = 'https://www.gstatic.com/firebasejs/12.15.0';

const [{ initializeApp }, authMod, fs] = await Promise.all([
  import(`${SDK}/firebase-app.js`),
  import(`${SDK}/firebase-auth.js`),
  import(`${SDK}/firebase-firestore.js`),
]);

let firebaseConfig;
try {
  ({ firebaseConfig } = await import('../firebase-config.js'));
} catch {
  throw new Error(
    'Fichier firebase-config.js introuvable. En local : copiez firebase-config.example.js ' +
    'en firebase-config.js et remplissez-le. En ligne : vérifiez les secrets GitHub.'
  );
}
if (!firebaseConfig?.apiKey || !firebaseConfig?.projectId) {
  throw new Error('firebase-config.js est incomplet (apiKey / projectId manquants).');
}

export const app = initializeApp(firebaseConfig);

/**
 * Authentification anonyme persistée dans le localStorage :
 * l'UID anonyme Firebase joue le rôle de « jeton d'appareil » (Device Token).
 * Il est unique, généré par Firebase et signé : impossible à falsifier, contrairement
 * à un simple UUID local.
 */
export const auth = authMod.initializeAuth(app, {
  persistence: [authMod.browserLocalPersistence, authMod.indexedDBLocalPersistence],
});
export const { signInAnonymously, onAuthStateChanged } = authMod;

export const db = fs.getFirestore(app);
export const {
  doc, collection, query, where, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, writeBatch, serverTimestamp, Timestamp, arrayUnion, arrayRemove,
} = fs;
