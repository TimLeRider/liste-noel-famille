/**
 * metadata.js — « Recherche automatique » : extraction titre / image / prix / lien.
 *
 * GitHub Pages ne permet pas d'aller lire une page marchande directement (CORS)
 * et le plan Firebase gratuit n'inclut pas de Cloud Functions. On passe donc par
 * l'API publique Microlink (https://microlink.io), gratuite sans clé dans la limite
 * d'environ 50 requêtes par jour et par adresse IP.
 *
 * Pour une simple requête texte (ex. « casque Sony WH-1000XM5 »), aucune API de
 * recherche gratuite n'est utilisable sans clé : l'app propose des liens vers des
 * moteurs de recherche, puis l'utilisateur colle le lien du produit choisi.
 */
import { parsePrice } from './ui.js';

export const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());

/** Liens de recherche pour une requête texte. */
export function searchLinks(q) {
  const e = encodeURIComponent(q.trim());
  return [
    { label: 'Google Shopping', url: `https://www.google.com/search?tbm=shop&q=${e}` },
    { label: 'Amazon', url: `https://www.amazon.fr/s?k=${e}` },
    { label: 'Fnac', url: `https://www.fnac.com/SearchResult/ResultList.aspx?Search=${e}` },
    { label: 'Leboncoin', url: `https://www.leboncoin.fr/recherche?text=${e}` },
  ];
}

/** Cherche un prix dans les blocs JSON-LD schema.org (Product → offers). */
function priceFromJsonLd(blocks) {
  const list = Array.isArray(blocks) ? blocks : blocks ? [blocks] : [];
  const stack = [];
  for (const raw of list) {
    try {
      const text = String(raw).replace(/^\s*<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
      stack.push(JSON.parse(text));
    } catch { /* bloc illisible */ }
  }
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { stack.push(...node); continue; }
    for (const key of ['price', 'lowPrice']) {
      if (node[key] != null && (node['@type'] === 'Offer' || node['@type'] === 'AggregateOffer' || node.priceCurrency)) {
        const p = parsePrice(node[key]);
        if (p) return p;
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

/**
 * Récupère les informations d'un produit à partir de son URL.
 * @returns {Promise<{title:string, description:string, imageUrl:string, url:string, price:number|null}>}
 */
export async function fetchProductInfo(url) {
  const p = new URLSearchParams({ url: url.trim(), screenshot: 'false', video: 'false', audio: 'false' });
  // Règles d'extraction personnalisées Microlink (data.<champ>.selector / attr)
  p.set('data.jsonld.selectorAll', 'script[type="application/ld+json"]');
  p.set('data.jsonld.attr', 'html');
  const priceSelectors = [
    ['meta[property="product:price:amount"]', 'content'],
    ['meta[property="og:price:amount"]', 'content'],
    ['[itemprop="price"]', 'content'],
    ['[itemprop="price"]', 'text'],
  ];
  priceSelectors.forEach(([sel, attr], i) => {
    p.set(`data.priceMeta.${i}.selector`, sel);
    p.set(`data.priceMeta.${i}.attr`, attr);
  });

  const res = await fetch(`https://api.microlink.io/?${p}`, { signal: AbortSignal.timeout(25000) });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 'success') {
    if (res.status === 429) throw new Error('Limite quotidienne de recherche atteinte : remplissez les champs à la main.');
    throw new Error("Impossible de lire cette page (site protégé ?). Remplissez les champs à la main.");
  }
  const d = json.data || {};
  return {
    title: d.title || '',
    description: d.description || '',
    imageUrl: d.image?.url || d.logo?.url || '',
    url: d.url || url,
    price: parsePrice(d.priceMeta) || priceFromJsonLd(d.jsonld),
  };
}
