/**
 * app.js — Point d'entrée de « Liste de Noël Familiale ».
 *
 * Architecture (Vanilla JS, modules ES, aucune étape de build) :
 *   js/config.js    constantes (date de clôture, limites)
 *   js/firebase.js  initialisation Firebase (CDN)
 *   js/session.js   jeton d'appareil, inscription, reconnexion transparente
 *   js/pairing.js   appairage QR code / code à 6 chiffres
 *   js/data.js      lectures temps réel + écritures Firestore
 *   js/results.js   dépouillement des votes et gestion des égalités (logique pure)
 *   js/metadata.js  recherche automatique (titre, image, prix) d'un produit
 *   js/ui.js        utilitaires d'affichage, modales, toasts
 *
 * Rendu : un objet `state` unique → render() reconstruit la vue courante
 * (routage par hash : #/famille, #/ma-liste, #/liste/<id>, #/resultats, #/profil).
 */
import { VOTE_DEADLINE, MIN_GIFTS, MAX_GIFTS, isVotingOpen } from './js/config.js';
import {
  esc, safeUrl, formatPrice, parsePrice, firstName, fullName, initials, avatarHue,
  formatCountdown, formatDate, toast, openModal, confirmDialog, errorMessage,
} from './js/ui.js';
import { startSession, currentUid, registerProfile, updateProfile, removeDevice } from './js/session.js';
import {
  createPairingRequest, cancelPairing, getPairing, approvePairing, pairingUrl,
  extractCode, drawQr, scannerSupported, startScanner,
} from './js/pairing.js';
import * as data from './js/data.js';
import { computeResults, canComputeFor, giftsOf, tally } from './js/results.js';
import { fetchProductInfo, isUrl, searchLinks } from './js/metadata.js';

/* =========================================================== ÉTAT GLOBAL */

const state = {
  session: { status: 'loading' },        // loading | guest | member | error
  users: [], gifts: [], votes: [], selected: [], devices: [],
  ready: { users: false, gifts: false, votes: false, selected: false },
  fromServer: { gifts: false, votes: false },
  pairing: null,                          // { code, expiresAt } sur l'écran d'association
  pairingBusy: false,
  open: isVotingOpen(),
};
let unsubs = [];

const me = () => state.session.userId;
const userMap = () => new Map(state.users.map((u) => [u.id, u]));
const giftMap = () => new Map(state.gifts.map((g) => [g.id, g]));
const userById = (id) => state.users.find((u) => u.id === id);
const giftById = (id) => state.gifts.find((g) => g.id === id);
const appUrl = () => `${location.origin}${location.pathname}`;

/* ============================================================== SESSION */

startSession((s) => {
  const prev = state.session;
  state.session = s;

  if (s.status === 'member' && (prev.status !== 'member' || prev.userId !== s.userId)) {
    if (state.pairing) {                       // l'appairage vient d'aboutir
      cancelPairing(state.pairing.code);         // nettoyage de la demande
      state.pairing = null;
      toast('Appareil associé à votre compte 🎉', 'success');
      location.hash = '#/famille';
    }
    subscribe(s.userId);
  }
  if (s.status !== 'member' && prev.status === 'member') {
    unsubscribe();
    if (prev.userId) toast('Cet appareil a été déconnecté.');
  }
  scheduleRender();
});

let subscribeRetries = 0;
let retryTimer = null;
function subscribe(userId) {
  unsubscribe();
  const onErr = (err) => {
    console.error(err);
    // Un refus juste après l'inscription / l'association peut être transitoire : on réessaie (2 fois max)
    if (String(err?.code).includes('permission-denied') && subscribeRetries < 2) {
      if (!retryTimer) {
        subscribeRetries++;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (state.session.userId === userId) subscribe(userId);
        }, 1500);
      }
      return;
    }
    toast(errorMessage(err), 'error');
  };
  unsubs = [
    data.watchUsers((list) => { state.users = list; state.ready.users = true; changed(); }, onErr),
    data.watchGifts((list, server) => {
      state.gifts = list; state.ready.gifts = true; state.fromServer.gifts ||= server; changed();
    }, onErr),
    data.watchVotes(userId, (list, server) => {
      state.votes = list; state.ready.votes = true; state.fromServer.votes ||= server; changed();
    }, onErr),
    data.watchSelected(userId, (list) => { state.selected = list; state.ready.selected = true; changed(); }, onErr),
    data.watchMyDevices(userId, (list) => { state.devices = list; changed(); }, onErr),
  ];
}

function unsubscribe() {
  unsubs.forEach((u) => u());
  unsubs = [];
  Object.assign(state, { users: [], gifts: [], votes: [], selected: [], devices: [] });
  Object.keys(state.ready).forEach((k) => { state.ready[k] = false; });
  state.fromServer = { gifts: false, votes: false };
}

function changed() { scheduleRender(); scheduleMaintenance(); }

/* ====================================================== MAINTENANCE AUTO */

let maintenanceTimer = null;
const finalizeTried = new Set();
function scheduleMaintenance() {
  clearTimeout(maintenanceTimer);
  maintenanceTimer = setTimeout(maintenance, 800);
}

/**
 * Tâches silencieuses exécutées par chaque membre connecté :
 *  1. tenir à jour la visibilité des votes (nouveaux inscrits, cadeaux combinés) ;
 *  2. après le 5/12 18h : calculer et FIGER le résultat de chaque destinataire
 *     dans selectedGifts (seul un membre qui voit tous les votes peut le faire).
 */
