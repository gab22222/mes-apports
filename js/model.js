// Calcul des apports et des jauges.

import { NUTRIENTS } from './nutrients.js';
import { foods, readValue } from './foods.js';

export function dateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(k, n) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export function daysBetween(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / 86400000);
}

// Apports d'un repas ou d'une liste d'éléments.
// Retourne { totals: {nid: valeur}, missing: {nid: grammes sans donnée}, grams }
export function itemsIntake(items) {
  const totals = {}, missing = {};
  let grams = 0;
  for (const n of NUTRIENTS) { totals[n.id] = 0; missing[n.id] = 0; }
  for (const it of items) {
    const food = foods.get(it.foodId);
    if (!food) continue;
    grams += it.grams;
    const f = it.grams / 100;
    for (const n of NUTRIENTS) {
      const { v, missing: miss } = readValue(food.values[n.id], n.id);
      totals[n.id] += v * f;
      if (miss) missing[n.id] += it.grams;
    }
  }
  return { totals, missing, grams };
}

// Regroupe les repas par jour.
export function byDay(meals) {
  const map = new Map();
  for (const m of meals) {
    if (!map.has(m.date)) map.set(m.date, []);
    map.get(m.date).push(m);
  }
  return map;
}

// Jauges : moyenne journalière pondérée à décroissance exponentielle des apports plafonnés.
export function computeGauges(meals, refs, settings, todayKey) {
  const days = byDay(meals);
  const H = settings.horizon;
  const perDay = [];
  for (let age = 0; age < H; age++) {
    const k = addDays(todayKey, -age);
    const ms = days.get(k) || [];
    perDay.push(itemsIntake(ms.flatMap(m => m.items)));
  }
  const out = {};
  for (const n of NUTRIENTS) {
    const hl = settings.halfLives[n.cat];
    const ref = refs[n.id];
    const capValue = n.kind === 'min' ? ref * settings.cap / 100 : Infinity;
    let num = 0, den = 0, rawNum = 0, missW = 0, gramsW = 0;
    perDay.forEach((d, age) => {
      const w = Math.pow(0.5, age / hl);
      const v = d.totals[n.id];
      num += w * Math.min(v, capValue);
      rawNum += w * v;
      den += w;
      missW += w * d.missing[n.id];
      gramsW += w * d.grams;
    });
    // La journée en cours n'est pas terminée : elle ne compte que si elle fait monter la moyenne,
    // pour éviter que toutes les jauges chutent chaque matin avant le premier repas.
    const w0 = 1, t0 = perDay[0].totals[n.id];
    const withToday = num / den;
    const withoutToday = (num - w0 * Math.min(t0, capValue)) / (den - w0);
    const useToday = n.kind === 'max' || withToday >= withoutToday;
    const avg = useToday ? withToday : withoutToday;
    if (!useToday) rawNum = (rawNum - w0 * t0) * den / (den - w0);
    const pct = ref ? (avg / ref) * 100 : 0;
    out[n.id] = {
      avg, rawAvg: rawNum / den, ref, pct,
      today: perDay[0].totals[n.id],
      missingShare: gramsW > 0 ? missW / gramsW : 0,
      status: status(n, pct),
    };
  }
  return out;
}

export function status(n, pct) {
  if (n.kind === 'max') return pct > 100 ? 'exces' : pct >= 90 ? 'proche' : 'ok';
  if (n.kind === 'energy' && pct > 110) return 'exces';
  if (pct < 50) return 'carence';
  if (pct < 90) return 'insuffisant';
  return 'ok';
}

export const STATUS_LABEL = {
  carence: 'Carence', insuffisant: 'Insuffisant', ok: 'Couvert', exces: 'Excès', proche: 'Proche de la limite',
};

// Principaux aliments contributeurs sur les derniers jours.
export function topSources(meals, nid, todayKey, days = 14, limit = 3) {
  const from = addDays(todayKey, -(days - 1));
  const acc = new Map();
  let total = 0;
  for (const m of meals) {
    if (m.date < from || m.date > todayKey) continue;
    for (const it of m.items) {
      const food = foods.get(it.foodId);
      if (!food) continue;
      const v = readValue(food.values[nid], nid).v * it.grams / 100;
      if (!v) continue;
      acc.set(it.foodId, (acc.get(it.foodId) || 0) + v);
      total += v;
    }
  }
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([id, v]) => ({ food: foods.get(id), share: total ? v / total : 0 }));
}

export function mealSignature(m) {
  return [...new Set(m.items.map(i => i.foodId))].sort().join('|');
}
