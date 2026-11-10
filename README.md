# 🎄 Liste de Noël Familiale

Application web (SPA, mobile first) pour partager les listes de Noël de la famille, créer des **cadeaux communs** entre partenaires et voter **en secret** pour le cadeau que chacun recevra. Les votes sont clôturés le **samedi 5 décembre 2026 à 18h00** (heure de Paris), puis le cadeau retenu (ou les cadeaux ex æquo) s'affiche pour chaque personne.

- **Hébergement** : GitHub Pages, gratuit — `https://timlerider.github.io/liste-noel-famille/`
- **Déploiement** : GitHub Actions, automatique à chaque push sur `main`
- **Données et authentification** : Firebase (plan gratuit Spark) : Firestore + connexion anonyme
- **Code** : HTML / CSS / JavaScript « vanilla » en modules ES. **Aucune étape de build** et aucune dépendance à installer pour faire tourner le site.

---

## Sommaire

1. [Fonctionnalités](#1-fonctionnalités)
2. [Arborescence](#2-arborescence)
3. [Prérequis](#3-prérequis)
4. [Configuration Firebase](#4-configuration-firebase)
5. [Dépôt GitHub, secrets et GitHub Pages](#5-dépôt-github-secrets-et-github-pages)
6. [Le workflow GitHub Actions](#6-le-workflow-github-actions)
7. [Schéma des données Firestore](#7-schéma-des-données-firestore)
8. [Sécurité : comment le secret des votes est garanti](#8-sécurité--comment-le-secret-des-votes-est-garanti)
9. [Dépouillement et gestion des égalités](#9-dépouillement-et-gestion-des-égalités)
10. [Lancement en local et tests](#10-lancement-en-local-et-tests)
11. [Tester la révélation avant le 5 décembre](#11-tester-la-révélation-avant-le-5-décembre)
12. [FAQ et dépannage](#12-faq-et-dépannage)

---

## 1. Fonctionnalités

| Domaine | Ce que fait l'application |
|---|---|
| **Première connexion** | Prénom + Nom (+ code famille facultatif). Un **jeton d'appareil** est créé et stocké dans le `localStorage`. Aux visites suivantes, l'appareil est reconnu automatiquement, sans mot de passe. |
| **Appairage** | Sur l'ordinateur : « Associer mon téléphone » affiche un **QR code** et un **code à 6 chiffres valable 5 minutes**. Sur le téléphone connecté : *Profil → Scanner / Valider un nouvel appareil*, puis confirmation. L'ordinateur est connecté instantanément. |
| **Ma liste** | 3 à 5 idées. Recherche automatique (titre, image, prix, lien à partir d'une URL produit), saisie manuelle, **commentaire / précisions** (taille, couleur, pointure…), modification et suppression. |
| **Cadeau commun** | « Combiner ce cadeau avec… » → liste déroulante des membres. Le cadeau apparaît sur les deux listes avec « 💞 Cadeau commun avec [Nom] ». Le partenaire peut s'en retirer. |
| **Vote secret** | « ❤ Je préfère ce cadeau » : un vote par personne et par liste (modifiable ou annulable). Les autres membres voient les votes en cours (nombre + prénoms) pour se coordonner. **Le destinataire ne voit rien sur sa liste.** |
| **Clôture** | Le 5/12/2026 à 18h00 pile, les votes **et** les listes sont verrouillés **côté serveur** (règles Firestore). L'interface bascule automatiquement, même si la page est déjà ouverte. |
| **Révélation** | 🏆 « Cadeau choisi par la famille », ou ⚖️ **« Égalité aux votes : Cadeaux retenus »** avec les cadeaux ex æquo côte à côte. Un clic ouvre la fiche : image, prix, précisions du destinataire, lien d'achat. |

---

## 2. Arborescence

```
liste-noel-famille/
├── index.html                  # Squelette de la page (barre du haut, vue, navigation)
├── style.css                   # Styles, mobile first
├── app.js                      # Point d'entrée : état, routage, vues, modales, événements
├── js/
│   ├── config.js               # Date de clôture, limites (3–5 idées), durée d'appairage
│   ├── firebase.js             # Initialisation Firebase (SDK modulaire via CDN)
│   ├── session.js              # Jeton d'appareil, inscription, reconnexion, déconnexion
│   ├── pairing.js              # Appairage : code 6 chiffres, QR code, scanner caméra
│   ├── data.js                 # Lectures temps réel et écritures Firestore
│   ├── results.js              # Dépouillement et égalités (logique pure, testée)
│   ├── metadata.js             # Recherche automatique des infos produit
│   └── ui.js                   # Échappement HTML, formats, modales, toasts
├── firestore.rules             # Règles de sécurité (secret des votes, verrouillage)
├── firebase.json               # Configuration pour la CLI Firebase et l'émulateur
├── firebase-config.example.js  # Modèle de configuration pour le développement local
├── manifest.webmanifest, icon.svg
├── tests/
│   ├── results.test.mjs        # Tests du dépouillement (lancés à chaque déploiement)
│   └── rules.test.mjs          # Tests des règles avec l'émulateur Firestore
├── package.json                # Scripts de développement uniquement (tests, serveur local)
└── .github/workflows/deploy.yml
```

> `firebase-config.js` n'est **jamais** commité (voir `.gitignore`) : il est généré par GitHub Actions à partir des secrets du dépôt.

---

## 3. Prérequis

- Un compte **GitHub** (ici `TimLeRider`).
- Un compte **Google** pour la console **Firebase** (plan Spark gratuit, aucune carte bancaire).
- Pour tester en local : **Python 3** *ou* **Node.js 20+** (pour un petit serveur HTTP).
- Facultatif, pour tester les règles : **Node.js 20+** et **Java 11+** (émulateur Firestore).

---

## 4. Configuration Firebase

### 4.1 Créer le projet

1. Ouvrez <https://console.firebase.google.com> → **Créer un projet** (ex. `liste-noel-famille`). Google Analytics n'est pas nécessaire.
2. Dans la vue d'ensemble, cliquez sur l'icône **Web `</>`** pour ajouter une application web (ex. « Liste de Noël »). Ne cochez pas Firebase Hosting.
3. Firebase affiche un objet `firebaseConfig` : **notez ces valeurs**, elles serviront pour les secrets GitHub (§5) et pour `firebase-config.js` en local.

### 4.2 Activer la connexion anonyme

**Build → Authentication → Commencer → Sign-in method → Anonyme → Activer → Enregistrer.**

> L'UID anonyme Firebase **est** le jeton d'appareil : il est unique, généré et signé par Firebase, et persisté dans le `localStorage` du navigateur. Contrairement à un simple UUID local, il ne peut pas être falsifié.

Dans **Authentication → Paramètres → Domaines autorisés**, ajoutez `timlerider.github.io`. Ce n'est pas indispensable pour la connexion anonyme, mais c'est une bonne pratique.

### 4.3 Créer la base Firestore

**Build → Firestore Database → Créer une base de données** :

- édition **Standard** ;
- emplacement **`europe-west9` (Paris)** ou **`eur3` (Europe)**. Ce choix est définitif ;
- démarrer en **mode production** (tout est bloqué tant que les règles ne sont pas publiées).

Aucun index composite n'est nécessaire : les index simples automatiques suffisent.

### 4.4 Publier les règles de sécurité (indispensable)

**Méthode A — console** : Firestore → onglet **Règles** → remplacez tout par le contenu de [`firestore.rules`](firestore.rules) → **Publier**.

**Méthode B — CLI** :

```bash
npm install                     # installe firebase-tools (dev uniquement)
npx firebase login
npx firebase deploy --only firestore:rules --project <ID_DU_PROJET>
```

> ⚠️ À refaire à chaque modification de `firestore.rules`. Le workflow GitHub ne déploie que le site, pas les règles.

### 4.5 (Recommandé) Définir un code famille

Sans code, toute personne qui connaît l'URL peut créer un profil et lire les listes. Pour l'éviter :

1. Firestore → **Données** → **Commencer une collection** : ID `config`.
2. ID du document : `family`. Champ `code`, type **string**, valeur par exemple `SAPIN2026`.
3. Communiquez ce code à la famille (SMS, WhatsApp…).

Le document `config/family` est **illisible depuis l'application** : les règles le comparent au code saisi à l'inscription. S'il n'existe pas, l'inscription est libre.

---

## 5. Dépôt GitHub, secrets et GitHub Pages

### 5.1 Nom du dépôt

> **Nom du dépôt : `liste-noel-famille`** (public)
> URL du site : **https://timlerider.github.io/liste-noel-famille/**

GitHub Pages gratuit exige un dépôt **public**. Le code ne contient aucun secret : la configuration Firebase est injectée au déploiement, et les données sont protégées par les règles Firestore.

### 5.2 Premier push

```bash
cd liste-noel-famille
git init
git add .
git commit -m "Première version de la liste de Noël"
git branch -M main
git remote add origin https://github.com/TimLeRider/liste-noel-famille.git
git push -u origin main
```

### 5.3 Secrets GitHub

Dépôt → **Settings → Secrets and variables → Actions → New repository secret**. Créez :

| Secret | Valeur (objet `firebaseConfig`) | Obligatoire |
|---|---|---|
| `FIREBASE_API_KEY` | `apiKey` | ✅ |
| `FIREBASE_PROJECT_ID` | `projectId` | ✅ |
| `FIREBASE_APP_ID` | `appId` | ✅ |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` | facultatif (déduit du projet) |
| `FIREBASE_STORAGE_BUCKET` | `storageBucket` | facultatif |
| `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` | facultatif |

> La clé d'API web Firebase n'est pas un vrai secret : elle identifie le projet et se retrouve de toute façon dans le JavaScript publié. Les secrets servent à la garder hors du dépôt Git. La sécurité réelle repose sur les **règles Firestore**. Pour aller plus loin, vous pouvez restreindre la clé aux référents `https://timlerider.github.io/*` et `http://localhost:*` dans Google Cloud Console → API et services → Identifiants.

### 5.4 Activer GitHub Pages

1. Après le premier push, ouvrez l'onglet **Actions** et attendez que « Déploiement GitHub Pages » soit vert. La branche `gh-pages` est alors créée.
2. **Settings → Pages → Build and deployment** : Source **Deploy from a branch**, branche **`gh-pages`**, dossier **`/ (root)`** → **Save**.
3. Une à deux minutes plus tard, le site est en ligne sur `https://timlerider.github.io/liste-noel-famille/`.

Ensuite, chaque `git push` sur `main` redéploie automatiquement le site.

---

## 6. Le workflow GitHub Actions

Fichier : [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (commenté ligne par ligne).

1. **Déclencheurs** : push sur `main`, ou bouton *Run workflow* (`workflow_dispatch`).
2. **Tests** : `node tests/results.test.mjs`. Si la logique de vote ou d'égalité est cassée, rien n'est déployé.
3. **Génération de `firebase-config.js`** à partir des secrets. Le job échoue avec un message clair si un secret obligatoire manque.
4. **Préparation** du dossier `_site` (uniquement les fichiers du site, plus `.nojekyll`).
5. **Publication** sur la branche `gh-pages` avec `peaceiris/actions-gh-pages@v4`, grâce à la permission `contents: write` et au `GITHUB_TOKEN` fourni automatiquement.

---

## 7. Schéma des données Firestore

### `users/{userId}` — profils

| Champ | Type | Description |
|---|---|---|
| `prenom`, `nom` | string | Identité affichée |
| `deviceTokens` | string[] | Jetons (UID anonymes) des appareils associés |
| `familyCode` | string | Code saisi à l'inscription (vérifié par les règles) |
| `createdAt` | timestamp | |

### `devices/{deviceToken}` — appareils (table de correspondance jeton → profil)

| Champ | Type | Description |
|---|---|---|
| `userId` | string | Profil auquel l'appareil est rattaché |
| `label` | string | Ex. « Android · Chrome », « Windows · Edge » |
| `method` | `'register'` \| `'pairing'` | Mode d'association |
| `pairingCode` | string | Code utilisé (si appairage) |
| `createdAt` | timestamp | |

> Cette collection complète `users.deviceTokens[]` : elle permet aux règles de retrouver en une lecture le profil associé à l'appareil qui fait la requête.

### `pairings/{code}` — demandes d'appairage (6 chiffres, 5 minutes)

`code`, `requesterUid` (jeton du nouvel appareil), `status` (`pending` → `approved`), `label`, `createdAt`, `expiresAt`, `userId` et `approvedAt` (après validation).

### `gifts/{giftId}` — idées de cadeaux

| Champ | Type | Description |
|---|---|---|
| `ownerIds` | string[] | **1 ID**, ou **2 IDs** si cadeau combiné |
| `createdBy` | string | Créateur (seul habilité à supprimer ou à choisir le partenaire) |
| `title` | string | Titre (obligatoire) |
| `price` | number \| null | Prix estimé en euros |
| `url`, `imageUrl` | string | Lien d'achat, image |
| `description` | string | Description |
| `commentary` | string | Commentaire / précisions du destinataire |
| `createdAt`, `updatedAt` | timestamp | |

### `votes/{voterUserId}_{targetUserId}` — votes

| Champ | Type | Description |
|---|---|---|
| `giftId` | string | Cadeau préféré |
| `voterUserId` | string | Votant |
| `targetUserId` | string | Destinataire (liste concernée) |
| `timestamp` | timestamp | Heure serveur du vote |
| `hiddenFrom` | string[] | Propriétaires du cadeau (destinataire + partenaire éventuel) : ne peuvent **pas** lire |
| `visibleTo` | string[] | Tous les autres membres : peuvent lire |

L'ID composé garantit **un seul vote par votant et par liste**. Voter pour un autre cadeau remplace le vote.

### `selectedGifts/{targetUserId}` — résultats figés après 18h00

`status` (`winner` \| `tie` \| `no-votes` \| `empty`), `giftIds[]` (un ou plusieurs en cas d'égalité), `tie`, `maxVotes`, `totalVotes`, `hiddenFrom[]`, `visibleTo[]`, `computedBy`, `computedAt`.

### `config/family` — réglages (console uniquement)

`code` : code famille demandé à l'inscription.

---

## 8. Sécurité : comment le secret des votes est garanti

Le masquage est appliqué **par le serveur** (règles Firestore), pas seulement par l'interface. Même en modifiant le JavaScript dans son navigateur, un destinataire ne peut pas lire ses votes :

- Un vote n'est lisible que si l'on figure dans son `visibleTo[]` (`allow read: if me() in resource.data.visibleTo`). L'application ne lit les votes que par la requête `where('visibleTo', 'array-contains', moi)`.
- À l'écriture, les règles imposent `hiddenFrom == propriétaires du cadeau` et l'absence de toute personne de `hiddenFrom` dans `visibleTo`. Un vote « visible par le destinataire » est donc **refusé**.
- **Cadeau commun** : les deux partenaires sont masqués. Le partenaire ne peut pas voter pour un cadeau qui lui est destiné.
- **`selectedGifts`** suit le même principe : le résultat est masqué au destinataire **et** aux co-destinataires des cadeaux retenus. Les règles vérifient les propriétaires de chaque cadeau retenu.
- **Verrouillage** : après le 5/12/2026 17:00 UTC (18h00 à Paris), toute création, modification ou suppression de vote ou de cadeau est refusée, et `selectedGifts` ne peut être écrit qu'après cette heure.
- **Maintenance automatique** : quand un membre s'inscrit après un vote, ou qu'un cadeau devient commun après coup, les applications des autres membres mettent à jour `visibleTo` / `hiddenFrom`. Les règles n'autorisent **que** ces ajustements.

**Ce qu'il faut savoir (modèle de confiance familial)**

- Après 18h00, le résultat de chaque personne est calculé puis **figé** par le premier membre qui ouvre l'application et voit tous les votes de cette liste. Un membre malveillant et techniquement habile pourrait écrire un faux résultat : c'est acceptable entre membres d'une même famille, et les votes bruts restent consultables.
- Le partenaire d'un cadeau commun voit le résultat de l'autre si le cadeau retenu est **personnel**. Il peut donc en déduire que le cadeau commun n'a pas gagné.

---

## 9. Dépouillement et gestion des égalités

Logique dans [`js/results.js`](js/results.js) (fonction pure `computeResults`, testée) :

1. On ne retient que les votes valides : bonne liste, cadeau encore présent, votant non propriétaire du cadeau, un seul vote par votant.
2. On compte les voix par cadeau et on prend le maximum `maxVotes`.
3. Résultat :
   - `empty` : la personne n'a aucune idée sur sa liste ;
   - `no-votes` : personne n'a voté (« choisissez librement ») ;
   - `winner` : **un seul** cadeau atteint `maxVotes` → 🏆 « Cadeau choisi par la famille » ;
   - `tie` : **plusieurs** cadeaux atteignent `maxVotes` → ⚖️ **« Égalité aux votes : Cadeaux retenus »**, tous affichés côte à côte, dans l'ordre de la liste.
4. Un cadeau commun est compté **séparément** sur chaque liste où il apparaît (un vote sur la liste d'Alice compte pour Alice).

---

## 10. Lancement en local et tests

```bash
# 1. Configuration
cp firebase-config.example.js firebase-config.js     # Windows : copy firebase-config.example.js firebase-config.js
#    → remplissez-le avec les valeurs de la console Firebase

# 2. Serveur local (les modules ES ne fonctionnent pas en file://)
python -m http.server 5500        # ou : npm start
#    → http://localhost:5500

# 3. Tests du dépouillement (aucune installation)
npm test                          # ou : node tests/results.test.mjs

# 4. Tests des règles de sécurité (Java 11+ requis)
npm install
npm run test:rules
```

Les tests de règles lancent l'émulateur Firestore et vérifient notamment : lecture impossible pour un inconnu, code famille, impossibilité de s'approprier un profil, **le destinataire ne peut lire aucun vote**, cadeau commun masqué aux deux partenaires, interdiction de voter pour soi ou au nom d'un autre, appairage valide, expiré ou frauduleux, et résultats non inscriptibles avant la clôture.

**Mettre en ligne une modification :**

```bash
git add .
git commit -m "Description de la modification"
git push            # → GitHub Actions teste et redéploie automatiquement
```

> 💡 Pour tester l'appairage en local avec votre téléphone, ouvrez `http://<IP-de-votre-PC>:5500` sur le téléphone (même Wi-Fi). La caméra du navigateur exige HTTPS : en local, tapez le code à 6 chiffres. Le scan QR fonctionne une fois le site en ligne.

---

## 11. Tester la révélation avant le 5 décembre

La date est définie à **deux endroits**, qui doivent rester identiques :

| Fichier | Ligne |
|---|---|
| `js/config.js` | `VOTE_DEADLINE = new Date('2026-12-05T18:00:00+01:00')` |
| `firestore.rules` | `timestamp.value(1796490000000)` (millisecondes UTC) |

Pour une répétition générale, utilisez un **projet Firebase de test** : avancez les deux dates de quelques minutes, publiez les règles, votez, puis attendez la clôture. Pour convertir une date en millisecondes : `new Date('2026-11-20T21:00:00+01:00').getTime()` dans la console du navigateur.

---

## 12. FAQ et dépannage

**« Impossible de démarrer : fichier firebase-config.js introuvable »**
En local, créez `firebase-config.js` (§10). En ligne, vérifiez les secrets et l'onglet Actions.

**« La connexion anonyme n'est pas activée »**
Voir §4.2.

**« Action refusée (droits insuffisants…) »**
Les règles ne sont pas publiées (§4.4), le code famille est incorrect, ou les votes sont clos.

**Sur iPhone, je dois me ré-associer**
Safari peut effacer les données d'un site non visité pendant 7 jours. Ajoutez l'app à l'écran d'accueil (Partager → *Sur l'écran d'accueil*). Attention : l'app installée a un stockage **séparé** de Safari, il faut donc l'associer une fois depuis un autre appareil. Associer au moins deux appareils évite toute perte de compte.

**J'ai perdu tous mes appareils**
Dans la console Firestore, supprimez votre profil et vos documents `devices`, puis recréez un profil. Ou bien un administrateur ajoute un document `devices/{nouveau jeton}` avec votre `userId`.

**La recherche automatique ne trouve rien**
Elle passe par l'API gratuite [Microlink](https://microlink.io), limitée à environ 50 requêtes par jour et par adresse IP. Certains sites (Amazon notamment) bloquent la lecture : complétez alors les champs à la main. Pour une recherche par mots-clés, l'app ouvre Google Shopping, Amazon, Fnac ou Leboncoin : copiez le lien du produit choisi et collez-le dans la recherche.

**Quotas du plan gratuit**
Spark : 50 000 lectures et 20 000 écritures par jour, largement suffisant pour une famille. Chaque ouverture de l'app lit les listes une fois, puis seules les modifications sont relues en temps réel.