function maintenance() {
  const r = state.ready;
  if (state.session.status !== 'member' || !r.users || !r.gifts || !r.votes || !r.selected) return;
  if (!state.fromServer.gifts || !state.fromServer.votes) return; // jamais sur un cache partiel
  const gifts = giftMap();
  const userIds = state.users.map((u) => u.id);

  data.repairVotes(state.votes, gifts, userIds);

  if (!isVotingOpen()) {
    for (const u of state.users) {
      if (state.selected.some((s) => s.id === u.id)) continue;
      if (!canComputeFor(me(), u.id, state.gifts) || finalizeTried.has(u.id)) continue;
      finalizeTried.add(u.id);
      const result = computeResults(u.id, state.gifts, state.votes);
      data.saveSelected({ me: me(), targetUserId: u.id, result, giftsById: gifts, userIds }).catch(() => {});
    }
    data.repairSelected(state.selected, userIds);
  }
}

/* ========================================================== HORLOGE */

setInterval(tick, 1000);
function tick() {
  const nowOpen = isVotingOpen();
  if (nowOpen !== state.open) {             // passage de 18h00 pile : clôture
    state.open = nowOpen;
    toast('🔔 Les votes sont clos ! Découvrez les cadeaux retenus.', 'success');
    changed();
  }
  updatePhaseChip();
  const timer = document.getElementById('pair-timer');
  if (timer && state.pairing) {
    const left = state.pairing.expiresAt - Date.now();
    if (left <= 0 && !state.pairing.expired) { state.pairing.expired = true; scheduleRender(); }
    timer.textContent = formatCountdown(left);
  }
  const big = document.getElementById('big-countdown');
  if (big) big.textContent = formatCountdown(VOTE_DEADLINE - Date.now());
}

function updatePhaseChip() {
  const chip = document.getElementById('phase-chip');
  if (!chip) return;
  if (state.session.status !== 'member') { chip.hidden = true; return; }
  chip.hidden = false;
  chip.className = `phase-chip ${state.open ? 'is-open' : 'is-closed'}`;
  chip.textContent = state.open
    ? `⏳ Votes : ${formatCountdown(VOTE_DEADLINE - Date.now())}`
    : '🎁 Votes clos';
}

/* =============================================================== ROUTAGE */

function parseRoute() {
  const [name = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return { name, arg: decodeURIComponent(arg) };
}

let lastRoute = '';
window.addEventListener('hashchange', () => {
  const route = parseRoute();
  // On quitte l'écran d'association : on annule la demande en cours
  if (lastRoute === 'associer' && route.name !== 'associer' && state.pairing && state.session.status === 'guest') {
    cancelPairing(state.pairing.code);
    state.pairing = null;
  }
  lastRoute = route.name;
  window.scrollTo(0, 0);
  scheduleRender();
});

/* =============================================================== RENDU */

let renderQueued = false;
let lastHtml = '';
let lastNav = '';
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const route = parseRoute();
  lastRoute = route.name;
  const view = document.getElementById('view');
  const nav = document.getElementById('nav');
  const s = state.session;
  let html;

  if (s.status === 'loading') html = viewLoading();
  else if (s.status === 'error') html = viewError(s.error);
  else if (s.status === 'guest') {
    if (route.name === 'associer') { ensurePairing(); html = viewPairing(); }
    else if (route.name === 'pair') html = viewGuestScanned();
    else html = viewWelcome();
  } else if (!state.ready.users || !state.ready.gifts) html = viewLoading();
  else if (!userById(me())) html = viewMissingProfile();
  else {
    if (route.name === 'pair') {                 // QR code scanné avec l'appareil photo natif
      const code = extractCode(`pair/${route.arg}`);
      history.replaceState(null, '', '#/profil');
      if (code) setTimeout(() => openApproveModal(code), 0);
      route.name = 'profil';
    }
    switch (route.name) {
      case 'ma-liste': html = viewMyList(); break;
      case 'liste': html = route.arg === me() ? viewMyList() : viewMemberList(route.arg); break;
      case 'resultats': html = viewResults(); break;
      case 'profil': html = viewProfile(); break;
      default: html = viewFamily();
    }
  }

  if (html !== lastHtml) { view.innerHTML = html; lastHtml = html; afterRender(); }
  const navHtml = s.status === 'member' ? viewNav(route.name) : '';
  if (navHtml !== lastNav) { nav.innerHTML = navHtml; nav.hidden = !navHtml; lastNav = navHtml; }
  updatePhaseChip();
}

function afterRender() {
  const canvas = document.getElementById('qr');
  if (canvas && state.pairing && canvas.dataset.drawn !== state.pairing.code) {
    canvas.dataset.drawn = state.pairing.code;
    drawQr(canvas, pairingUrl(state.pairing.code)).catch(console.error);
  }
}

/* ---------------------------------------------------------- Composants */

function avatar(user, size = '') {
  return `<span class="avatar ${size}" style="--h:${avatarHue(user?.id)}">${esc(initials(user))}</span>`;
}

function giftImage(gift, cls = 'gift-img') {
  const src = safeUrl(gift.imageUrl);
  return `<div class="${cls}">${src
    ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="gift-placeholder" aria-hidden="true">🎁</span>'}</div>`;
}

/** Badge « Cadeau commun avec X » vu depuis la liste de `listOwnerId`. */
function sharedBadge(gift, listOwnerId) {
  if (gift.ownerIds.length < 2) return '';
  const otherId = gift.ownerIds.find((id) => id !== listOwnerId);
  const label = otherId === me() ? 'vous' : firstName(userById(otherId));
  return `<span class="badge badge-shared">💞 Cadeau commun avec ${esc(label)}</span>`;
}

