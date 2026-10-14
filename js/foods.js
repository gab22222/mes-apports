// Base d'aliments : table Ciqual + aliments personnalisés, recherche et unités.

import { NUTRIENT_BY_ID } from './nutrients.js';

export const foods = new Map();   // id -> aliment
let ciqualNutrients = [];
let groups = [];

// ---------- Chargement ----------

export async function loadCiqual() {
  const res = await fetch('data/ciqual.json');
  const data = await res.json();
  ciqualNutrients = data.nutriments;
  groups = data.groupes;
  for (const row of data.aliments) {
    const [code, name, g] = row;
    const values = {};
    ciqualNutrients.forEach((nid, i) => { values[nid] = row[3 + i]; });
    const food = { id: 'c:' + code, code, name, group: groups[g] || '', values, custom: false };
    indexFood(food);
    foods.set(food.id, food);
  }
}

// Aliment personnalisé : les valeurs saisies priment, les autres viennent de l'aliment Ciqual lié.
export function registerCustomFood(cf) {
  const ref = cf.ciqual_ref ? foods.get('c:' + cf.ciqual_ref) : null;
  const values = {}, sources = {};
  for (const nid of Object.keys(NUTRIENT_BY_ID)) {
    const own = cf.valeurs ? cf.valeurs[nid] : undefined;
    if (typeof own === 'number' && isFinite(own)) {
      values[nid] = own;
      sources[nid] = (cf.sources && cf.sources[nid]) || cf.source || 'manuel';
    } else if (ref && ref.values[nid] !== null && ref.values[nid] !== undefined) {
      values[nid] = ref.values[nid];
      sources[nid] = 'ciqual';
    } else {
      values[nid] = null;
    }
  }
  const name = cf.marque ? `${cf.nom} (${cf.marque})` : cf.nom;
  const food = {
    id: cf.id, name, group: ref ? ref.group : '', values, sources, custom: true,
    ref: ref ? ref.id : null, units: cf.unites || {}, raw: cf,
  };
  indexFood(food);
  foods.set(food.id, food);
  return food;
}

export function unregisterFood(id) { foods.delete(id); }

// ---------- Valeurs ----------

// Lecture d'une valeur pour 100 g. Retourne { v, missing }.
// Règle prudente : manquant, traces et « < x » comptent pour 0 ;
// pour les nutriments à limiter (sel, sucres, AG saturés), « < x » compte pour x.
export function readValue(raw, nid) {
  if (raw === null || raw === undefined) return { v: 0, missing: true };
  if (typeof raw === 'number') return { v: raw, missing: false };
  if (raw === 't') return { v: 0, missing: false };
  if (raw[0] === '<') return { v: NUTRIENT_BY_ID[nid].kind === 'max' ? parseFloat(raw.slice(1)) : 0, missing: false };
  if (raw[0] === '~') return { v: parseFloat(raw.slice(1)), missing: true };
  return { v: 0, missing: true };
}

export function displayValue(raw, unit) {
  if (raw === null || raw === undefined) return 'non renseigné';
  if (raw === 't') return 'traces';
  if (typeof raw === 'number') return `${fmtNum(raw)} ${unit}`;
  if (raw[0] === '<') return `< ${fmtNum(parseFloat(raw.slice(1)))} ${unit}`;
  if (raw[0] === '~') return `≥ ${fmtNum(parseFloat(raw.slice(1)))} ${unit} (partiel)`;
  return String(raw);
}

export function fmtNum(x, maxDigits) {
  if (!isFinite(x)) return '–';
  const a = Math.abs(x);
  const d = maxDigits !== undefined ? maxDigits : a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 1 : a >= 0.1 ? 2 : 3;
  return x.toLocaleString('fr-FR', { maximumFractionDigits: d });
}

export function shortName(food) {
  if (!food) return 'Aliment supprimé';
  if (food.custom) return food.name;
  const parts = food.name.split(',').map(s => s.trim());
  let s = parts[0];
  if (parts[1] && s.length < 22) s += ', ' + parts[1];
  return s;
}

// ---------- Recherche ----------

