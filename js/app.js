import { db, uid } from './db.js';
import {
  NUTRIENTS, NUTRIENT_BY_ID, SECTIONS, HALF_LIFE_CATS, DEFAULT_SETTINGS, ACTIVITY_LEVELS, THEMES,
  references, REFERENCE_NOTES, NUTRIENT_TIPS,
} from './nutrients.js';
import {
  foods, loadCiqual, registerCustomFood, unregisterFood, search, shortName, UNITS, UNIT_BY_ID,
  unitGrams, fmtNum, displayValue, readValue,
} from './foods.js';
import {
  dateKey, parseKey, daysBetween, addDays, itemsIntake, computeGauges, STATUS_LABEL, topSources, mealSignature,
  weekStart, nextWeekStart,
} from './model.js';
import { startSync, syncNow, syncStatus, connectSync, disconnectSync } from './sync.js';

const MEAL_TYPES = [
  { id: 'petit-dejeuner', label: 'Petit-déjeuner' },
  { id: 'dejeuner', label: 'Déjeuner' },
  { id: 'gouter', label: 'Goûter' },
  { id: 'diner', label: 'Dîner' },
  { id: 'en-cas', label: 'En-cas' },
];
const MEAL_LABEL = Object.fromEntries(MEAL_TYPES.map(t => [t.id, t.label]));
const MEAL_ORDER = Object.fromEntries(MEAL_TYPES.map((t, i) => [t.id, i]));
const LABEL_FIELDS = ['energie', 'lipides', 'ags', 'glucides', 'sucres', 'fibres', 'proteines', 'sel'];
const BACKUP_FORMAT = 'mes-apports-sauvegarde';
const FOOD_FORMAT = 'mes-apports-aliment';

const state = {
  meals: [],
  customFoods: [],
  weekly: [],          // aliments à manger chaque semaine : { id, name, checkedAt, createdAt, updatedAt }
  equivs: {},
  profile: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  meta: {},
  draft: null,
  picked: null,        // { food, qty, unit, editIndex }
  usage: new Map(),
  lastUse: new Map(),
  historyDays: 14,
  sim: { items: [], days: 30, withHistory: false },
  simPicked: null,
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => dateKey(new Date());

// ---------------------------------------------------------------- Démarrage

async function init() {
  registerServiceWorker();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* facultatif */ }

  const [meals, customFoods, equivs, profile, settings, meta, draft, sim, weekly] = await Promise.all([
    db.all('meals'), db.all('foods'), db.get('equivs'), db.get('profile'), db.get('settings'), db.get('meta'), db.get('draft'), db.get('sim'),
    db.all('weekly'), loadCiqual(),
  ]);
  state.meals = meals || [];
  state.weekly = weekly || [];
  state.customFoods = customFoods || [];
  state.equivs = equivs || {};
  state.profile = profile || null;
  state.settings = mergeSettings(settings);
  applyTheme(state.settings.theme);
  state.meta = meta || {};
  state.customFoods.forEach(registerCustomFood);
  state.draft = draft || newDraft();
  if (sim) state.sim = { ...state.sim, ...sim };
  if (!state.meta.firstLaunch) { state.meta.firstLaunch = today(); saveMeta(); }

  bindEvents();
  renderAll();
  if (!state.profile) openProfileSheet(true);
  startSync({ onApplied: reloadFromDb, onStatus: onSyncStatus }).catch(err => console.error(err));
}

// Relit les données après l'arrivée de modifications synchronisées depuis un autre appareil.
async function reloadFromDb() {
  const [meals, customFoods, equivs, profile, settings, weekly] = await Promise.all([
    db.all('meals'), db.all('foods'), db.get('equivs'), db.get('profile'), db.get('settings'), db.all('weekly'),
  ]);
  state.weekly = weekly || [];
  const ids = new Set((customFoods || []).map(c => c.id));
  state.customFoods.filter(c => !ids.has(c.id)).forEach(c => unregisterFood(c.id));
  state.meals = meals || [];
  state.customFoods = customFoods || [];
  state.customFoods.forEach(registerCustomFood);
  state.equivs = equivs || {};
  if (profile) state.profile = profile;
  state.settings = mergeSettings(settings);
  renderAll();
}

function mergeSettings(s) {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!s) return d;
  return { ...d, ...s, halfLives: { ...d.halfLives, ...(s.halfLives || {}) } };
}

function newDraft() {
  return { id: null, date: today(), type: guessMealType(), items: [] };
}

function guessMealType(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 10.5) return 'petit-dejeuner';
  if (h < 15) return 'dejeuner';
  if (h < 18) return 'gouter';
  if (h < 22) return 'diner';
  return 'en-cas';
}

const saveDraft = () => db.set('draft', state.draft);
const saveMeta = () => db.set('meta', state.meta);

function refreshUsage() {
  state.usage = new Map();
  state.lastUse = new Map();
  const sorted = [...state.meals].sort((a, b) => (a.date + a.updatedAt).localeCompare(b.date + b.updatedAt));
  for (const m of sorted) for (const it of m.items) {
    state.usage.set(it.foodId, (state.usage.get(it.foodId) || 0) + 1);
    state.lastUse.set(it.foodId, { qty: it.qty, unit: it.unit });
  }
}

// ---------------------------------------------------------------- Rendu

function renderAll() {
  refreshUsage();
  renderHeader();
  renderWeekly();
  renderBanners();
  renderEntry();
  renderToday();
  renderHistory();
  renderGauges();
}

function renderHeader() {
  const d = new Date();
  $('#today-title').textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function refs() {
  return references(state.profile || { sex: 'H', age: 30, weight: 70, activity: 1.6 });
}

function renderSummary(gauges) {
  const r = refs();
  const todayItems = state.meals.filter(m => m.date === today()).flatMap(m => m.items);
  const t = itemsIntake(todayItems).totals;
  const cells = [
    ['energie', 'Énergie', 'kcal'], ['proteines', 'Protéines', 'g'], ['glucides', 'Glucides', 'g'], ['lipides', 'Lipides', 'g'],
  ];
  $('#summary').innerHTML = cells.map(([id, label, unit]) => {
    const v = t[id], ref = r[id];
    const pct = ref ? v / ref * 100 : 0;
    const over = id === 'energie' && pct > 110;
    return `<div class="sum-cell ${id === 'energie' ? 'energy' : ''}">
      <p class="sum-label">${label}</p>
      <p class="sum-value">${fmtNum(v, 0)}<small>${unit}</small></p>
      <p class="sum-of">sur ${fmtNum(ref, 0)}</p>
      <div class="mini-bar"><i class="${over ? 'over' : ''}" style="width:${Math.min(100, pct).toFixed(1)}%"></i></div>
    </div>`;
  }).join('');
}

function renderBanners() {
  const out = [];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !standalone && !state.meta.installHintDismissed) {
    out.push(`<div class="banner"><p><strong>Ajoutez l’app à l’écran d’accueil</strong> pour que Safari conserve vos données : touchez <em>Partager</em> puis <em>Sur l’écran d’accueil</em>.</p>
      <button type="button" class="link-btn" data-action="dismiss-install">Fermer</button></div>`);
  }
  const sync = syncStatus();
  if (sync.serious) {
    out.push(`<div class="banner"><p><strong>Synchronisation en pause.</strong> ${esc(sync.message)}</p>
      <button type="button" class="btn small" data-action="open-settings">Réglages</button></div>`);
  }
  const syncedRecently = sync.enabled && sync.lastSync && daysBetween(sync.lastSync.slice(0, 10), today()) < 7;
  if (state.meals.length && !syncedRecently) {
    const last = state.meta.lastExport;
    const days = last ? daysBetween(last.slice(0, 10), today()) : daysBetween(state.meta.firstLaunch || today(), today());
    const snoozed = state.meta.backupSnooze && state.meta.backupSnooze >= today();
    if (days >= 7 && !snoozed) {
      out.push(`<div class="banner"><p>${last ? `Dernière sauvegarde il y a ${days} jours.` : 'Vous n’avez encore jamais sauvegardé vos données.'} Exportez-les pour ne rien perdre.</p>
        <button type="button" class="btn small primary" data-action="export">Exporter</button>
        <button type="button" class="link-btn" data-action="snooze-backup">Plus tard</button></div>`);
    }
  }
  $('#banners').innerHTML = out.join('');
}

function renderEntry() {
  const d = state.draft;
  $('#entry-title').textContent = d.id ? 'Modifier le repas' : 'Ajouter un repas';
  $('#cancel-edit').classList.toggle('hidden', !d.id && !d.items.length);
  $('#cancel-edit').textContent = d.id ? 'Annuler' : 'Vider';
  $('#meal-date').value = d.date;
  $('#meal-date').max = today();
  $('#meal-type').innerHTML = MEAL_TYPES.map(t =>
    `<button type="button" role="radio" aria-checked="${t.id === d.type}" data-action="set-type" data-type="${t.id}">${t.label}</button>`).join('');
  renderFrequent();
  renderMyFoods('#my-foods', 'pick');
  renderDraftItems();
  renderQtyPanel();
}