function phaseBanner() {
  if (state.open) {
    return `<div class="banner banner-open">
      <strong>Votes ouverts</strong> jusqu'au ${esc(formatDate(VOTE_DEADLINE))}.
      Choisissez, pour chaque personne, le cadeau que vous préférez lui offrir.</div>`;
  }
  return `<a class="banner banner-closed" href="#/resultats">
      <strong>🎁 Les votes sont clos !</strong> Découvrez les cadeaux choisis par la famille →</a>`;
}

/**
 * Carte cadeau.
 * mode 'mine'  : ma liste (actions modifier / combiner / supprimer, AUCUN vote affiché)
 * mode 'other' : liste d'un proche (bouton de vote + votes en cours)
 */
function giftCard(gift, { mode, listOwnerId, voters = [], myVoteGiftId = null }) {
  const users = userMap();
  const iOwn = gift.ownerIds.includes(me());
  const isCreator = gift.createdBy === me();
  let actions = '';

  if (mode === 'mine' && state.open) {
    actions = `
      <button class="btn btn-sm btn-ghost" data-action="edit-gift" data-id="${gift.id}">✏️ Modifier</button>
      ${isCreator
        ? `<button class="btn btn-sm btn-ghost" data-action="combine-gift" data-id="${gift.id}"
             title="Combiner ce cadeau avec…">💞 Combiner avec…</button>
           <button class="btn btn-sm btn-ghost danger btn-icon" data-action="delete-gift" data-id="${gift.id}"
             aria-label="Supprimer" title="Supprimer">🗑️</button>`
        : `<button class="btn btn-sm btn-ghost danger" data-action="leave-gift" data-id="${gift.id}">Retirer de ma liste</button>`}`;
  }

  if (mode === 'other') {
    if (iOwn) {
      actions = '<span class="muted small">🤫 Cadeau commun avec vous : votes masqués</span>';
    } else {
      const chosen = myVoteGiftId === gift.id;
      const names = voters.map((id) => firstName(users.get(id))).join(', ');
      const voteBtn = state.open
        ? `<button class="btn btn-sm ${chosen ? 'btn-voted' : 'btn-vote'}" data-action="vote"
             data-id="${gift.id}" data-target="${esc(listOwnerId)}" aria-pressed="${chosen}">
             ${chosen ? '✓ Mon choix' : '❤ Je préfère ce cadeau'}</button>`
        : '';
      actions = `${voteBtn}
        <span class="votes-chip ${voters.length ? 'has-votes' : ''}" title="${esc(names)}">
          ${voters.length} vote${voters.length > 1 ? 's' : ''}${names ? ` · ${esc(names)}` : ''}</span>`;
    }
  }

  const chosenCls = mode === 'other' && myVoteGiftId === gift.id ? ' gift-chosen' : '';
  return `
    <article class="gift${chosenCls}">
      <button class="gift-main" data-action="detail" data-id="${gift.id}" data-list="${esc(listOwnerId)}">
        ${giftImage(gift)}
        <div class="gift-info">
          <h3>${esc(gift.title)}</h3>
          <div class="gift-meta">
            ${gift.price != null ? `<span class="price">${esc(formatPrice(gift.price))}</span>` : ''}
            ${sharedBadge(gift, listOwnerId)}
          </div>
          ${gift.commentary ? `<p class="gift-note">📝 ${esc(gift.commentary)}</p>` : ''}
        </div>
      </button>
      ${actions ? `<div class="gift-actions">${actions}</div>` : ''}
    </article>`;
}

/** Résultat pour un destinataire : document figé s'il est lisible, sinon calcul en direct. */
function resultFor(targetId) {
  const saved = state.selected.find((s) => s.id === targetId);
  if (saved) return saved;
  if (canComputeFor(me(), targetId, state.gifts)) return computeResults(targetId, state.gifts, state.votes);
  return null; // résultat masqué pour moi (ou pas encore calculé par un autre membre)
}

function winnerCard(gift, votes, listOwnerId) {
  return `
    <button class="winner-card" data-action="detail" data-id="${gift.id}" data-list="${esc(listOwnerId)}">
      ${giftImage(gift, 'winner-img')}
      <span class="winner-title">${esc(gift.title)}</span>
      <span class="winner-meta">
        ${gift.price != null ? `<span class="price">${esc(formatPrice(gift.price))}</span>` : ''}
        <span>${votes} vote${votes > 1 ? 's' : ''}</span>
      </span>
      <span class="winner-cta">Voir le détail →</span>
    </button>`;
}

function resultBlock(targetId) {
  const r = resultFor(targetId);
  const who = esc(firstName(userById(targetId)));
  if (!r) {
    return `<div class="result result-hidden">🤫 Le résultat de ${who} n'est pas visible pour vous :
      soit le cadeau retenu est un cadeau commun avec vous (surprise !), soit il n'a pas encore été
      calculé — il apparaîtra dès qu'un autre membre ouvrira l'application.</div>`;
  }
  if (r.status === 'empty') return `<div class="result result-empty">${who} n'a ajouté aucune idée.</div>`;
  if (r.status === 'no-votes') {
    return `<div class="result result-empty">Aucun vote pour ${who} : choisissez librement dans sa liste.</div>`;
  }
  const gifts = r.giftIds.map(giftById).filter(Boolean);
  if (r.status === 'tie') {
    return `<div class="result result-tie">
        <div class="result-label">⚖️ Égalité aux votes : Cadeaux retenus</div>
        <p class="muted small">${r.giftIds.length} cadeaux à égalité avec ${r.maxVotes} vote${r.maxVotes > 1 ? 's' : ''} chacun.</p>
        <div class="tie-grid">${gifts.map((g) => winnerCard(g, r.maxVotes, targetId)).join('')}</div>
      </div>`;
  }
  return `<div class="result result-winner">
      <div class="result-label">🏆 Cadeau choisi par la famille</div>
      ${gifts.map((g) => winnerCard(g, r.maxVotes, targetId)).join('')}
    </div>`;
}