export function normalize(s) {
  return s.toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Pluriel simple : « pates » et « pate » se rejoignent.
const stem = t => (t.length > 3 && /[sx]$/.test(t) ? t.slice(0, -1) : t);

// Aliments de base mis en avant dans la recherche (avant que l'usage ne prenne le relais).
const STAPLES = [
  /^pates seches standard cuite/, /^riz blanc cuit/, /^riz complet cuit/, /^pain blanc/, /^pain de tradition/, /^pain complet/,
  /^pomme de terre bouillie/, /^oeuf (entier )?(cru|dur|au plat|brouille|poche|a la coque)/, /^oeuf cru/, /^lait demi ecreme uht/,
  /^yaourt nature/, /^yaourt au lait entier nature/, /^beurre a 80 mg minimum doux$/, /^huile d olive/, /^sauce tomate/,
  /^poulet filet/, /^poulet viande/, /^steak/, /^boeuf steak hache/, /^jambon cuit superieur$/, /^emmental ou emmenthal$/,
  /^banane chair sans peau crue/, /^pomme pulpe et peau crue/, /^pomme crue/, /^tomate crue/, /^carotte crue/, /^laitue crue/,
  /^courgette chair et peau cuite/, /^haricot vert cuit/, /^saumon cuit/, /^thon/, /^fromage blanc nature/, /^cafe non instantane/,
  /^the infuse/, /^sucre blanc/, /^lentille bouillie/, /^semoule ou graine de couscous cuite/, /^quinoa bouilli/, /^avocat/,
  /^orange chair/, /^brocoli bouilli/, /^epinard cuit/, /^comte/, /^mozzarella au lait de vache/, /^pois chiche bouilli/,
  /^miel/, /^flocons d avoine$/, /^eau du robinet/, /^jus d orange pur jus/, /^chocolat noir 50/, /^kiwi/,
  /^pain \(aliment moyen\)/, /^fromage \(aliment moyen\)/, /^salade verte/, /^concombre/, /^oignon cru/, /^poivron rouge cru/,
];
const LESS_LIKELY = /preemballe|prelevee? a la|semi conserve|appertise|enrichi|infantile|deshydrate|lyophilise|\bsurgele/;

function indexFood(food) {
  food.norm = normalize(food.name);
  food.tokens = food.norm.split(' ').filter(Boolean).map(stem);
  food.prior = (STAPLES.some(re => re.test(food.norm)) ? 3 : 0)
    + (/aliment moyen|\bstandard\b/.test(food.norm) ? 0.8 : 0)
    - (LESS_LIKELY.test(food.norm) ? 1.2 : 0);
}

// Distance de Damerau-Levenshtein (restreinte), bornée.
function dl(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

// Pour la tolérance aux fautes : on teste chaque mot distinct de la base une seule fois par requête.
function fuzzyVocab(q) {
  const tol = q.length >= 8 ? 2 : 1;
  const hits = new Set();
  const vocab = new Set();
  for (const f of foods.values()) for (const t of f.tokens) vocab.add(t);
  for (const t of vocab) {
    if (Math.abs(t.length - q.length) > 3 && t.length < q.length) continue;
    const d = Math.min(dl(q, t.slice(0, q.length)), dl(q, t.slice(0, q.length + 1)), dl(q, t.slice(0, q.length - 1)));
    if (d <= tol) hits.add(t);
  }
  return hits;
}

function tokenScore(q, tokens, fuzzySet) {
  let best = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let s = 0;
    if (t === q) s = 4;
    else if (t.startsWith(q)) s = 3;
    else if (q.length >= 3 && t.includes(q)) s = 1.2;
    else if (fuzzySet && fuzzySet.has(t)) s = 1;
    if (s && i === 0) s += 1.5;
    if (s > best) best = s;
  }
  return best;
}

export function search(query, usage, limit = 12) {
  const qn = normalize(query);
  if (!qn) return [];
  const qt = qn.split(' ').filter(Boolean).map(stem);
  // Recherche exacte d'abord ; tolérance aux fautes seulement si elle trouve peu de résultats.
  let results = searchPass(qt, usage, false);
  if (results.length < limit) {
    const seen = new Set(results.map(r => r[1].id));
    results = results.concat(searchPass(qt, usage, true).filter(r => !seen.has(r[1].id)).map(r => [r[0] - 2, r[1]]));
  }
  results.sort((a, b) => b[0] - a[0]);
  return results.slice(0, limit).map(r => r[1]);
}

function searchPass(qt, usage, fuzzy) {
  const results = [];
  const sets = qt.map(q => (fuzzy && q.length >= 4 ? fuzzyVocab(q) : null));
  for (const food of foods.values()) {
    let score = 0, ok = true;
    for (let k = 0; k < qt.length; k++) {
      const s = tokenScore(qt[k], food.tokens, sets[k]);
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    score += food.prior || 0;
    if (food.custom) score += 10;
    const u = usage.get(food.id) || 0;
    if (u) score += 2 + Math.log2(1 + u);
    score -= food.name.length / 60;
    results.push([score, food]);
  }
  return results;
}

// ---------- Unités ----------

export const UNITS = [
  { id: 'g', label: 'g', long: 'grammes' },
  { id: 'cas', label: 'c. à soupe', long: 'cuillère à soupe' },
  { id: 'cac', label: 'c. à café', long: 'cuillère à café' },
  { id: 'unite', label: 'unité', long: 'unité' },
  { id: 'portion', label: 'portion', long: 'portion' },
];
export const UNIT_BY_ID = Object.fromEntries(UNITS.map(u => [u.id, u]));

// Poids d'une cuillère à soupe selon la catégorie d'aliment.
function defaultTbsp(food) {
  const g = food.group, n = food.norm;
  if (/^miel/.test(n)) return 20;
  if (/^sucre/.test(n)) return 12;
  if (/^sel\b/.test(n) || g.includes('|sels')) return 18;
  if (/^(beurre|margarine|graisse|saindoux)/.test(n)) return 15;
  if (g.startsWith('matières grasses')) return 10;
  if (g.includes('|farines')) return 10;
  if (g.includes('|épices')) return 6;
  if (g.includes('|herbes')) return 3;
  if (g.includes('|confitures') || /pate a tartiner/.test(n)) return 20;
  if (g.includes('|sauces') || g.includes('|condiments') || g.includes('|aides culinaires')) return 15;
  if (g.includes('|crèmes')) return 15;
  if (g.includes('|laits') || g.startsWith('eaux et autres boissons')) return 15;
  if (g.includes('fruits à coque')) return 10;
  if (g.includes('sucres, miels')) return 15;
  if (g.includes('|produits laitiers frais')) return 20;
  return null;
}

// Poids d'une unité pour les aliments courants (début du nom Ciqual).
const PER_ITEM = [
  [/^oeuf\b/, 50], [/^pomme de terre/, 150], [/^patate douce/, 200], [/^pomme\b/, 150], [/^banane/, 120],
  [/^orange/, 150], [/^kiwi/, 75], [/^(clementine|mandarine)/, 60], [/^poire\b/, 150], [/^peche\b/, 130],
  [/^nectarine/, 130], [/^abricot/, 40], [/^prune\b/, 35], [/^figue/, 50], [/^datte/, 8], [/^pamplemousse/, 250],
  [/^citron/, 80], [/^avocat/, 140], [/^mangue/, 300], [/^tomate cerise/, 15], [/^tomate\b/, 100],
  [/^carotte/, 80], [/^oignon/, 100], [/^echalote/, 25], [/^ail\b/, 5], [/^courgette/, 200], [/^concombre/, 300],
  [/^poivron/, 150], [/^aubergine/, 250], [/^yaourt/, 125], [/^lait fermente/, 125], [/^petit suisse/, 60],
  [/^croissant/, 50], [/^pain au chocolat/, 70], [/^pain aux raisins/, 90], [/^brioche/, 40],
  [/^baguette/, 250], [/^camembert/, 250], [/^saucisse/, 60], [/^merguez/, 50], [/^jambon/, 45],
  [/^steak hache/, 100], [/^(blanc|filet) de poulet/, 120], [/^escalope/, 120], [/^crepe/, 50],
  [/^galette/, 60], [/^biscotte/, 9], [/^madeleine/, 25], [/^carre de chocolat/, 5], [/^noix\b/, 5],
  [/^amande/, 1.2], [/^sardine/, 25],
];

function defaultItem(food) {
  for (const [re, g] of PER_ITEM) if (re.test(food.norm)) return g;
  return null;
}

function defaultPortion(food) {
  const g = food.group, n = food.norm;
  const cooked = /\bcuit/.test(n);
  if (g.includes('pâtes, riz et céréales')) return cooked ? 200 : 80;
  if (g.includes('pommes de terre')) return 200;
  if (g.includes('|légumineuses')) return cooked ? 150 : 60;
  if (g.includes('|légumes')) return 150;
  if (g.includes('fruits à coque')) return 30;
  if (g.includes('|fruits')) return 150;
  if (g.startsWith('viandes, oeufs, poissons|viandes')) return 120;
  if (g.includes('poissons')) return 120;
  if (g.includes('charcuteries')) return 50;
  if (g.includes('fromages')) return 30;
  if (g.includes('produits laitiers frais')) return 125;
  if (g.includes('|laits')) return 200;
  if (g.startsWith('eaux et autres boissons')) return 200;
  if (g.includes('pains et assimilés')) return 50;
  if (g.includes('céréales de petit-déjeuner')) return 40;
  if (g.includes('biscuits')) return 25;
  if (g.includes('plats composés')) return 300;
  if (g.includes('|soupes')) return 250;
  if (g.includes('pizzas') || g.includes('sandwichs')) return 200;
  if (g.includes('salades composées')) return 250;
  if (g.includes('gâteaux')) return 80;
  if (g.startsWith('glaces')) return 60;
  if (g.includes('chocolats')) return 20;
  if (g.includes('viennoiseries')) return 60;
  if (g.includes('|sauces')) return 30;
  if (g.startsWith('matières grasses')) return 10;
  if (g.includes('confitures')) return 20;
  return null;
}

// Grammes pour une unité donnée : équivalence mémorisée, puis propre à l'aliment, puis par catégorie.
export function unitGrams(food, unit, equivs) {
  if (unit === 'g') return 1;
  const saved = equivs[food.id] && equivs[food.id][unit];
  if (saved) return saved;
  if (food.units && food.units[unit]) return food.units[unit];
  const base = food.custom && food.ref ? foods.get(food.ref) : food;
  if (!base) return null;
  if (unit === 'cas') return defaultTbsp(base);
  if (unit === 'cac') { const t = defaultTbsp(base); return t ? Math.round(t / 3 * 10) / 10 : null; }
  if (unit === 'unite') return defaultItem(base);
  if (unit === 'portion') return defaultPortion(base);
  return null;
}
