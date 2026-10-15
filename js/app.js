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
  dateKey, parseKey, daysBetween, itemsIntake, computeGauges, STATUS_LABEL, topSources, mealSignature,
} from './model.js';

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
  equivs: {},
  profile: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  meta: {},
  draft: null,
  picked: null,        // { food, qty, unit, editIndex }
  usage: new Map(),
  lastUse: new Map(),
  historyDays: 14,
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => dateKey(new Date());

// ---------------------------------------------------------------- Démarrage

async function init() {
  registerServiceWorker();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* facultatif */ }

  const [meals, customFoods, equivs, profile, settings, meta, draft] = await Promise.all([
    db.all('meals'), db.all('foods'), db.get('equivs'), db.get('profile'), db.get('settings'), db.get('meta'), db.get('draft'),
    loadCiqual(),
  ]);
  state.meals = meals || [];
  state.customFoods = customFoods || [];
  state.equivs = equivs || {};
  state.profile = profile || null;
  state.settings = mergeSettings(settings);
  applyTheme(state.settings.theme);
  state.meta = meta || {};
  state.customFoods.forEach(registerCustomFood);
  state.draft = draft || newDraft();
  if (!state.meta.firstLaunch) { state.meta.firstLaunch = today(); saveMeta(); }

  bindEvents();
  renderAll();
  if (!state.profile) openProfileSheet(true);
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
  if (state.meals.length) {
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
  renderDraftItems();
  renderQtyPanel();
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

function gaugeRow(n, d) {
  const scale = 150;
  const width = Math.min(d.pct, scale) / scale * 100;
  const partial = d.missingShare > 0.25;
  const statusText = STATUS_LABEL[d.status];
  return `<button type="button" class="gauge ${d.status}" data-action="nutrient" data-id="${n.id}" aria-label="${n.label} : ${Math.round(d.pct)} %, ${statusText}">
    <span class="g-name">${n.label}${partial ? PARTIAL_ICON : ''}</span>
    <span class="bar"><span class="fill" style="width:${width.toFixed(1)}%"></span><span class="tick" style="left:${(100 / scale * 100).toFixed(2)}%"></span></span>
    <span class="g-pct ${d.status}">${Math.round(d.pct)} %</span>
  </button>`;
}

// ---------------------------------------------------------------- Recherche

let searchResults = [], searchIndex = -1;

function runSearch(q, target = 'main') {
  const box = target === 'main' ? $('#search-results') : $('#ref-results');
  if (!q.trim()) { box.hidden = true; box.innerHTML = ''; searchResults = []; return; }
  searchResults = search(q, state.usage, target === 'main' ? 12 : 8).filter(f => target === 'main' || !f.custom);
  searchIndex = searchResults.length ? 0 : -1;
  box.hidden = false;
  box.innerHTML = searchResults.length ? searchResults.map((f, i) => {
    const grp = f.group.split('|')[1] || f.group.split('|')[0] || '';
    return `<button type="button" class="result" role="option" aria-selected="${i === searchIndex}" data-action="${target === 'main' ? 'pick' : 'pick-ref'}" data-id="${esc(f.id)}">
      ${esc(f.name)}${f.custom ? '<span class="tag">perso</span>' : ''}<small>${esc(grp)}</small></button>`;
  }).join('') : `<div class="empty">Aucun aliment trouvé.${target === 'main' ? ' <button type="button" class="link-btn" data-action="new-food">Créer un aliment personnalisé</button>' : ''}</div>`;
}

function moveSelection(delta, target) {
  const box = target === 'main' ? $('#search-results') : $('#ref-results');
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
  const lastExport = state.meta.lastExport ? new Date(state.meta.lastExport).toLocaleDateString('fr-FR') : 'jamais';
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

    <h3>Données</h3>
    <p class="note">Vos données restent sur cet appareil. Dernière sauvegarde : ${lastExport}. Pour passer du Mac à l’iPhone, exportez sur l’un puis importez sur l’autre : les repas sont fusionnés.</p>
    <div class="stack-actions">
      <button type="button" class="btn primary" data-action="export">Exporter une sauvegarde</button>
      <label class="btn" style="text-align:center">Importer une sauvegarde<input type="file" accept="application/json,.json" id="backup-file" hidden></label>
      <button type="button" class="btn danger" data-action="wipe">Effacer toutes les données</button>
    </div>`);
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
    customFoods: state.customFoods, equivs: state.equivs,
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
    }
  });
  s.addEventListener('input', e => {
    if (e.target.id === 'ref-search') {
      e.target.form.ciqual_ref.value = '';
      runSearch(e.target.value, 'ref');
      return;
    }
    if (e.target.closest('#settings-profile, #settings-calc')) onSettingsInput(e);
  });
  s.addEventListener('change', async e => {
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
    if (e.target.id === 'ref-search') {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, 'ref'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, 'ref'); }
      else if (e.key === 'Enter') { e.preventDefault(); if (searchResults[searchIndex]) pickRef(searchResults[searchIndex].id); }
    }
  });

  window.addEventListener('focus', () => { if (state.renderedDay && state.renderedDay !== today()) renderAll(); state.renderedDay = today(); });
  document.addEventListener('visibilitychange', () => {
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
    if (!e.target.closest('.search')) $('#search-results').hidden = true;
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
    case 'open-settings': openSettings(); break;
    case 'close-sheet': closeSheet(); break;
    case 'reset-calc': state.settings = { ...structuredClone(DEFAULT_SETTINGS), theme: state.settings.theme }; db.set('settings', state.settings); renderGauges(); openSettings(); break;
    case 'new-food': openSheet(customFoodForm()); break;
    case 'edit-food': openSheet(customFoodForm(state.customFoods.find(c => c.id === id))); break;
    case 'delete-food': deleteCustomFood(t, id); break;
    case 'import-food': openImportFood(); break;
    case 'export': exportData(); break;
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