/* --------------------------------------------------------------- Vues */

const viewLoading = () => '<div class="center-screen"><div class="spinner" aria-label="Chargement"></div></div>';

function viewError(err) {
  return `<div class="card narrow">
      <h1>Oups…</h1>
      <p>${esc(errorMessage(err))}</p>
      <button class="btn btn-primary" onclick="location.reload()">Réessayer</button>
    </div>`;
}

function viewMissingProfile() {
  return `<div class="card narrow">
      <h1>Profil introuvable</h1>
      <p>Cet appareil est rattaché à un profil qui n'existe plus.</p>
      <button class="btn btn-danger" data-action="logout">Déconnecter cet appareil</button>
    </div>`;
}

function viewWelcome() {
  return `
    <section class="hero">
      <div class="hero-icon" aria-hidden="true">🎄</div>
      <h1>Notre liste de Noël</h1>
      <p>Partagez vos idées, votez en secret pour le cadeau de chacun et découvrez le choix
      de la famille le <strong>5 décembre à 18h00</strong>.</p>
    </section>
    <div class="grid-2">
      <form class="card" data-form="register" autocomplete="on">
        <h2>Première visite ?</h2>
        <p class="muted">Créez votre profil sur votre téléphone : il sera reconnu automatiquement
        à chaque visite, sans mot de passe.</p>
        <label>Prénom<input name="prenom" required maxlength="40" autocomplete="given-name"></label>
        <label>Nom<input name="nom" required maxlength="40" autocomplete="family-name"></label>
        <label>Code famille <span class="muted small">(si on vous en a donné un)</span>
          <input name="familyCode" maxlength="40" autocomplete="off"></label>
        <button class="btn btn-primary btn-block" type="submit">Créer mon profil</button>
      </form>
      <div class="card">
        <h2>Déjà inscrit ?</h2>
        <p class="muted">Vous avez déjà un profil sur votre téléphone et voulez utiliser cet
        ordinateur (ou un autre appareil) ?</p>
        <a class="btn btn-secondary btn-block" href="#/associer">📱 Associer mon téléphone</a>
      </div>
    </div>`;
}

function ensurePairing() {
  if (state.pairingBusy || (state.pairing && !state.pairing.expired)) return;
  if (state.pairing?.expired) return; // on attend le clic « Nouveau code »
  newPairingCode();
}

async function newPairingCode() {
  if (state.pairingBusy) return;
  state.pairingBusy = true;
  if (state.pairing) cancelPairing(state.pairing.code);
  state.pairing = null;
  scheduleRender();
  try {
    state.pairing = await createPairingRequest();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.pairingBusy = false;
    scheduleRender();
  }
}

function viewPairing() {
  const p = state.pairing;
  const body = !p
    ? '<div class="spinner"></div>'
    : p.expired
      ? `<p class="expired">Ce code a expiré.</p>
         <button class="btn btn-primary" data-action="new-code">Générer un nouveau code</button>`
      : `<canvas id="qr" class="qr" width="220" height="220" aria-label="QR code d'association"></canvas>
         <div class="code-big" aria-label="Code d'association">${p.code.slice(0, 3)}&nbsp;${p.code.slice(3)}</div>
         <p class="muted">Expire dans <strong id="pair-timer">${formatCountdown(p.expiresAt - Date.now())}</strong></p>
         <button class="btn btn-ghost btn-sm" data-action="new-code">↻ Nouveau code</button>`;
  return `
    <section class="card pairing narrow">
      <h1>Associer mon téléphone</h1>
      <ol class="steps">
        <li>Ouvrez l'application sur votre <strong>téléphone déjà connecté</strong>.</li>
        <li>Allez dans <strong>Profil → Scanner / Valider un nouvel appareil</strong>.</li>
        <li>Scannez ce QR code ou tapez le code à 6 chiffres.</li>
      </ol>
      <div class="pairing-box">${body}</div>
      <a href="#/" class="link">← Retour</a>
    </section>`;
}

function viewGuestScanned() {
  return `<div class="card narrow">
      <h1>Cet appareil n'est pas connecté</h1>
      <p>Pour valider un nouvel appareil, ouvrez ce lien sur le téléphone où votre profil
      est déjà créé (même navigateur), ou tapez le code dans <strong>Profil → Valider un nouvel appareil</strong>.</p>
      <a class="btn btn-secondary" href="#/">Accueil</a>
    </div>`;
}

function viewNav(active) {
  const items = [
    ['famille', '🏠', 'Famille'], ['ma-liste', '🎁', 'Ma liste'],
    ['resultats', '🏆', 'Résultats'], ['profil', '👤', 'Profil'],
  ];
  const current = active === 'liste' || !active ? 'famille' : active;
  return items.map(([r, icon, label]) => `
    <a href="#/${r}" class="nav-item ${current === r ? 'active' : ''}" ${current === r ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></a>`).join('');
}