// Rangée « Mes aliments » : les aliments personnalisés, les plus utilisés d'abord, à choisir d'un toucher.
function renderMyFoods(sel, action) {
  const box = $(sel);
  if (!box) return;
  const list = [...state.customFoods].sort((a, b) =>
    (state.usage.get(b.id) || 0) - (state.usage.get(a.id) || 0) || a.nom.localeCompare(b.nom, 'fr'));
  box.innerHTML = list.length ? `<p class="my-foods-label">Mes aliments</p>
    <div class="frequent">${list.map(cf => `<button type="button" class="chip" data-action="${action}" data-id="${esc(cf.id)}">
      ${cf.marque ? `<small>${esc(cf.marque)}</small>` : ''}<span>${esc(cf.nom)}</span></button>`).join('')}</div>` : '';
}

function renderFrequent() {
  const counts = new Map();
  const sorted = [...state.meals].sort((a, b) => (b.date + b.updatedAt).localeCompare(a.date + a.updatedAt));
  for (const m of sorted) {
    const sig = mealSignature(m);
    if (!sig) continue;
    const c = counts.get(sig);
    if (c) c.n++; else counts.set(sig, { n: 1, meal: m });
  }
  const top = [...counts.values()].filter(c => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 6);
  $('#frequent').innerHTML = top.map(c =>
    `<button type="button" class="chip" data-action="redo" data-id="${c.meal.id}" title="Refaire ce repas">
      <small>Repas habituel · ${c.n} fois</small>
      <span>${esc(c.meal.items.map(i => shortName(foods.get(i.foodId)).split(',')[0]).join(', '))}</span>
    </button>`).join('');
}

function itemLabel(it) {
  if (it.unit === 'g') return `${fmtNum(it.grams, 0)} g`;
  const u = UNIT_BY_ID[it.unit];
  const n = fmtNum(it.qty, 2);
  const plural = it.qty > 1 && it.unit !== 'cas' && it.unit !== 'cac' ? 's' : '';
  return `${n} ${u.label}${plural} · ${fmtNum(it.grams, 0)} g`;
}

function renderDraftItems() {
  const d = state.draft;
  $('#draft-items').innerHTML = d.items.map((it, i) => {
    const food = foods.get(it.foodId);
    return `<li>
      <button type="button" class="di-main" data-action="edit-item" data-index="${i}" aria-label="Modifier la quantité">
        <span class="di-name">${esc(shortName(food))}</span>
        <span class="di-qty">${itemLabel(it)}</span>
      </button>
      <button type="button" class="remove-btn" data-action="remove-item" data-index="${i}" aria-label="Retirer">×</button>
    </li>`;
  }).join('');
  const kcal = itemsIntake(d.items).totals.energie;
  $('#draft-total').textContent = d.items.length ? `${d.items.length} aliment${d.items.length > 1 ? 's' : ''} · ${fmtNum(kcal, 0)} kcal` : 'Cherchez un aliment pour commencer.';
  $('#save-meal').disabled = !d.items.length;
  $('#save-meal').hidden = !d.items.length;
  $('#save-meal').textContent = d.id ? 'Enregistrer les modifications' : 'Enregistrer le repas';
}

function renderQtyPanel() {
  const p = state.picked;
  const el = $('#qty-panel');
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const food = p.food;
  const per = unitGrams(food, p.unit, state.equivs);
  const needEquiv = p.unit !== 'g' && (!per || p.editEquiv);
  const grams = per ? p.qty * per : null;
  const ulong = UNIT_BY_ID[p.unit].long;
  el.innerHTML = `
    <p class="qty-name">${esc(food.name)}${food.custom ? '<small>Aliment personnalisé</small>' : ''}</p>
    <div class="qty-row">
      <label class="sr-only" for="qty-input">Quantité</label>
      <input id="qty-input" type="number" inputmode="decimal" min="0" step="any" value="${p.qty}">
      <label class="sr-only" for="unit-select">Unité</label>
      <select id="unit-select">${UNITS.map(u => `<option value="${u.id}" ${u.id === p.unit ? 'selected' : ''}>${u.long}</option>`).join('')}</select>
      ${p.unit !== 'g' && per && !p.editEquiv ? `<button type="button" class="qty-grams" data-action="edit-equiv" title="Modifier l’équivalence">≈ ${fmtNum(grams, 0)} g</button>` : ''}
    </div>
    ${needEquiv ? `<div class="qty-equiv">
      <label for="equiv-input">Poids d’une ${ulong} de cet aliment :</label>
      <input id="equiv-input" type="number" inputmode="decimal" min="0" step="any" value="${per || ''}" placeholder="g"> g
      <span class="muted">mémorisé pour la suite</span>
    </div>` : ''}
    <div class="qty-actions">
      <button type="button" class="btn" data-action="cancel-pick">Annuler</button>
      <button type="button" class="btn primary" data-action="add-item">${p.editIndex !== undefined ? 'Mettre à jour' : 'Ajouter'}</button>
    </div>`;
}

function mealCard(m, { showDate = false } = {}) {
  const kcal = itemsIntake(m.items).totals.energie;
  const names = m.items.map(i => `${esc(shortName(foods.get(i.foodId)))} <span>${fmtNum(i.grams, 0)} g</span>`).join(', ');
  return `<div class="meal">
    <div class="meal-head">
      <span class="meal-type">${MEAL_LABEL[m.type] || m.type}${showDate ? ` <span class="muted">· ${formatDay(m.date)}</span>` : ''}</span>
      <span class="meal-kcal">${fmtNum(kcal, 0)} kcal</span>
    </div>
    <p class="meal-items">${names}</p>
    <div class="meal-actions">
      <button type="button" class="btn small" data-action="redo" data-id="${m.id}">Refaire ce repas</button>
      <button type="button" class="btn small" data-action="edit-meal" data-id="${m.id}">Modifier</button>
      <button type="button" class="btn small danger" data-action="delete-meal" data-id="${m.id}">Supprimer</button>
    </div>
  </div>`;
}

const sortMeals = list => [...list].sort((a, b) => (MEAL_ORDER[a.type] - MEAL_ORDER[b.type]) || a.createdAt.localeCompare(b.createdAt));

function renderToday() {
  const list = sortMeals(state.meals.filter(m => m.date === today()));
  $('#today-meals').innerHTML = list.length
    ? `<div class="meal-list">${list.map(m => mealCard(m)).join('')}</div>`
    : `<p class="empty-state">Aucun repas enregistré aujourd’hui.</p>`;
}

