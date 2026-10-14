// Définition des nutriments, des références ANSES et du besoin énergétique.

// cat : catégorie de demi-vie (macro, hydro, stock, limite)
// kind : 'min' = apport à atteindre, 'energy' = à atteindre sans dépasser, 'max' = limite à ne pas dépasser
export const NUTRIENTS = [
  // Vitamines
  { id: 'vitA',  label: 'Vitamine A',  unit: 'µg', section: 'vitamines', cat: 'stock', kind: 'min' },
  { id: 'vitB1', label: 'Vitamine B1', unit: 'mg', section: 'vitamines', cat: 'hydro', kind: 'min' },
  { id: 'vitB2', label: 'Vitamine B2', unit: 'mg', section: 'vitamines', cat: 'hydro', kind: 'min' },
  { id: 'vitB3', label: 'Vitamine B3', unit: 'mg', section: 'vitamines', cat: 'hydro', kind: 'min' },
  { id: 'vitB5', label: 'Vitamine B5', unit: 'mg', section: 'vitamines', cat: 'hydro', kind: 'min' },
  { id: 'vitB6', label: 'Vitamine B6', unit: 'mg', section: 'vitamines', cat: 'hydro', kind: 'min' },
  { id: 'vitB9', label: 'Vitamine B9', unit: 'µg', section: 'vitamines', cat: 'hydro', kind: 'min' },
  { id: 'vitB12', label: 'Vitamine B12', unit: 'µg', section: 'vitamines', cat: 'stock', kind: 'min' },
  { id: 'vitC',  label: 'Vitamine C',  unit: 'mg', section: 'vitamines', cat: 'hydro', kind: 'min' },
  { id: 'vitD',  label: 'Vitamine D',  unit: 'µg', section: 'vitamines', cat: 'stock', kind: 'min' },
  { id: 'vitE',  label: 'Vitamine E',  unit: 'mg', section: 'vitamines', cat: 'stock', kind: 'min' },
  { id: 'vitK',  label: 'Vitamine K',  unit: 'µg', section: 'vitamines', cat: 'stock', kind: 'min' },
  // Minéraux
  { id: 'calcium',   label: 'Calcium',   unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'cuivre',    label: 'Cuivre',    unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'fer',       label: 'Fer',       unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'iode',      label: 'Iode',      unit: 'µg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'magnesium', label: 'Magnésium', unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'manganese', label: 'Manganèse', unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'phosphore', label: 'Phosphore', unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'potassium', label: 'Potassium', unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'selenium',  label: 'Sélénium',  unit: 'µg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'sodium',    label: 'Sodium',    unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  { id: 'zinc',      label: 'Zinc',      unit: 'mg', section: 'mineraux', cat: 'stock', kind: 'min' },
  // Macronutriments
  { id: 'energie',   label: 'Énergie',   unit: 'kcal', section: 'macros', cat: 'macro', kind: 'energy' },
  { id: 'proteines', label: 'Protéines', unit: 'g', section: 'macros', cat: 'macro', kind: 'min' },
  { id: 'glucides',  label: 'Glucides',  unit: 'g', section: 'macros', cat: 'macro', kind: 'min' },
  { id: 'lipides',   label: 'Lipides',   unit: 'g', section: 'macros', cat: 'macro', kind: 'min' },
  { id: 'fibres',    label: 'Fibres',    unit: 'g', section: 'macros', cat: 'macro', kind: 'min' },
  // Limites
  { id: 'sel',    label: 'Sel',               unit: 'g', section: 'limites', cat: 'limite', kind: 'max' },
  { id: 'sucres', label: 'Sucres',            unit: 'g', section: 'limites', cat: 'limite', kind: 'max' },
  { id: 'ags',    label: 'Graisses saturées', unit: 'g', section: 'limites', cat: 'limite', kind: 'max' },
];

export const NUTRIENT_BY_ID = Object.fromEntries(NUTRIENTS.map(n => [n.id, n]));

export const SECTIONS = [
  { id: 'vitamines', label: 'Vitamines' },
  { id: 'mineraux', label: 'Minéraux' },
  { id: 'macros', label: 'Macronutriments' },
  { id: 'limites', label: 'À limiter' },
];

export const HALF_LIFE_CATS = [
  { id: 'macro', label: 'Macronutriments et énergie' },
  { id: 'hydro', label: 'Vitamines hydrosolubles (C, B1, B2, B3, B5, B6, B9)' },
  { id: 'stock', label: 'Vitamines A, D, E, K, B12 et minéraux' },
  { id: 'limite', label: 'Sel, sucres et graisses saturées' },
];

export const DEFAULT_SETTINGS = {
  cap: 150,               // plafond journalier en % des apports recommandés
  halfLives: { macro: 1.5, hydro: 3, stock: 10, limite: 1.5 },
  horizon: 60,            // jours pris en compte
};

export const ACTIVITY_LEVELS = [
  { id: 1.4, label: 'Sédentaire', hint: 'travail assis, peu de marche' },
  { id: 1.6, label: 'Modérément actif', hint: 'marche quotidienne ou sport 1 à 2 fois par semaine' },
  { id: 1.8, label: 'Actif', hint: 'métier physique ou sport 3 à 5 fois par semaine' },
  { id: 2.0, label: 'Très actif', hint: 'sport intense presque tous les jours' },
];

// Besoin énergétique : métabolisme de base de Schofield (OMS/FAO, à partir du poids et de l'âge)
// multiplié par le niveau d'activité physique (NAP).
export function energyNeed(p) {
  const w = p.weight, a = p.age;
  let bmr;
  if (p.sex === 'H') bmr = a < 30 ? 15.057 * w + 692.2 : a < 60 ? 11.472 * w + 873.1 : 11.711 * w + 587.7;
  else bmr = a < 30 ? 14.818 * w + 486.6 : a < 60 ? 8.126 * w + 845.6 : 9.082 * w + 658.5;
  return Math.round(bmr * p.activity);
}

// Références nutritionnelles ANSES (2021) pour adultes. Valeurs par jour.
export function references(p) {
  const H = p.sex === 'H';
  const kcal = energyNeed(p);
  const MJ = kcal * 0.004184;
  return {
    energie: kcal,
    proteines: Math.round(0.83 * p.weight),           // RNP 0,83 g/kg/j
    glucides: Math.round(kcal * 0.50 / 4),           // 40 à 55 % de l'énergie
    lipides: Math.round(kcal * 0.375 / 9),           // 35 à 40 % de l'énergie
    fibres: 30,
    vitA: H ? 750 : 650,
    vitB1: +(0.1 * MJ).toFixed(2),                    // 0,1 mg/MJ
    vitB2: 1.6,
    vitB3: +(1.6 * MJ).toFixed(1),                    // 1,6 mg/MJ
    vitB5: H ? 6 : 5,
    vitB6: H ? 1.7 : 1.6,
    vitB9: 330,
    vitB12: 4,
    vitC: 110,
    vitD: 15,
    vitE: H ? 10 : 9,
    vitK: 79,
    calcium: p.age < 25 ? 1000 : 950,
    cuivre: H ? 1.9 : 1.5,
    fer: H ? 11 : (p.age < 50 ? 16 : 11),             // 16 mg : hypothèse prudente avant la ménopause
    iode: 150,
    magnesium: H ? 380 : 300,
    manganese: H ? 2.8 : 2.5,
    phosphore: 550,
    potassium: 3500,
    selenium: 70,
    sodium: 1500,
    zinc: H ? 11.7 : 9.3,                             // apport en phytates modéré
    sel: 5,                                           // limite OMS
    sucres: 100,                                      // limite ANSES (sucres totaux)
    ags: Math.round(kcal * 0.12 / 9),                 // 12 % de l'énergie maximum
  };
}

export const REFERENCE_NOTES = {
  energie: 'Besoin estimé : métabolisme de base (Schofield) × niveau d’activité.',
  glucides: 'Repère : 50 % de l’énergie (ANSES : 40 à 55 %).',
  lipides: 'Repère : 37,5 % de l’énergie (ANSES : 35 à 40 %).',
  vitB3: 'Ciqual ne compte que la niacine préformée : valeur sous-estimée.',
  fer: 'Pour les femmes de moins de 50 ans, la référence haute (16 mg) est retenue par prudence.',
  zinc: 'Référence pour une alimentation modérément riche en phytates.',
  sel: 'Limite recommandée par l’OMS.',
  sucres: 'Limite ANSES pour les sucres totaux (hors lactose et galactose ; ici lactose compris, donc plus prudent).',
  ags: 'Limite : 12 % de l’énergie.',
  vitK: 'Vitamine K1, plus K2 lorsqu’elle est connue.',
};