function viewFamily() {
  const mine = giftsOf(me(), state.gifts);
  const others = state.users.filter((u) => u.id !== me())
    .sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  const myVotes = new Set(state.votes.filter((v) => v.voterUserId === me()).map((v) => v.targetUserId));

  const members = others.map((u) => {
    const count = giftsOf(u.id, state.gifts).length;
    const status = state.open
      ? (myVotes.has(u.id) ? '<span class="status ok">✓ Vous avez voté</span>'
        : count ? '<span class="status todo">À vous de voter</span>' : '<span class="status">Liste vide</span>')
      : '<span class="status done">Voir le cadeau retenu →</span>';
    return `<a class="member-card" href="#/liste/${esc(u.id)}">
        ${avatar(u)}
        <span class="member-info"><strong>${esc(fullName(u))}</strong>
          <span class="muted small">${count} idée${count > 1 ? 's' : ''}</span></span>
        ${status}
      </a>`;
  }).join('');

  return `
    ${phaseBanner()}
    <a class="card my-summary" href="#/ma-liste">
      ${avatar(userById(me()), 'avatar-lg')}
      <span><strong>Ma liste</strong><br>
        <span class="muted">${mine.length} / ${MAX_GIFTS} idées</span>
        ${mine.length < MIN_GIFTS && state.open ? `<br><span class="warn small">Ajoutez au moins ${MIN_GIFTS} idées</span>` : ''}
      </span>
      <span class="chev" aria-hidden="true">›</span>
    </a>
    <h2 class="section-title">La famille</h2>
    ${others.length ? `<div class="members">${members}</div>` : `
      <div class="card empty">
        <p>Personne d'autre n'est encore inscrit. Partagez le lien de l'application à la famille !</p>
        <button class="btn btn-secondary" data-action="copy-link">🔗 Copier le lien</button>
      </div>`}`;
}

function viewMyList() {
  const mine = giftsOf(me(), state.gifts);
  const canAdd = state.open && mine.length < MAX_GIFTS;
  return `
    <div class="page-head">
      <h1>Ma liste</h1>
      <span class="pill ${mine.length >= MIN_GIFTS ? 'pill-ok' : ''}">${mine.length} / ${MAX_GIFTS}</span>
    </div>
    <p class="secret-note">🤫 Les votes sur votre liste vous sont invisibles : surprise garantie !</p>
    ${!state.open ? '<p class="banner banner-closed">🔒 Les listes sont verrouillées depuis la clôture des votes.</p>' : ''}
    ${state.open && mine.length < MIN_GIFTS
      ? `<p class="hint">Ajoutez entre ${MIN_GIFTS} et ${MAX_GIFTS} idées pour laisser le choix à la famille.</p>` : ''}
    <div class="gift-list">
      ${mine.map((g) => giftCard(g, { mode: 'mine', listOwnerId: me() })).join('') ||
        '<div class="card empty"><p>Votre liste est vide pour l\'instant.</p></div>'}
    </div>
    ${canAdd ? '<button class="btn btn-primary btn-block btn-add" data-action="add-gift">＋ Ajouter une idée</button>' : ''}
    ${state.open && !canAdd ? `<p class="muted small center">Maximum de ${MAX_GIFTS} idées atteint.</p>` : ''}`;
}

function viewMemberList(targetId) {
  const target = userById(targetId);
  if (!target) return '<div class="card narrow"><p>Membre introuvable.</p><a href="#/famille">← Retour</a></div>';
  const list = giftsOf(targetId, state.gifts);
  const voters = tally(targetId, state.gifts, state.votes);
  const myVote = state.votes.find((v) => v.voterUserId === me() && v.targetUserId === targetId);
  const who = esc(firstName(target));

  return `
    <a href="#/famille" class="link back">← La famille</a>
    <div class="page-head">${avatar(target, 'avatar-lg')}<h1>Liste de ${esc(fullName(target))}</h1></div>
    ${!state.open ? resultBlock(targetId) : `
      <p class="muted">Votez pour l'idée que vous préférez offrir à ${who}. ${who} ne voit ni les votes
      ni les tendances ; les autres membres les voient pour se coordonner.</p>`}
    ${!state.open && list.length ? '<h2 class="section-title">Toutes ses idées</h2>' : ''}
    <div class="gift-list">
      ${list.map((g) => giftCard(g, {
        mode: 'other', listOwnerId: targetId, voters: voters.get(g.id) || [], myVoteGiftId: myVote?.giftId,
      })).join('') || `<div class="card empty"><p>${who} n'a pas encore ajouté d'idée.</p></div>`}
    </div>`;
}

function viewResults() {
  if (state.open) {
    return `
      <div class="card countdown-card">
        <div class="countdown-icon" aria-hidden="true">🎁</div>
        <h1>Révélation des cadeaux</h1>
        <p>Les votes se clôturent le <strong>${esc(formatDate(VOTE_DEADLINE))}</strong>.</p>
        <div class="big-countdown" id="big-countdown">${formatCountdown(VOTE_DEADLINE - Date.now())}</div>
        <p class="muted">À 18h00 pile, le cadeau ayant reçu le plus de votes sera désigné pour chaque
        personne. En cas d'égalité, les cadeaux ex æquo seront affichés côte à côte.</p>
      </div>`;
  }
  const others = state.users.filter((u) => u.id !== me())
    .sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
  return `
    <div class="page-head"><h1>Cadeaux retenus</h1></div>
    <div class="card surprise">🎁 Votre propre cadeau reste une surprise jusqu'à Noël !</div>
    ${others.map((u) => `
      <section class="result-section">
        <a class="result-head" href="#/liste/${esc(u.id)}">${avatar(u)}<strong>${esc(fullName(u))}</strong><span class="chev">›</span></a>
        ${resultBlock(u.id)}
      </section>`).join('')}`;
}