function formatDay(k) {
  const diff = daysBetween(k, today());
  if (diff === 0) return 'aujourd’hui';
  if (diff === 1) return 'hier';
  return parseKey(k).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderHistory() {
  const past = state.meals.filter(m => m.date < today());
  if (!past.length) {
    $('#history-list').innerHTML = `<p class="empty-state">Vos repas des jours précédents apparaîtront ici, prêts à être refaits.</p>`;
    return;
  }
  const dates = [...new Set(past.map(m => m.date))].sort().reverse();
  const shown = dates.slice(0, state.historyDays);
  $('#history-list').innerHTML = shown.map(k => {
    const ms = sortMeals(past.filter(m => m.date === k));
    const kcal = itemsIntake(ms.flatMap(m => m.items)).totals.energie;
    const label = formatDay(k);
    return `<p class="day-title">${label.charAt(0).toUpperCase() + label.slice(1)} <span>· ${fmtNum(kcal, 0)} kcal</span></p>
      <div class="meal-list">${ms.map(m => mealCard(m)).join('')}</div>`;
  }).join('') + (dates.length > shown.length ? `<button type="button" class="btn more" data-action="more-history">Afficher plus de jours</button>` : '');
}

function renderGauges() {
  const r = refs();
  const g = computeGauges(state.meals, r, state.settings, today());
  state.lastGauges = g;
  renderSummary(g);
  $('#gauge-list').innerHTML = SECTIONS.map(sec => {
    const rows = NUTRIENTS.filter(n => n.section === sec.id).map(n => gaugeRow(n, g[n.id])).join('');
    return `<div class="gauge-group"><h3>${sec.label}${sec.id === 'limites' ? ' <span>en % de la limite maximale</span>' : ''}</h3><div class="gauges">${rows}</div></div>`;
  }).join('');
}

const PARTIAL_ICON = `<svg class="partial" viewBox="0 0 16 16" width="13" height="13" aria-label="Données incomplètes"><title>Données incomplètes : valeur sans doute sous-estimée</title><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2.2"/></svg>`;

function gaugeRow(n, d, interactive = true) {
  const scale = 150;
  const width = Math.min(d.pct, scale) / scale * 100;
  const partial = d.missingShare > 0.25;
  const statusText = STATUS_LABEL[d.status];
  const inner = `<span class="g-name">${n.label}${partial ? PARTIAL_ICON : ''}</span>
    <span class="bar"><span class="fill" style="width:${width.toFixed(1)}%"></span><span class="tick" style="left:${(100 / scale * 100).toFixed(2)}%"></span></span>
    <span class="g-pct ${d.status}">${Math.round(d.pct)} %</span>`;
  if (!interactive) return `<div class="gauge static ${d.status}" role="img" aria-label="${n.label} : ${Math.round(d.pct)} %, ${statusText}">${inner}</div>`;
  return `<button type="button" class="gauge ${d.status}" data-action="nutrient" data-id="${n.id}" aria-label="${n.label} : ${Math.round(d.pct)} %, ${statusText}">${inner}</button>`;
}

// ---------------------------------------------------------------- Recherche

let searchResults = [], searchIndex = -1;

const SEARCH_BOX = { main: '#search-results', ref: '#ref-results', sim: '#sim-results' };
const PICK_ACTION = { main: 'pick', ref: 'pick-ref', sim: 'pick-sim' };

function runSearch(q, target = 'main') {
  const box = $(SEARCH_BOX[target]);
  if (!q.trim()) { box.hidden = true; box.innerHTML = ''; searchResults = []; return; }
  searchResults = search(q, state.usage, target === 'ref' ? 8 : 12).filter(f => target !== 'ref' || !f.custom);
  searchIndex = searchResults.length ? 0 : -1;
  box.hidden = false;
  box.innerHTML = searchResults.length ? searchResults.map((f, i) => {
    const grp = f.group.split('|')[1] || f.group.split('|')[0] || '';
    return `<button type="button" class="result" role="option" aria-selected="${i === searchIndex}" data-action="${PICK_ACTION[target]}" data-id="${esc(f.id)}">
      ${esc(f.name)}${f.custom ? '<span class="tag">perso</span>' : ''}<small>${esc(grp)}</small></button>`;
  }).join('') : `<div class="empty">Aucun aliment trouvé.${target === 'main' ? ' <button type="button" class="link-btn" data-action="new-food">Créer un aliment personnalisé</button>' : ''}</div>`;
}

function moveSelection(delta, target) {
  const box = $(SEARCH_BOX[target]);
  if (!searchResults.length) return;
  searchIndex = (searchIndex + delta + searchResults.length) % searchResults.length;
  box.querySelectorAll('.result').forEach((b, i) => b.setAttribute('aria-selected', i === searchIndex));
  box.querySelectorAll('.result')[searchIndex].scrollIntoView({ block: 'nearest' });
}

function pickFood(id, editIndex) {
  const food = foods.get(id);
  if (!food) return;
  let qty = 100, unit = 'g';
  if (editIndex !== undefined) {
    const it = state.draft.items[editIndex];
    qty = it.qty; unit = it.unit;
  } else if (state.lastUse.has(id)) {
    ({ qty, unit } = state.lastUse.get(id));
  }
  state.picked = { food, qty, unit, editIndex };
  $('#food-search').value = '';
  runSearch('');
  renderQtyPanel();
  const input = $('#qty-input');
  input.focus();
  input.select();
}

function readPicked() {
  const p = state.picked;
  const qty = parseFloat(($('#qty-input').value || '').replace(',', '.'));
  const eq = $('#equiv-input');
  if (eq) {
    const v = parseFloat((eq.value || '').replace(',', '.'));
    if (v > 0) {
      state.equivs[p.food.id] = { ...(state.equivs[p.food.id] || {}), [p.unit]: v };
      db.set('equivs', state.equivs);
      p.editEquiv = false;
    }
  }
  p.qty = isFinite(qty) ? qty : p.qty;
}

function addPicked() {
  const p = state.picked;
  readPicked();
  const per = unitGrams(p.food, p.unit, state.equivs);
  if (!(p.qty > 0)) { toast('Indiquez une quantité.'); $('#qty-input').focus(); return; }
  if (!per) { toast(`Indiquez le poids d’une ${UNIT_BY_ID[p.unit].long}.`); renderQtyPanel(); $('#equiv-input')?.focus(); return; }
  const item = { foodId: p.food.id, qty: p.qty, unit: p.unit, grams: Math.round(p.qty * per * 10) / 10 };
  if (p.editIndex !== undefined) state.draft.items[p.editIndex] = item;
  else state.draft.items.push(item);
  state.picked = null;
  saveDraft();
  renderEntry();
  $('#food-search').focus({ preventScroll: true });
}

// ---------------------------------------------------------------- Aliments de la semaine

// Coché = mangé depuis le dernier lundi 1 h : rien à effacer, la remise à zéro est automatique.
const isEaten = it => !!it.checkedAt && new Date(it.checkedAt) >= weekStart();

function renderWeekly() {
  const list = [...state.weekly].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const eaten = list.filter(isEaten).length;
  $('#weekly-count').textContent = list.length ? `${eaten}/${list.length} mangé${eaten > 1 ? 's' : ''}` : '';
  $('#weekly-list').innerHTML = list.map(it => {
    const done = isEaten(it);
    return `<li class="${done ? 'eaten' : ''}">
      <label><input type="checkbox" data-id="${esc(it.id)}" ${done ? 'checked' : ''}><span>${esc(it.name)}</span></label>
      <button type="button" class="remove-btn" data-action="weekly-remove" data-id="${esc(it.id)}" aria-label="Retirer ${esc(it.name)} de la liste">×</button>
    </li>`;
  }).join('');
  scheduleWeeklyReset();
}

// Rafraîchit l'affichage au moment de la remise à zéro si l'app est ouverte.
let weeklyTimer;
function scheduleWeeklyReset() {
  clearTimeout(weeklyTimer);
  weeklyTimer = setTimeout(renderWeekly, nextWeekStart() - Date.now() + 1000);
}

async function addWeekly(form) {
  const name = form.name.value.trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (state.weekly.some(it => it.name.toLocaleLowerCase('fr') === name.toLocaleLowerCase('fr'))) {
    toast(`« ${name} » est déjà dans la liste`);
    return;
  }
  const now = new Date().toISOString();
  const item = { id: uid(), name, checkedAt: null, createdAt: now, updatedAt: now };
  await db.put('weekly', item);
  state.weekly.push(item);
  form.name.value = '';
  renderWeekly();
}

async function toggleWeekly(id, checked) {
  const it = state.weekly.find(x => x.id === id);
  if (!it) return;
  const now = new Date().toISOString();
  const next = { ...it, checkedAt: checked ? now : null, updatedAt: now };
  await db.put('weekly', next);
  state.weekly = state.weekly.map(x => (x.id === id ? next : x));
  renderWeekly();
}

async function removeWeekly(id) {
  const it = state.weekly.find(x => x.id === id);
  if (!it) return;
  await db.del('weekly', id);
  state.weekly = state.weekly.filter(x => x.id !== id);
  renderWeekly();
  toast(`« ${it.name} » retiré de la liste`);
}

// ---------------------------------------------------------------- Repas

async function saveMeal() {
  const d = state.draft;
  if (!d.items.length) return;
  const now = new Date().toISOString();
  const existing = d.id && state.meals.find(m => m.id === d.id);
  const meal = {
    id: d.id || uid(), date: d.date || today(), type: d.type, items: d.items,
    createdAt: existing ? existing.createdAt : now, updatedAt: now,
  };
  await db.put('meals', meal);
  state.meals = state.meals.filter(m => m.id !== meal.id).concat(meal);
  state.draft = newDraft();
  state.picked = null;
  saveDraft();
  renderAll();
  toast(existing ? 'Repas modifié' : 'Repas enregistré');
}

function loadMealIntoDraft(id, asCopy) {
  const m = state.meals.find(x => x.id === id);
  if (!m) return;
  state.draft = {
    id: asCopy ? null : m.id,
    date: asCopy ? today() : m.date,
    type: asCopy ? (m.type) : m.type,
    items: structuredClone(m.items),
  };
  state.picked = null;
  saveDraft();
  renderEntry();
  $('#entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(asCopy ? 'Repas copié : ajustez si besoin, puis enregistrez' : 'Modifiez le repas, puis enregistrez');
}

const pendingDelete = new Map();
async function deleteMeal(btn, id) {
  if (!pendingDelete.has(id)) {
    btn.textContent = 'Confirmer la suppression';
    pendingDelete.set(id, setTimeout(() => { pendingDelete.delete(id); btn.textContent = 'Supprimer'; }, 4000));
    return;
  }
  clearTimeout(pendingDelete.get(id));
  pendingDelete.delete(id);
  await db.del('meals', id);
  state.meals = state.meals.filter(m => m.id !== id);
  if (state.draft.id === id) { state.draft = newDraft(); saveDraft(); }
  renderAll();
  toast('Repas supprimé');
}

// ---------------------------------------------------------------- Feuilles

const sheet = () => $('#sheet');

function openSheet(html, { locked = false } = {}) {
  const s = sheet();
  s.innerHTML = `<div class="sheet-inner">${html}</div>`;
  s.dataset.locked = locked ? '1' : '';
  if (!s.open) s.showModal();
  s.scrollTop = 0;
}

function closeSheet() {
  const s = sheet();
  if (s.open) s.close();
}

function profileFields(p) {
  p = p || {};
  return `<div class="form-group">
    <div class="field"><span>Sexe</span>
      <div class="radio-row">
        <label><input type="radio" name="sex" value="H" ${p.sex === 'H' ? 'checked' : ''}><span>Homme</span></label>
        <label><input type="radio" name="sex" value="F" ${p.sex === 'F' ? 'checked' : ''}><span>Femme</span></label>
      </div></div>
    <div class="field"><span>Âge</span><input name="age" type="number" inputmode="numeric" min="18" max="110" value="${p.age ?? ''}" placeholder="ans"></div>
    <div class="field"><span>Poids</span><input name="weight" type="number" inputmode="decimal" min="30" max="300" step="any" value="${p.weight ?? ''}" placeholder="kg"></div>
    <div class="field"><span>Activité</span>
      <select name="activity">${ACTIVITY_LEVELS.map(a => `<option value="${a.id}" ${Number(p.activity) === a.id ? 'selected' : ''}>${a.label}</option>`).join('')}</select></div>
  </div>
  <p class="note">${ACTIVITY_LEVELS.map(a => `<strong>${a.label}</strong> : ${a.hint}`).join(' · ')}.</p>`;
}

function readProfile(root) {
  const sex = root.querySelector('input[name="sex"]:checked')?.value;
  const age = parseInt(root.querySelector('[name="age"]').value, 10);
  const weight = parseFloat(root.querySelector('[name="weight"]').value.replace(',', '.'));
  const activity = parseFloat(root.querySelector('[name="activity"]').value);
  if (!sex || !(age >= 18 && age <= 110) || !(weight >= 30 && weight <= 300)) return null;
  return { sex, age, weight, activity };
}

function openProfileSheet(first) {
  openSheet(`
    <div class="sheet-head"><h2>${first ? 'Bienvenue' : 'Profil'}</h2></div>
    ${first ? `<p>Vos besoins en vitamines, minéraux et énergie dépendent de votre profil. Les références sont celles de l’ANSES pour les adultes.</p>
    <p class="note">Au départ, toutes les jauges sont à zéro : elles se rempliront au fil des repas que vous enregistrez.</p>` : ''}
    <form id="profile-form">${profileFields(state.profile)}
      <div class="sheet-actions"><button class="btn primary" type="submit">${first ? 'Commencer' : 'Enregistrer'}</button></div>
    </form>`, { locked: first });
}

function openSettings() {
  const s = state.settings;
  const p = state.profile;
  openSheet(`
    <div class="sheet-head"><h2>Réglages</h2><button type="button" class="link-btn" data-action="close-sheet">Fermer</button></div>

    <h3>Apparence</h3>
    <div class="form-group">
      <div class="field stack"><span>Thème</span>
        <div class="radio-row" id="theme-choice">${THEMES.map(t => `<label><input type="radio" name="theme" value="${t.id}" ${s.theme === t.id ? 'checked' : ''}><span>${t.label}</span></label>`).join('')}</div>
      </div>
    </div>
    <p class="note">Automatique suit le mode clair ou sombre de l’appareil.</p>

    <h3>Profil</h3>
    <form id="settings-profile">${profileFields(p)}</form>

    <h3>Calcul des jauges</h3>
    <form id="settings-calc" class="form-group">
      <div class="field"><span>Plafond journalier<small>Au-delà, l’excès d’un jour ne compense pas les autres</small></span>
        <input name="cap" type="number" inputmode="numeric" min="100" max="1000" step="10" value="${s.cap}" aria-label="Plafond en %"></div>
      ${HALF_LIFE_CATS.map(c => `<div class="field"><span>Demi-vie<small>${c.label}</small></span>
        <input name="hl-${c.id}" type="number" inputmode="decimal" min="0.5" max="60" step="0.5" value="${s.halfLives[c.id]}" aria-label="Demi-vie en jours"></div>`).join('')}
    </form>
    <p class="note">Plafond en % des apports recommandés, demi-vies en jours. Un apport d’il y a une demi-vie compte deux fois moins qu’aujourd’hui. <button type="button" class="link-btn" data-action="reset-calc">Rétablir les valeurs par défaut</button></p>

    <h3>Aliments personnalisés</h3>
    ${state.customFoods.length ? `<ul class="custom-list">${state.customFoods.map(cf => `<li><span>${esc(foods.get(cf.id)?.name || cf.nom)}</span>
      <span class="cl-actions"><button type="button" class="btn small" data-action="edit-food" data-id="${esc(cf.id)}">Modifier</button>
      <button type="button" class="btn small danger" data-action="delete-food" data-id="${esc(cf.id)}">Supprimer</button></span></li>`).join('')}</ul>` : '<p class="note">Aucun pour l’instant.</p>'}
    <div class="sheet-actions" style="justify-content:flex-start">
      <button type="button" class="btn" data-action="new-food">Créer un aliment</button>
      <button type="button" class="btn" data-action="import-food">Importer un aliment</button>
    </div>

    <h3>Synchronisation</h3>
    <div id="sync-section">${syncSectionHtml()}</div>

    <h3>Données</h3>
    <p class="note" id="data-note">${dataNoteText()}</p>
    <div class="stack-actions">
      <button type="button" class="btn primary" data-action="export">Exporter une sauvegarde</button>
      <label class="btn" style="text-align:center">Importer une sauvegarde<input type="file" accept="application/json,.json" id="backup-file" hidden></label>
      <button type="button" class="btn danger" data-action="wipe">Effacer toutes les données</button>
    </div>`);
}

function dataNoteText() {
  const lastExport = state.meta.lastExport ? new Date(state.meta.lastExport).toLocaleDateString('fr-FR') : 'jamais';
  return syncStatus().enabled
    ? `Vos données sont aussi synchronisées, chiffrées, avec GitHub. Une sauvegarde exportée reste utile comme copie de secours. Dernière sauvegarde : ${lastExport}.`
    : `Vos données restent sur cet appareil. Dernière sauvegarde : ${lastExport}. Pour passer du Mac à l’iPhone, exportez sur l’un puis importez sur l’autre : les repas sont fusionnés.`;
}

// ----- Synchronisation

function syncStateLabel(st) {
  const when = st.lastSync ? new Date(st.lastSync) : null;
  const at = when && (dateKey(when) === today()
    ? `aujourd’hui à ${when.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : `le ${when.toLocaleDateString('fr-FR')}`);
  switch (st.state) {
    case 'syncing': return 'Synchronisation…';
    case 'ok': return `À jour, ${at}`;
    case 'offline': return `Hors connexion${at ? ` · dernière synchro ${at}` : ''}`;
    case 'error': return st.message;
    default: return at ? `Dernière synchro ${at}` : 'En attente';
  }
}

function syncSectionHtml() {
  const st = syncStatus();
  if (st.enabled) {
    return `<div class="form-group">
      <div class="field"><span>Dépôt</span><span class="muted">${esc(st.repo)}</span></div>
      <div class="field"><span>État</span><span class="sync-state${st.state === 'error' ? ' is-error' : ''}">${esc(syncStateLabel(st))}</span></div>
    </div>
    <p class="note">La synchronisation se fait à l’ouverture de l’app, quelques secondes après chaque modification et quand vous la quittez.</p>
    <div class="sheet-actions" style="justify-content:flex-start">
      <button type="button" class="btn" data-action="sync-now">Synchroniser maintenant</button>
      <button type="button" class="btn danger" data-action="sync-disconnect">Déconnecter cet appareil</button>
    </div>`;
  }
  return `<p class="note">Retrouvez vos repas, aliments et réglages sur tous vos appareils grâce à un dépôt GitHub privé. Tout est chiffré sur l’appareil avec votre phrase secrète avant l’envoi : GitHub ne voit que des données illisibles.</p>
    <form id="sync-form" autocomplete="off">
      <div class="form-group">
        <div class="field stack"><span>Dépôt GitHub privé</span>
          <input name="repo" placeholder="utilisateur/health-app-donnees" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field stack"><span>Clé d’accès GitHub<small>Elle commence par github_pat_</small></span>
          <input name="token" type="password" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field stack"><span>Phrase secrète<small>10 caractères minimum, la même sur tous vos appareils</small></span>
          <input name="pass" type="password" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="field stack"><span>Confirmer la phrase secrète</span>
          <input name="pass2" type="password" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      </div>
      <p class="note">Notez votre phrase secrète en lieu sûr : sans elle, la copie en ligne est illisible, même pour vous. Si vous l’oubliez, déconnectez vos appareils et recommencez avec un nouveau dépôt : vos données locales restent intactes.</p>
      <div class="sheet-actions"><button class="btn primary" type="submit">Activer la synchronisation</button></div>
    </form>`;
}

function onSyncStatus() {
  renderBanners();
  const box = $('#sync-section');
  // Ne pas effacer le formulaire en cours de saisie.
  if (box && !box.querySelector('#sync-form')) box.innerHTML = syncSectionHtml();
  const note = $('#data-note');
  if (note) note.textContent = dataNoteText();
}

async function submitSyncForm(form) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Connexion…';
  try {
    const st = await connectSync({
      repo: form.repo.value, token: form.token.value, passphrase: form.pass.value, confirm: form.pass2.value,
    });
    $('#sync-section').innerHTML = syncSectionHtml();
    onSyncStatus();
    toast(st.state === 'ok' ? 'Synchronisation activée' : `Synchronisation activée, mais : ${syncStateLabel(st)}`, 5000);
  } catch (err) {
    if (!err.code) console.error(err);
    toast(err.message || 'Connexion impossible.', 7000);
    btn.disabled = false;
    btn.textContent = 'Activer la synchronisation';
  }
}

async function disconnectFromSync(btn) {
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Confirmer la déconnexion'; return; }
  await disconnectSync();
  onSyncStatus();
  toast('Appareil déconnecté : ses données restent intactes');
}

async function onSettingsInput(e) {
  const pf = e.target.closest('#settings-profile');
  if (pf) {
    const p = readProfile(pf);
    if (p) { state.profile = p; await db.set('profile', p); renderAll(); }
    return;
  }
  const cf = e.target.closest('#settings-calc');
  if (cf) {
    const cap = parseFloat(cf.querySelector('[name="cap"]').value);
    if (cap >= 100) state.settings.cap = cap;
    for (const c of HALF_LIFE_CATS) {
      const v = parseFloat(cf.querySelector(`[name="hl-${c.id}"]`).value.replace(',', '.'));
      if (v >= 0.5) state.settings.halfLives[c.id] = v;
    }
    await db.set('settings', state.settings);
    renderGauges();
  }
}

function openNutrient(id) {
  const n = NUTRIENT_BY_ID[id];
  const d = state.lastGauges[id];
  const hl = state.settings.halfLives[n.cat];
  const sources = topSources(state.meals, id, today());
  const unit = n.unit;
  const capped = n.kind === 'min' && Math.abs(d.rawAvg - d.avg) > d.ref * 0.01;
  openSheet(`
    <div class="sheet-head"><h2>${n.label}</h2><button type="button" class="link-btn" data-action="close-sheet">Fermer</button></div>
    <dl class="detail-grid">
      <div><dt>État</dt><dd class="g-pct ${d.status}">${STATUS_LABEL[d.status]} · ${Math.round(d.pct)} %</dd></div>
      <div><dt>Aujourd’hui</dt><dd>${fmtNum(d.today)} ${unit}</dd></div>
      <div><dt>Moyenne pondérée</dt><dd>${fmtNum(d.avg)} ${unit} / jour</dd></div>
      ${capped ? `<div><dt>Sans plafond</dt><dd>${fmtNum(d.rawAvg)} ${unit} / jour</dd></div>` : ''}
      <div><dt>${n.kind === 'max' ? 'Limite' : n.kind === 'energy' ? 'Besoin estimé' : 'Référence'}</dt><dd>${fmtNum(d.ref)} ${unit} / jour</dd></div>
      <div><dt>Demi-vie</dt><dd>${fmtNum(hl)} jour${hl > 1 ? 's' : ''}</dd></div>
      ${d.missingShare > 0 ? `<div><dt>Sans donnée</dt><dd>${Math.round(d.missingShare * 100)} % des quantités</dd></div>` : ''}
    </dl>
    ${REFERENCE_NOTES[id] ? `<p class="note">${REFERENCE_NOTES[id]}</p>` : ''}
    ${d.missingShare > 0.25 ? `<p class="note">Une partie des aliments consommés n’a pas de valeur connue pour ce nutriment dans Ciqual. Elle est comptée comme zéro : la jauge est probablement sous-estimée.</p>` : ''}
    ${tipsHtml(id, d.ref)}
    <h3>Principales sources sur 14 jours</h3>
    ${sources.length ? `<dl class="detail-grid">${sources.map(s => `<div><dt>${esc(shortName(s.food))}</dt><dd>${Math.round(s.share * 100)} %</dd></div>`).join('')}</dl>`
      : '<p class="note">Aucun apport enregistré sur cette période.</p>'}
  `);
}

// Aliments conseillés pour un nutriment, avec l'apport calculé depuis Ciqual.
function tipsHtml(id, ref) {
  const groups = NUTRIENT_TIPS[id];
  if (!groups) return '';
  const unit = NUTRIENT_BY_ID[id].unit;
  return groups.map(g => `
    <h3>${esc(g.title)}</h3>
    <ul class="tips">${g.foods.map(t => {
      const food = foods.get('c:' + t.code);
      if (!food) return '';
      const amount = readValue(food.values[id], id).v * t.grams / 100;
      return `<li>
        <div class="tip-main">
          <strong>${esc(t.label)}</strong>
          <span>${esc(t.freq)}</span>
          <small>${fmtNum(t.grams, 0)} g ≈ ${fmtNum(amount, 0)} ${unit}, soit ${Math.round(amount / ref * 100)} % de la référence du jour</small>
        </div>
        <button type="button" class="btn small" data-action="add-tip" data-id="${esc(food.id)}" data-grams="${t.grams}">Ajouter</button>
      </li>`;
    }).join('')}</ul>
    ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}`).join('');
}

function addTipToDraft(foodId, grams) {
  state.draft.items.push({ foodId, qty: grams, unit: 'g', grams });
  saveDraft();
  closeSheet();
  renderEntry();
  $('#entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Ajouté au repas en cours : ajustez si besoin, puis enregistrez');
}

// ----- Simulation d'une journée type

const SIM_DAYS = [7, 14, 30, 60];
const saveSim = () => db.set('sim', { items: state.sim.items, days: state.sim.days, withHistory: state.sim.withHistory });

function openSimulation() {
  const dates = [...new Set(state.meals.map(m => m.date))].sort().reverse().slice(0, 30);
  openSheet(`
    <div class="sheet-head"><h2>Simulation</h2><button type="button" class="link-btn" data-action="close-sheet">Fermer</button></div>
    <p>Composez une journée type : l’app calcule les jauges comme si vous la mangiez tous les jours.</p>
    <div class="block-head sim-head"><h3>Journée type</h3>
      <button type="button" class="link-btn" data-action="sim-clear">Vider</button></div>
    <div class="panel">
      ${dates.length ? `<label class="sr-only" for="sim-copy-day">Copier un jour enregistré</label>
      <select id="sim-copy-day" class="sim-copy">
        <option value="">Copier un jour enregistré…</option>
        ${dates.map(k => `<option value="${k}">${esc(formatDay(k).charAt(0).toUpperCase() + formatDay(k).slice(1))}</option>`).join('')}
      </select>` : ''}
      <div class="search">
        <label for="sim-search" class="sr-only">Ajouter un aliment à la journée type</label>
        <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <input id="sim-search" type="search" placeholder="Ajouter un aliment" autocomplete="off" autocorrect="off" spellcheck="false">
        <div id="sim-results" class="results" role="listbox" hidden></div>
      </div>
      <div id="sim-my-foods" class="my-foods"></div>
      <div id="sim-qty" class="qty-panel" hidden></div>
      <ul id="sim-items" class="draft-items"></ul>
      <p id="sim-total" class="sim-total muted"></p>
    </div>
    <h3>Durée</h3>
    <div class="segmented" id="sim-days" role="radiogroup" aria-label="Durée de la simulation"></div>
    <label class="check"><input type="checkbox" id="sim-history" ${state.sim.withHistory ? 'checked' : ''}>
      <span>Partir de mon historique réel<small>Sinon, la simulation part de zéro comme au premier lancement.</small></span></label>
    <div id="sim-result"></div>`);
  renderSimAll();
}

function renderSimAll() {
  if (!$('#sim-items')) return;
  renderMyFoods('#sim-my-foods', 'pick-sim');
  $('#sim-days').innerHTML = SIM_DAYS.map(n =>
    `<button type="button" role="radio" aria-checked="${state.sim.days === n}" data-action="sim-days" data-days="${n}">${n} jours</button>`).join('');
  $('#sim-items').innerHTML = state.sim.items.map((it, i) => `<li>
      <button type="button" class="di-main" data-action="sim-edit-item" data-index="${i}" aria-label="Modifier la quantité">
        <span class="di-name">${esc(shortName(foods.get(it.foodId)))}</span>
        <span class="di-qty">${itemLabel(it)}</span>
      </button>
      <button type="button" class="remove-btn" data-action="sim-remove" data-index="${i}" aria-label="Retirer">×</button>
    </li>`).join('');
  const kcal = itemsIntake(state.sim.items).totals.energie;
  $('#sim-total').textContent = state.sim.items.length
    ? `${state.sim.items.length} aliment${state.sim.items.length > 1 ? 's' : ''} · ${fmtNum(kcal, 0)} kcal par jour`
    : 'Ajoutez les aliments d’une journée complète, ou copiez un jour déjà enregistré.';
  renderSimQty();
  renderSimResult();
}

function simPick(id, editIndex) {
  const food = foods.get(id);
  if (!food) return;
  let qty = 100, unit = 'g';
  if (editIndex !== undefined) ({ qty, unit } = state.sim.items[editIndex]);
  else if (state.lastUse.has(id)) ({ qty, unit } = state.lastUse.get(id));
  state.simPicked = { food, qty, unit, editIndex };
  $('#sim-search').value = '';
  runSearch('', 'sim');
  renderSimQty();
  $('#sim-qty-input').focus();
  $('#sim-qty-input').select();
}

function renderSimQty() {
  const el = $('#sim-qty');
  if (!el) return;
  const p = state.simPicked;
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const per = unitGrams(p.food, p.unit, state.equivs);
  const needEquiv = p.unit !== 'g' && (!per || p.editEquiv);
  el.innerHTML = `
    <p class="qty-name">${esc(p.food.name)}</p>
    <div class="qty-row">
      <label class="sr-only" for="sim-qty-input">Quantité</label>
      <input id="sim-qty-input" type="number" inputmode="decimal" min="0" step="any" value="${p.qty}">
      <label class="sr-only" for="sim-unit-select">Unité</label>
      <select id="sim-unit-select">${UNITS.map(u => `<option value="${u.id}" ${u.id === p.unit ? 'selected' : ''}>${u.long}</option>`).join('')}</select>
      ${p.unit !== 'g' && per && !p.editEquiv ? `<button type="button" class="qty-grams" data-action="sim-edit-equiv">≈ ${fmtNum(p.qty * per, 0)} g</button>` : ''}
    </div>
    ${needEquiv ? `<div class="qty-equiv">
      <label for="sim-equiv-input">Poids d’une ${UNIT_BY_ID[p.unit].long} de cet aliment :</label>
      <input id="sim-equiv-input" type="number" inputmode="decimal" min="0" step="any" value="${per || ''}" placeholder="g"> g
    </div>` : ''}
    <div class="qty-actions">
      <button type="button" class="btn" data-action="sim-cancel-pick">Annuler</button>
      <button type="button" class="btn primary" data-action="sim-add">${p.editIndex !== undefined ? 'Mettre à jour' : 'Ajouter'}</button>
    </div>`;
}

function simReadPicked() {
  const p = state.simPicked;
  const q = parseFloat(($('#sim-qty-input')?.value || '').replace(',', '.'));
  if (isFinite(q)) p.qty = q;
  const eq = $('#sim-equiv-input');
  if (eq) {
    const v = parseFloat((eq.value || '').replace(',', '.'));
    if (v > 0) {
      state.equivs[p.food.id] = { ...(state.equivs[p.food.id] || {}), [p.unit]: v };
      db.set('equivs', state.equivs);
      p.editEquiv = false;
    }
  }
}

function updateSimGrams() {
  const p = state.simPicked;
  const btn = $('#sim-qty .qty-grams');
  const per = p && unitGrams(p.food, p.unit, state.equivs);
  const q = parseFloat(($('#sim-qty-input')?.value || '').replace(',', '.'));
  if (btn && per && q > 0) btn.textContent = `≈ ${fmtNum(q * per, 0)} g`;
}

function simChangeUnit(unit) {
  simReadPicked();
  const p = state.simPicked;
  const prevGrams = p.qty * (unitGrams(p.food, p.unit, state.equivs) || 0);
  p.unit = unit;
  p.editEquiv = false;
  if (unit === 'g' && prevGrams) p.qty = Math.round(prevGrams);
  else if (unit !== 'g' && p.qty >= 10) p.qty = 1;
  renderSimQty();
  ($('#sim-equiv-input') || $('#sim-qty-input')).focus();
}

function simAddPicked() {
  const p = state.simPicked;
  if (!p) return;
  simReadPicked();
  const per = unitGrams(p.food, p.unit, state.equivs);
  if (!(p.qty > 0)) { toast('Indiquez une quantité.'); return; }
  if (!per) { toast(`Indiquez le poids d’une ${UNIT_BY_ID[p.unit].long}.`); renderSimQty(); $('#sim-equiv-input')?.focus(); return; }
  const item = { foodId: p.food.id, qty: p.qty, unit: p.unit, grams: Math.round(p.qty * per * 10) / 10 };
  if (p.editIndex !== undefined) state.sim.items[p.editIndex] = item;
  else state.sim.items.push(item);
  state.simPicked = null;
  saveSim();
  renderSimAll();
  $('#sim-search').focus({ preventScroll: true });
}

function simCopyDay(k) {
  if (!k) return;
  state.sim.items = structuredClone(state.meals.filter(m => m.date === k).flatMap(m => m.items));
  state.simPicked = null;
  saveSim();
  renderSimAll();
  toast(`Journée copiée : ${formatDay(k)}`);
}

function renderSimResult() {
  const el = $('#sim-result');
  if (!el) return;
  const items = state.sim.items;
  if (!items.length) { el.innerHTML = ''; return; }
  const N = Math.min(state.sim.days, state.settings.horizon);
  const r = refs();
  let base = [], endKey, firstKey;
  if (state.sim.withHistory) { base = state.meals; firstKey = addDays(today(), 1); endKey = addDays(today(), N); }
  else { firstKey = addDays(today(), -(N - 1)); endKey = today(); }
  const synthetic = [];
  for (let i = 0; i < N; i++) {
    synthetic.push({ id: 'sim' + i, date: addDays(firstKey, i), type: 'diner', items, createdAt: '', updatedAt: '' });
  }
  const g = computeGauges(base.concat(synthetic), r, state.settings, endKey);
  const t = itemsIntake(items).totals;
  const counts = { carence: 0, insuffisant: 0, ok: 0, exces: 0 };
  for (const n of NUTRIENTS) {
    const st = g[n.id].status;
    if (n.kind === 'max') { if (st === 'exces') counts.exces++; }
    else counts[st] = (counts[st] || 0) + 1;
  }
  const cells = [['energie', 'Énergie', 'kcal'], ['proteines', 'Protéines', 'g'], ['glucides', 'Glucides', 'g'], ['lipides', 'Lipides', 'g']];
  el.innerHTML = `
    <h3>Une journée type apporte</h3>
    <div class="summary sim-summary">${cells.map(([id, label, unit]) => {
      const pct = r[id] ? t[id] / r[id] * 100 : 0;
      return `<div class="sum-cell ${id === 'energie' ? 'energy' : ''}">
        <p class="sum-label">${label}</p>
        <p class="sum-value">${fmtNum(t[id], 0)}<small>${unit}</small></p>
        <p class="sum-of">sur ${fmtNum(r[id], 0)}</p>
        <div class="mini-bar"><i class="${id === 'energie' && pct > 110 ? 'over' : ''}" style="width:${Math.min(100, pct).toFixed(1)}%"></i></div>
      </div>`;
    }).join('')}</div>
    <h3>Vos jauges au bout de ${N} jours</h3>
    <p class="sim-counts">
      <span><i class="dot ok"></i>${counts.ok} couvert${counts.ok > 1 ? 's' : ''}</span>
      <span><i class="dot insuffisant"></i>${counts.insuffisant} insuffisant${counts.insuffisant > 1 ? 's' : ''}</span>
      <span><i class="dot carence"></i>${counts.carence} en carence</span>
      ${counts.exces ? `<span><i class="dot exces"></i>${counts.exces} en excès</span>` : ''}
    </p>
    ${SECTIONS.map(sec => `<div class="gauge-group"><h3>${sec.label}${sec.id === 'limites' ? ' <span>en % de la limite maximale</span>' : ''}</h3>
      <div class="gauges">${NUTRIENTS.filter(n => n.section === sec.id).map(n => gaugeRow(n, g[n.id], false)).join('')}</div></div>`).join('')}
    <p class="note">Même calcul que vos jauges (plafond, demi-vies, valeurs manquantes comptées pour zéro). Les vitamines et minéraux à demi-vie longue n’atteignent leur niveau final qu’après plusieurs semaines : comparez 30 et 60 jours.</p>`;
}

// ----- Aliments personnalisés

function customFoodForm(cf) {
  cf = cf || { valeurs: {} };
  const ref = cf.ciqual_ref ? foods.get('c:' + cf.ciqual_ref) : null;
  const field = nid => {
    const n = NUTRIENT_BY_ID[nid];
    const v = cf.valeurs?.[nid];
    const ph = ref ? displayValue(ref.values[nid], n.unit).replace(' ' + n.unit, '') : '';
    return `<div class="field"><span>${n.label}<small>${n.unit} pour 100 g</small></span>
      <input name="v-${nid}" type="number" inputmode="decimal" step="any" min="0" value="${v ?? ''}" placeholder="${esc(ph ? 'Ciqual : ' + ph : '')}"></div>`;
  };
  const others = NUTRIENTS.map(n => n.id).filter(id => !LABEL_FIELDS.includes(id));
  return `
    <div class="sheet-head"><h2>${cf.id ? 'Modifier l’aliment' : 'Nouvel aliment'}</h2><button type="button" class="link-btn" data-action="close-sheet">Fermer</button></div>
    <form id="food-form" data-id="${esc(cf.id || '')}">
      <div class="form-group">
        <div class="field stack"><span>Nom</span><input name="nom" required value="${esc(cf.nom || '')}" placeholder="ex. Pâtes complètes Panzani"></div>
        <div class="field stack"><span>Marque <small>facultatif</small></span><input name="marque" value="${esc(cf.marque || '')}"></div>
        <div class="field stack ref-pick"><span>Aliment Ciqual le plus proche<small>Complète les valeurs que vous ne renseignez pas</small></span>
          <input name="ref-search" id="ref-search" autocomplete="off" placeholder="Rechercher dans Ciqual" value="${esc(ref ? ref.name : '')}">
          <input type="hidden" name="ciqual_ref" value="${esc(cf.ciqual_ref || '')}">
          <div id="ref-results" class="results" hidden></div></div>
      </div>
      <h3>Valeurs de l’étiquette</h3>
      <div class="form-group">${LABEL_FIELDS.map(field).join('')}</div>
      <details><summary>Vitamines et minéraux</summary><div class="form-group">${others.map(field).join('')}</div></details>
      <p class="note">Laissez vide ce que vous ne connaissez pas : la valeur de l’aliment Ciqual lié sera utilisée, sinon elle comptera pour zéro.</p>
      <div class="sheet-actions"><button class="btn primary" type="submit">Enregistrer l’aliment</button></div>
    </form>`;
}

async function saveCustomFood(form) {
  const nom = form.nom.value.trim();
  if (!nom) { toast('Indiquez un nom.'); return; }
  const id = form.dataset.id || 'u:' + uid();
  const prev = state.customFoods.find(c => c.id === id);
  const valeurs = {}, sources = {};
  for (const n of NUTRIENTS) {
    const raw = form[`v-${n.id}`].value.trim().replace(',', '.');
    if (raw !== '' && isFinite(parseFloat(raw))) {
      valeurs[n.id] = parseFloat(raw);
      sources[n.id] = prev?.sources?.[n.id] && prev.valeurs?.[n.id] === valeurs[n.id] ? prev.sources[n.id] : 'manuel';
    }
  }
  const cf = {
    ...(prev || {}), id, nom, marque: form.marque.value.trim() || undefined,
    ciqual_ref: form.ciqual_ref.value || undefined, valeurs, sources,
    unites: prev?.unites || {}, createdAt: prev?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await db.put('foods', cf);
  state.customFoods = state.customFoods.filter(c => c.id !== id).concat(cf);
  registerCustomFood(cf);
  closeSheet();
  renderAll();
  toast(prev ? 'Aliment modifié' : 'Aliment créé');
}

async function deleteCustomFood(btn, id) {
  const used = state.meals.some(m => m.items.some(i => i.foodId === id));
  if (used) { toast('Cet aliment est utilisé dans des repas : supprimez-les d’abord.'); return; }
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Confirmer'; return; }
  await db.del('foods', id);
  state.customFoods = state.customFoods.filter(c => c.id !== id);
  unregisterFood(id);
  renderMyFoods('#my-foods', 'pick');
  openSettings();
  toast('Aliment supprimé');
}

const IMPORT_EXAMPLE = `{
  "format": "${FOOD_FORMAT}",
  "version": 1,
  "aliments": [{
    "nom": "Pâtes complètes",
    "marque": "Exemple",
    "code_barres": "3000000000000",
    "ciqual_ref": "9871",
    "source": "etiquette",
    "pour_100g": {
      "energie": 352, "lipides": 2.5, "ags": 0.5,
      "glucides": 64, "sucres": 3.5, "fibres": 8,
      "proteines": 13, "sel": 0.01
    },
    "unites": { "portion": 80 }
  }]
}`;

function openImportFood() {
  openSheet(`
    <div class="sheet-head"><h2>Importer un aliment</h2><button type="button" class="link-btn" data-action="close-sheet">Fermer</button></div>
    <p>Collez le texte d’un aliment au format JSON (par exemple celui que Claude vous renvoie à partir d’une photo d’étiquette), ou choisissez un fichier.</p>
    <form id="import-food-form">
      <div class="form-group"><div class="field stack"><label for="import-text" class="sr-only">Texte JSON</label>
        <textarea id="import-text" placeholder='{ "format": "${FOOD_FORMAT}", … }'></textarea></div></div>
      <div class="sheet-actions" style="justify-content:space-between">
        <label class="btn">Choisir un fichier<input type="file" accept="application/json,.json,.txt" id="import-food-file" hidden></label>
        <button class="btn primary" type="submit">Importer</button>
      </div>
    </form>
    <details><summary>Voir le format attendu</summary>
      <p class="note">Valeurs pour 100 g. Clés possibles : ${NUTRIENTS.map(n => `<code>${n.id}</code>`).join(', ')}. Les nutriments absents reprennent les valeurs de l’aliment Ciqual indiqué dans <code>ciqual_ref</code>.</p>
      <pre class="code">${esc(IMPORT_EXAMPLE)}</pre></details>`);
}

async function importFoods(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('Ce texte n’est pas du JSON valide.'); return; }
  const list = Array.isArray(data) ? data : Array.isArray(data.aliments) ? data.aliments : [data];
  let count = 0;
  const errors = [];
  for (const a of list) {
    if (!a || typeof a.nom !== 'string' || !a.nom.trim()) { errors.push('aliment sans nom'); continue; }
    const valeurs = {}, sources = {};
    const src = a.pour_100g || a.valeurs || {};
    for (const [k, v] of Object.entries(src)) {
      if (NUTRIENT_BY_ID[k] && typeof v === 'number' && isFinite(v)) {
        valeurs[k] = v;
        sources[k] = (a.sources && a.sources[k]) || a.source || 'etiquette';
      }
    }
    const ref = a.ciqual_ref ? String(a.ciqual_ref) : undefined;
    if (ref && !foods.has('c:' + ref)) errors.push(`code Ciqual ${ref} inconnu pour « ${a.nom} »`);
    const existing = a.code_barres && state.customFoods.find(c => c.code_barres && c.code_barres === String(a.code_barres));
    const cf = {
      id: existing ? existing.id : 'u:' + uid(), nom: a.nom.trim(), marque: a.marque || undefined,
      code_barres: a.code_barres ? String(a.code_barres) : undefined,
      ciqual_ref: ref && foods.has('c:' + ref) ? ref : undefined, valeurs, sources, source: a.source || 'etiquette',
      unites: a.unites || {}, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await db.put('foods', cf);
    state.customFoods = state.customFoods.filter(c => c.id !== cf.id).concat(cf);
    registerCustomFood(cf);
    count++;
  }
  closeSheet();
  renderAll();
  toast(`${count} aliment${count > 1 ? 's' : ''} importé${count > 1 ? 's' : ''}${errors.length ? ` · ${errors.join(', ')}` : ''}`, 6000);
}

// ----- Sauvegarde

async function exportData() {
  const data = {
    format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    profile: state.profile, settings: state.settings, meals: state.meals,
    customFoods: state.customFoods, equivs: state.equivs, weekly: state.weekly,
    weights: await db.all('weights'),
  };
  const name = `mes-apports-${today()}.json`;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  let done = false;
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: 'Sauvegarde Mes apports' }); done = true; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  state.meta.lastExport = new Date().toISOString();
  await saveMeta();
  renderBanners();
  toast('Sauvegarde exportée');
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('Fichier illisible.'); return; }
  if (data.format === FOOD_FORMAT || (data.aliments && !data.meals)) { closeSheet(); return importFoods(JSON.stringify(data)); }
  if (data.format !== BACKUP_FORMAT) { toast('Ce fichier n’est pas une sauvegarde de Mes apports.'); return; }
  let added = 0, updated = 0;
  const byId = new Map(state.meals.map(m => [m.id, m]));
  const toWrite = [];
  for (const m of data.meals || []) {
    const cur = byId.get(m.id);
    if (!cur) { added++; toWrite.push(m); }
    else if ((m.updatedAt || '') > (cur.updatedAt || '')) { updated++; toWrite.push(m); }
  }
  await db.putMany('meals', toWrite);
  const foodIds = new Map(state.customFoods.map(c => [c.id, c]));
  const foodsToWrite = (data.customFoods || []).filter(c => !foodIds.has(c.id) || (c.updatedAt || '') > (foodIds.get(c.id).updatedAt || ''));
  await db.putMany('foods', foodsToWrite);
  const weeklyIds = new Map(state.weekly.map(w => [w.id, w]));
  const weeklyToWrite = (data.weekly || []).filter(w => !weeklyIds.has(w.id) || (w.updatedAt || '') > (weeklyIds.get(w.id).updatedAt || ''));
  await db.putMany('weekly', weeklyToWrite);
  const weightIds = new Map((await db.all('weights')).map(w => [w.id, w]));
  await db.putMany('weights', (data.weights || []).filter(w => !weightIds.has(w.id) || (w.updatedAt || '') > (weightIds.get(w.id).updatedAt || '')));
  state.weekly = await db.all('weekly');
  state.equivs = { ...(data.equivs || {}), ...state.equivs };
  await db.set('equivs', state.equivs);
  if (!state.profile && data.profile) { state.profile = data.profile; await db.set('profile', data.profile); }
  state.meals = await db.all('meals');
  state.customFoods = await db.all('foods');
  state.customFoods.forEach(registerCustomFood);
  closeSheet();
  renderAll();
  toast(`Import terminé : ${added} repas ajouté${added > 1 ? 's' : ''}, ${updated} mis à jour, ${foodsToWrite.length} aliment${foodsToWrite.length > 1 ? 's' : ''}.`, 6000);
}

async function wipe(btn) {
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Toucher à nouveau pour tout effacer'; return; }
  await db.clearAll();
  location.reload();
}

// ---------------------------------------------------------------- Événements

function bindEvents() {
  document.addEventListener('click', onClick);

  const searchInput = $('#food-search');
  searchInput.addEventListener('input', () => runSearch(searchInput.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, 'main'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, 'main'); }
    else if (e.key === 'Enter') { e.preventDefault(); if (searchResults[searchIndex]) pickFood(searchResults[searchIndex].id); }
    else if (e.key === 'Escape') { searchInput.value = ''; runSearch(''); }
  });
  searchInput.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement === searchInput || document.activeElement?.closest?.('#search-results')) return;
    $('#search-results').hidden = true;
  }, 200));
  searchInput.addEventListener('focus', () => { if (searchInput.value) runSearch(searchInput.value); });

  $('#weekly-form').addEventListener('submit', e => { e.preventDefault(); addWeekly(e.target); });
  $('#weekly-list').addEventListener('change', e => {
    if (e.target.matches('input[type="checkbox"]')) toggleWeekly(e.target.dataset.id, e.target.checked);
  });

  $('#meal-date').addEventListener('change', e => { state.draft.date = e.target.value || today(); saveDraft(); });

  $('#qty-panel').addEventListener('change', e => {
    if (e.target.id === 'unit-select') {
      readPicked();
      const p = state.picked;
      const prevGrams = p.qty * (unitGrams(p.food, p.unit, state.equivs) || 0);
      p.unit = e.target.value;
      p.editEquiv = false;
      if (p.unit === 'g' && prevGrams) p.qty = Math.round(prevGrams);
      else if (p.unit !== 'g' && p.qty >= 10) p.qty = 1;
      renderQtyPanel();
      ($('#equiv-input') || $('#qty-input')).focus();
    }
  });
  $('#qty-panel').addEventListener('input', e => {
    if (e.target.id === 'qty-input' || e.target.id === 'equiv-input') {
      const btn = $('#qty-panel .qty-grams');
      const p = state.picked;
      const per = unitGrams(p.food, p.unit, state.equivs);
      const q = parseFloat(($('#qty-input').value || '').replace(',', '.'));
      if (btn && per && q > 0) btn.textContent = `≈ ${fmtNum(q * per, 0)} g`;
    }
  });
  $('#qty-panel').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addPicked(); }
    if (e.key === 'Escape') { state.picked = null; renderQtyPanel(); }
  });

  const s = sheet();
  s.addEventListener('cancel', e => { if (s.dataset.locked) e.preventDefault(); });
  s.addEventListener('click', e => { if (e.target === s && !s.dataset.locked) closeSheet(); });
  s.addEventListener('submit', async e => {
    e.preventDefault();
    if (e.target.id === 'profile-form') {
      const p = readProfile(e.target);
      if (!p) { toast('Renseignez le sexe, l’âge (18 ans ou plus) et le poids.'); return; }
      state.profile = p;
      await db.set('profile', p);
      s.dataset.locked = '';
      closeSheet();
      renderAll();
    } else if (e.target.id === 'food-form') {
      saveCustomFood(e.target);
    } else if (e.target.id === 'import-food-form') {
      importFoods($('#import-text').value);
    } else if (e.target.id === 'sync-form') {
      submitSyncForm(e.target);
    }
  });
  s.addEventListener('input', e => {
    if (e.target.id === 'sim-search') { runSearch(e.target.value, 'sim'); return; }
    if (e.target.id === 'sim-qty-input' || e.target.id === 'sim-equiv-input') { updateSimGrams(); return; }
    if (e.target.id === 'ref-search') {
      e.target.form.ciqual_ref.value = '';
      runSearch(e.target.value, 'ref');
      return;
    }
    if (e.target.closest('#settings-profile, #settings-calc')) onSettingsInput(e);
  });
  s.addEventListener('change', async e => {
    if (e.target.id === 'sim-unit-select') { simChangeUnit(e.target.value); return; }
    if (e.target.id === 'sim-history') { state.sim.withHistory = e.target.checked; saveSim(); renderSimResult(); return; }
    if (e.target.id === 'sim-copy-day') { simCopyDay(e.target.value); e.target.value = ''; return; }
    if (e.target.name === 'theme') {
      state.settings.theme = e.target.value;
      applyTheme(state.settings.theme);
      await db.set('settings', state.settings);
      return;
    }
    if (e.target.closest('#settings-profile')) onSettingsInput(e);
    if (e.target.id === 'backup-file' && e.target.files[0]) importBackup(e.target.files[0]);
    if (e.target.id === 'import-food-file' && e.target.files[0]) $('#import-text').value = await e.target.files[0].text();
  });
  s.addEventListener('keydown', e => {
    if (e.target.id === 'sim-search') {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, 'sim'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, 'sim'); }
      else if (e.key === 'Enter') { e.preventDefault(); if (searchResults[searchIndex]) simPick(searchResults[searchIndex].id); }
      return;
    }
    if (e.target.closest && e.target.closest('#sim-qty') && e.key === 'Enter') { e.preventDefault(); simAddPicked(); return; }
    if (e.target.id === 'ref-search') {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, 'ref'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, 'ref'); }
      else if (e.key === 'Enter') { e.preventDefault(); if (searchResults[searchIndex]) pickRef(searchResults[searchIndex].id); }
    }
  });

  window.addEventListener('focus', () => { if (state.renderedDay && state.renderedDay !== today()) renderAll(); state.renderedDay = today(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderWeekly(); // la remise à zéro du lundi a pu passer pendant que l'app dormait
    if (!document.hidden && state.renderedDay !== today()) {
      if (!state.draft.items.length && !state.draft.id) state.draft = newDraft();
      renderAll();
    }
    state.renderedDay = today();
  });
  state.renderedDay = today();
}

function pickRef(id) {
  const f = foods.get(id);
  const form = $('#food-form');
  form.ciqual_ref.value = f.code;
  $('#ref-search').value = f.name;
  $('#ref-results').hidden = true;
  for (const n of NUTRIENTS) {
    const inp = form[`v-${n.id}`];
    const ph = displayValue(f.values[n.id], n.unit).replace(' ' + n.unit, '');
    inp.placeholder = 'Ciqual : ' + ph;
  }
}

function onClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t) {
    if (!e.target.closest('.search')) {
      $('#search-results').hidden = true;
      const sr = $('#sim-results');
      if (sr) sr.hidden = true;
    }
    return;
  }
  const a = t.dataset.action, id = t.dataset.id;
  switch (a) {
    case 'pick': pickFood(id); break;
    case 'pick-ref': pickRef(id); break;
    case 'add-item': addPicked(); break;
    case 'cancel-pick': state.picked = null; renderQtyPanel(); break;
    case 'edit-equiv': readPicked(); state.picked.editEquiv = true; renderQtyPanel(); $('#equiv-input').select(); break;
    case 'edit-item': pickFood(state.draft.items[+t.dataset.index].foodId, +t.dataset.index); break;
    case 'remove-item': state.draft.items.splice(+t.dataset.index, 1); state.picked = null; saveDraft(); renderEntry(); break;
    case 'set-type': state.draft.type = t.dataset.type; saveDraft(); renderEntry(); break;
    case 'save-meal': saveMeal(); break;
    case 'cancel-edit': state.draft = newDraft(); state.picked = null; saveDraft(); renderEntry(); break;
    case 'redo': loadMealIntoDraft(id, true); break;
    case 'edit-meal': loadMealIntoDraft(id, false); break;
    case 'delete-meal': deleteMeal(t, id); break;
    case 'more-history': state.historyDays += 14; renderHistory(); break;
    case 'nutrient': openNutrient(id); break;
    case 'add-tip': addTipToDraft(id, parseFloat(t.dataset.grams)); break;
    case 'open-sim': openSimulation(); break;
    case 'pick-sim': simPick(id); break;
    case 'sim-add': simAddPicked(); break;
    case 'sim-cancel-pick': state.simPicked = null; renderSimQty(); break;
    case 'sim-edit-equiv': simReadPicked(); state.simPicked.editEquiv = true; renderSimQty(); $('#sim-equiv-input')?.select(); break;
    case 'sim-edit-item': simPick(state.sim.items[+t.dataset.index].foodId, +t.dataset.index); break;
    case 'sim-remove': state.sim.items.splice(+t.dataset.index, 1); state.simPicked = null; saveSim(); renderSimAll(); break;
    case 'sim-clear': state.sim.items = []; state.simPicked = null; saveSim(); renderSimAll(); break;
    case 'sim-days': state.sim.days = +t.dataset.days; saveSim(); renderSimAll(); break;
    case 'open-settings': openSettings(); break;
    case 'close-sheet': closeSheet(); break;
    case 'reset-calc': state.settings = { ...structuredClone(DEFAULT_SETTINGS), theme: state.settings.theme }; db.set('settings', state.settings); renderGauges(); openSettings(); break;
    case 'new-food': openSheet(customFoodForm()); break;
    case 'edit-food': openSheet(customFoodForm(state.customFoods.find(c => c.id === id))); break;
    case 'delete-food': deleteCustomFood(t, id); break;
    case 'import-food': openImportFood(); break;
    case 'export': exportData(); break;
    case 'sync-now': syncNow(); break;
    case 'weekly-remove': removeWeekly(id); break;
    case 'sync-disconnect': disconnectFromSync(t); break;
    case 'wipe': wipe(t); break;
    case 'dismiss-install': state.meta.installHintDismissed = true; saveMeta(); renderBanners(); break;
    case 'snooze-backup': state.meta.backupSnooze = dateKey(new Date(Date.now() + 3 * 86400000)); saveMeta(); renderBanners(); break;
    case 'reload': location.reload(); break;
  }
}

// ---------------------------------------------------------------- Utilitaires

function applyTheme(theme) {
  const t = ['light', 'dark', 'auto'].includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (e) { /* stockage indisponible */ }
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0F1312' : '#FFFFFF');
}

let toastTimer;
function toast(msg, ms = 2600, actionHtml = '') {
  const el = $('#toast');
  el.innerHTML = esc(msg) + actionHtml;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nouvelle version disponible.', 15000, '<button type="button" data-action="reload">Recharger</button>');
        }
      });
    });
  }).catch(() => {});
  navigator.storage?.estimate?.().then(e => {
    if (e && e.usage) $('#storage-info').textContent = `Stockage utilisé sur cet appareil : ${(e.usage / 1048576).toFixed(1)} Mo.`;
  });
}

init().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<p style="padding:16px;color:#c00">Erreur au démarrage : ${esc(err.message)}</p>`);
});