function viewProfile() {
  const user = userById(me());
  const uid = currentUid();
  const devices = [...state.devices].sort((a, b) => (a.id === uid ? -1 : b.id === uid ? 1 : 0));
  return `
    <div class="page-head">${avatar(user, 'avatar-lg')}<h1>${esc(fullName(user))}</h1></div>
    <div class="card">
      <h2>Appareils associés</h2>
      <ul class="device-list">
        ${devices.map((d) => `
          <li>
            <span>${d.label?.startsWith('Android') || d.label?.startsWith('iPhone') ? '📱' : '💻'}
              ${esc(d.label || 'Appareil')} ${d.id === uid ? '<span class="badge">cet appareil</span>' : ''}</span>
            ${d.id !== uid ? `<button class="btn btn-sm btn-ghost danger" data-action="remove-device" data-id="${esc(d.id)}">Retirer</button>` : ''}
          </li>`).join('')}
      </ul>
      <button class="btn btn-primary btn-block" data-action="approve-device">📷 Scanner / Valider un nouvel appareil</button>
      <p class="muted small">Astuce : associez au moins deux appareils (téléphone + ordinateur).
      Si vous effacez les données de votre navigateur, l'autre appareil vous permettra de vous reconnecter.</p>
    </div>
    <div class="card">
      <h2>Inviter la famille</h2>
      <p class="muted small">${esc(appUrl())}</p>
      <button class="btn btn-secondary" data-action="copy-link">🔗 Copier le lien</button>
    </div>
    <div class="profile-actions">
      <button class="btn btn-ghost" data-action="edit-name">✏️ Modifier mon nom</button>
      <button class="btn btn-ghost danger" data-action="logout">Déconnecter cet appareil</button>
    </div>`;
}

/* ============================================================== MODALES */

function openDetailModal(gift, listOwnerId) {
  const url = safeUrl(gift.url);
  const owners = gift.ownerIds.map((id) => firstName(userById(id))).join(' & ');
  openModal({
    title: gift.title,
    body: `
      <div class="detail">
        ${giftImage(gift, 'detail-img')}
        <div class="detail-meta">
          ${gift.price != null ? `<span class="price price-lg">${esc(formatPrice(gift.price))}</span>` : '<span class="muted">Prix non renseigné</span>'}
          ${sharedBadge(gift, listOwnerId || gift.createdBy)}
        </div>
        ${gift.description ? `<p>${esc(gift.description)}</p>` : ''}
        <div class="detail-note">
          <strong>📝 Précisions de ${esc(owners)}</strong>
          <p>${gift.commentary ? esc(gift.commentary) : '<span class="muted">Aucune précision.</span>'}</p>
        </div>
        ${url
          ? `<a class="btn btn-primary btn-block" href="${esc(url)}" target="_blank" rel="noopener noreferrer">🛒 Voir sur le site d'achat ↗</a>`
          : '<p class="muted small">Pas de lien d\'achat.</p>'}
      </div>`,
  });
}

function openGiftForm(gift = null) {
  const g = gift || {};
  const { el, close } = openModal({
    title: gift ? 'Modifier mon idée' : 'Nouvelle idée de cadeau',
    wide: true,
    body: `
      <form class="gift-form" novalidate>
        <div class="search-box">
          <label for="gf-q">🔎 Recherche automatique</label>
          <div class="input-row">
            <input id="gf-q" name="q" placeholder="Collez un lien produit ou tapez une recherche" autocomplete="off">
            <button type="button" class="btn btn-secondary" data-search>Rechercher</button>
          </div>
          <div class="search-out" aria-live="polite"></div>
        </div>
        <div class="form-preview">${giftImage(g, 'preview-img')}</div>
        <label>Titre *<input name="title" required maxlength="200" value="${esc(g.title)}"></label>
        <div class="row-2">
          <label>Prix estimé (€)<input name="price" inputmode="decimal" value="${g.price != null ? esc(String(g.price).replace('.', ',')) : ''}"></label>
          <label>Lien d'achat<input name="url" type="url" maxlength="2000" value="${esc(g.url)}" placeholder="https://…"></label>
        </div>
        <label>Image (lien)<input name="imageUrl" type="url" maxlength="2000" value="${esc(g.imageUrl)}" placeholder="https://…"></label>
        <label>Description<textarea name="description" rows="2" maxlength="1000">${esc(g.description)}</textarea></label>
        <label>Commentaire / précisions
          <textarea name="commentary" rows="2" maxlength="1000"
            placeholder="Taille L, couleur bleue uniquement, pointure 42…">${esc(g.commentary)}</textarea></label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Annuler</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`,
  });

  const form = el.querySelector('form');
  const out = el.querySelector('.search-out');
  const f = (name) => form.elements[name];
  const refreshPreview = () => {
    el.querySelector('.form-preview').innerHTML = giftImage({ imageUrl: f('imageUrl').value }, 'preview-img');
  };
  f('imageUrl').addEventListener('input', refreshPreview);

  const doSearch = async () => {
    const q = f('q').value.trim();
    if (!q) return;
    if (!isUrl(q)) {
      out.innerHTML = `<p class="small">Ouvrez un site, copiez le lien du produit choisi puis collez-le ci-dessus :</p>
        <div class="chips">${searchLinks(q).map((l) =>
          `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('')}</div>`;
      return;
    }
    f('url').value = q;
    out.innerHTML = '<p class="small"><span class="spinner spinner-sm"></span> Recherche des informations du produit…</p>';
    try {
      const info = await fetchProductInfo(q);
      if (info.title) f('title').value = info.title.slice(0, 200);
      if (info.description && !f('description').value) f('description').value = info.description.slice(0, 1000);
      if (info.imageUrl) { f('imageUrl').value = info.imageUrl; refreshPreview(); }
      if (info.price) f('price').value = String(info.price).replace('.', ',');
      out.innerHTML = `<p class="small ok">✓ Informations récupérées${info.price ? '' : ' (prix introuvable : à saisir)'}. Vérifiez-les avant d'enregistrer.</p>`;
    } catch (err) {
      out.innerHTML = `<p class="small warn">${esc(err.message)}</p>`;
    }
  };
  el.querySelector('[data-search]').addEventListener('click', doSearch);
  f('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      title: f('title').value,
      price: parsePrice(f('price').value),
      url: f('url').value,
      imageUrl: f('imageUrl').value,
      description: f('description').value,
      commentary: f('commentary').value,
    };
    if (!payload.title.trim()) { f('title').focus(); toast('Le titre est obligatoire.', 'error'); return; }
    for (const k of ['url', 'imageUrl']) {
      if (payload[k].trim() && !safeUrl(payload[k])) { f(k).focus(); toast('Le lien doit commencer par https://', 'error'); return; }
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (gift) await data.updateGift(gift.id, payload);
      else {
        if (giftsOf(me(), state.gifts).length >= MAX_GIFTS) throw new Error(`Maximum ${MAX_GIFTS} idées.`);
        await data.createGift(me(), payload);
      }
      toast(gift ? 'Idée modifiée ✓' : 'Idée ajoutée 🎁', 'success');
      close();
    } catch (err) {
      toast(errorMessage(err), 'error');
      btn.disabled = false;
    }
  });
  if (!gift) f('q').focus();
}

function openCombineModal(gift) {
  const current = gift.ownerIds.find((id) => id !== gift.createdBy) || '';
  const options = state.users.filter((u) => u.id !== me())
    .sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'))
    .map((u) => `<option value="${esc(u.id)}" ${u.id === current ? 'selected' : ''}>${esc(fullName(u))}</option>`).join('');
  const { el, close } = openModal({
    title: 'Combiner ce cadeau avec…',
    body: `
      <p class="muted">« ${esc(gift.title)} » apparaîtra aussi sur la liste de la personne choisie,
      avec la mention « Cadeau commun ».</p>
      <label>Membre de la famille
        <select name="partner"><option value="">— Cadeau personnel (non combiné) —</option>${options}</select></label>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Annuler</button>
        <button class="btn btn-primary" data-ok>Valider</button>
      </div>`,
  });
  el.querySelector('[data-ok]').addEventListener('click', async () => {
    const partnerId = el.querySelector('select').value || null;
    if (partnerId && partnerId !== current) {
      const count = giftsOf(partnerId, state.gifts).length;
      if (count >= MAX_GIFTS) { toast(`${firstName(userById(partnerId))} a déjà ${MAX_GIFTS} idées.`, 'error'); return; }
    }
    try {
      await data.setGiftPartner(gift, partnerId);
      toast(partnerId ? `Cadeau commun avec ${firstName(userById(partnerId))} 💞` : 'Cadeau redevenu personnel', 'success');
      close();
    } catch (err) { toast(errorMessage(err), 'error'); }
  });
}

/** Valider un nouvel appareil : scan du QR code ou saisie du code à 6 chiffres. */
function openApproveModal(prefill = '') {
  let stopScan = null;
  const { el, close } = openModal({
    title: 'Valider un nouvel appareil',
    onClose: () => stopScan?.(),
    body: `
      <p class="muted">Sur l'autre appareil, cliquez sur « Associer mon téléphone » pour afficher un code.</p>
      ${scannerSupported()
        ? `<button class="btn btn-secondary btn-block" data-scan>📷 Scanner le QR code</button>
           <div class="scanner" hidden><video playsinline muted></video></div>`
        : '<p class="small hint">Sur iPhone : scannez le QR code avec l\'appareil photo, le lien ouvrira directement cette page. Ou tapez le code ci-dessous.</p>'}
      <form class="code-form">
        <label>Code à 6 chiffres
          <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7"
            placeholder="123 456" value="${esc(prefill)}"></label>
        <button class="btn btn-primary" type="submit">Continuer</button>
      </form>
      <div class="approve-step" aria-live="polite"></div>`,
  });

  const step = el.querySelector('.approve-step');
  const check = async (raw) => {
    const code = extractCode(raw);
    if (!code) { step.innerHTML = '<p class="warn small">Le code doit contenir 6 chiffres.</p>'; return; }
    step.innerHTML = '<div class="spinner spinner-sm"></div>';
    try {
      const p = await getPairing(code);
      if (!p) throw new Error('Code inconnu. Vérifiez les 6 chiffres.');
      if (p.status !== 'pending') throw new Error('Ce code a déjà été utilisé.');
      if (p.expired) throw new Error('Ce code a expiré. Générez-en un nouveau sur l’autre appareil.');
      step.innerHTML = `
        <div class="confirm-device">
          <p>Autoriser <strong>${esc(p.label || 'cet appareil')}</strong> à accéder au compte
          de <strong>${esc(fullName(userById(me())))}</strong> ?</p>
          <p class="muted small">Ne validez que si vous avez vous-même affiché ce code.</p>
          <button class="btn btn-primary btn-block" data-confirm>✓ Autoriser cet appareil</button>
        </div>`;
      step.querySelector('[data-confirm]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await approvePairing(code, me());
          toast('Nouvel appareil associé ✓', 'success');
          close();
        } catch (err) { step.innerHTML = `<p class="warn small">${esc(err.message || errorMessage(err))}</p>`; }
      });
    } catch (err) {
      step.innerHTML = `<p class="warn small">${esc(err.message || errorMessage(err))}</p>`;
    }
  };

  el.querySelector('.code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    check(e.target.elements.code.value);
  });
  el.querySelector('[data-scan]')?.addEventListener('click', async (e) => {
    const box = el.querySelector('.scanner');
    box.hidden = false;
    e.target.hidden = true;
    try {
      stopScan = await startScanner(box.querySelector('video'), (code) => {
        box.hidden = true;
        el.querySelector('[name=code]').value = code;
        check(code);
      });
    } catch {
      box.hidden = true;
      toast("Caméra indisponible : tapez le code à la main.", 'error');
    }
  });
  if (prefill) check(prefill);
}

function openEditNameModal() {
  const u = userById(me());
  const { el, close } = openModal({
    title: 'Modifier mon nom',
    body: `<form>
        <label>Prénom<input name="prenom" required maxlength="40" value="${esc(u.prenom)}"></label>
        <label>Nom<input name="nom" required maxlength="40" value="${esc(u.nom)}"></label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Annuler</button>
          <button class="btn btn-primary">Enregistrer</button>
        </div></form>`,
  });
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { prenom, nom } = e.target.elements;
    if (!prenom.value.trim() || !nom.value.trim()) return;
    try { await updateProfile(me(), { prenom: prenom.value, nom: nom.value }); close(); }
    catch (err) { toast(errorMessage(err), 'error'); }
  });
}

/* ============================================================ ÉVÉNEMENTS */

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  switch (action) {
    case 'detail': {
      const g = giftById(id);
      if (g) openDetailModal(g, btn.dataset.list);
      break;
    }
    case 'add-gift': openGiftForm(); break;
    case 'edit-gift': openGiftForm(giftById(id)); break;
    case 'combine-gift': openCombineModal(giftById(id)); break;
    case 'delete-gift': {
      const g = giftById(id);
      if (g && await confirmDialog(`Supprimer « ${g.title} » ?`, { confirmLabel: 'Supprimer', danger: true })) {
        data.deleteGift(id).then(() => toast('Idée supprimée')).catch((err) => toast(errorMessage(err), 'error'));
      }
      break;
    }
    case 'leave-gift': {
      const g = giftById(id);
      if (g && await confirmDialog(`Retirer « ${g.title} » de votre liste ? Il restera sur celle de ${firstName(userById(g.createdBy))}.`)) {
        data.setGiftPartner(g, null).catch((err) => toast(errorMessage(err), 'error'));
      }
      break;
    }
    case 'vote': {
      const target = btn.dataset.target;
      const gift = giftById(id);
      if (!gift || !state.open) return;
      const mine = state.votes.find((v) => v.voterUserId === me() && v.targetUserId === target);
      btn.disabled = true;
      try {
        if (mine?.giftId === gift.id) {
          await data.removeVote(me(), target);
          toast('Vote retiré');
        } else {
          await data.castVote({ me: me(), targetUserId: target, gift, userIds: state.users.map((u) => u.id) });
          toast(mine ? 'Vote modifié ✓' : 'Vote enregistré ❤', 'success');
        }
      } catch (err) { toast(errorMessage(err), 'error'); btn.disabled = false; }
      break;
    }
    case 'new-code': newPairingCode(); break;
    case 'approve-device': openApproveModal(); break;
    case 'edit-name': openEditNameModal(); break;
    case 'remove-device':
      if (await confirmDialog('Retirer cet appareil de votre compte ?', { confirmLabel: 'Retirer', danger: true })) {
        removeDevice(me(), id).catch((err) => toast(errorMessage(err), 'error'));
      }
      break;
    case 'logout':
      if (await confirmDialog('Déconnecter cet appareil ? Il faudra l’associer à nouveau depuis un autre appareil connecté (ou recréer un profil).', { confirmLabel: 'Déconnecter', danger: true })) {
        removeDevice(me(), currentUid()).catch((err) => toast(errorMessage(err), 'error'));
      }
      break;
    case 'copy-link':
      navigator.clipboard?.writeText(appUrl()).then(() => toast('Lien copié ✓', 'success'))
        .catch(() => toast(appUrl()));
      break;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form="register"]');
  if (!form) return;
  e.preventDefault();
  const { prenom, nom, familyCode } = form.elements;
  if (!prenom.value.trim() || !nom.value.trim()) { toast('Prénom et nom sont obligatoires.', 'error'); return; }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await registerProfile({ prenom: prenom.value, nom: nom.value, familyCode: familyCode.value });
    toast(`Bienvenue ${prenom.value.trim()} ! 🎄`, 'success');
    location.hash = '#/ma-liste';
  } catch (err) {
    toast(String(err?.code).includes('permission-denied') ? 'Code famille incorrect.' : errorMessage(err), 'error');
    btn.disabled = false;
  }
});

/* Image cassée → icône cadeau */
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.gift-img, .winner-img, .detail-img, .preview-img')) {
    e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'gift-placeholder', textContent: '🎁' }));
  }
}, true);

render();
