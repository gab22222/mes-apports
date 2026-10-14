#!/usr/bin/env python3
"""Convertit la table Ciqual (fichier Excel de l'ANSES) en data/ciqual.json pour l'app.

Usage : python3 outils/convertir_ciqual.py Table_Ciqual_2025_FR.xlsx data/ciqual.json

Codage de chaque valeur (pour 100 g de partie comestible) :
  nombre   valeur mesurée
  null     valeur manquante (« - » dans Ciqual)
  "t"      traces
  "<x"     inférieur à x
  "~x"     valeur partielle : calculée à partir de composants dont certains manquent
"""
import json, re, sys
import openpyxl

# id du nutriment -> colonne principale, puis composants de secours (colonne, coefficient)
NUTRIMENTS = {
    "energie":   ("Energie, Règlement UE N° 1169 2011 (kcal 100 g)", None),
    "proteines": ("Protéines, N x facteur de Jones (g 100 g)", [("Protéines, N x 6.25 (g 100 g)", 1)]),
    "glucides":  ("Glucides (g 100 g)", None),
    "lipides":   ("Lipides (g 100 g)", None),
    "sucres":    ("Sucres (g 100 g)", None),
    "fibres":    ("Fibres alimentaires (g 100 g)", None),
    "ags":       ("AG saturés (g 100 g)", None),
    "sel":       ("Sel chlorure de sodium (g 100 g)", [("Sodium (mg 100 g)", 2.5 / 1000)]),
    "vitA":      ("Activité vitaminique A, équivalents rétinol (µg 100 g)",
                  [("Rétinol (µg 100 g)", 1), ("Beta-Carotène (µg 100 g)", 1 / 12)]),
    "vitD":      ("Vitamine D (µg 100 g)",
                  [("Vitamine D2 (ergocalciférol) (µg 100 g)", 1), ("Vitamine D3 (cholécalciférol) (µg 100 g)", 1)]),
    "vitE":      ("Alpha-tocophérol (vitamine E) (mg 100 g)", [("Vitamine E (mg 100 g)", 1)]),
    "vitK":      ("Vitamine K1 (µg 100 g)", None),  # K2 ajoutée à part si connue
    "vitC":      ("Vitamine C (mg 100 g)", None),
    "vitB1":     ("Vitamine B1 ou Thiamine (mg 100 g)", None),
    "vitB2":     ("Vitamine B2 ou Riboflavine (mg 100 g)", None),
    "vitB3":     ("Vitamine B3 ou PP ou Niacine (mg 100 g)", None),
    "vitB5":     ("Vitamine B5 ou Acide pantothénique (mg 100 g)", None),
    "vitB6":     ("Vitamine B6 (mg 100 g)", None),
    "vitB9":     ("Vitamine B9 ou Folates totaux, équivalents folates alimentaires, DFE (µg 100 g)",
                  [("Vitamine B9 ou Folates totaux (µg 100 g)", 1)]),
    "vitB12":    ("Vitamine B12 (µg 100 g)", None),
    "calcium":   ("Calcium (mg 100 g)", None),
    "cuivre":    ("Cuivre (mg 100 g)", None),
    "fer":       ("Fer (mg 100 g)", None),
    "iode":      ("Iode (µg 100 g)", None),
    "magnesium": ("Magnésium (mg 100 g)", None),
    "manganese": ("Manganèse (mg 100 g)", None),
    "phosphore": ("Phosphore (mg 100 g)", None),
    "potassium": ("Potassium (mg 100 g)", None),
    "selenium":  ("Sélénium (µg 100 g)", None),
    "sodium":    ("Sodium (mg 100 g)", None),
    "zinc":      ("Zinc (mg 100 g)", None),
}
K2 = "Vitamine K2 (µg 100 g)"


def norm_header(h):
    return re.sub(r"\s+", " ", (h or "").replace("\n", " ")).strip()


def parse(cell):
    """Retourne ('n', valeur) | ('m', None) | ('t', 0) | ('lt', x)."""
    if cell is None:
        return ("m", None)
    if isinstance(cell, (int, float)):
        return ("n", float(cell))
    s = str(cell).strip().replace("\n", " ").replace(",", ".")
    if s in ("", "-"):
        return ("m", None)
    if s.lower().startswith("tra"):
        return ("t", 0.0)
    if s.startswith("<"):
        return ("lt", float(s[1:].strip()))
    return ("n", float(s))


def fmt(x):
    x = round(x, 4)
    return int(x) if x == int(x) else x


def encode(kind, v):
    if kind == "n":
        return fmt(v)
    if kind == "m":
        return None
    if kind == "t":
        return "t"
    if kind == "lt":
        return "<" + str(fmt(v))
    if kind == "p":
        return "~" + str(fmt(v))


def combine(parts):
    """Combine des composants (kind, valeur*coef). Partiel si certains manquent."""
    known = [p for p in parts if p[0] != "m"]
    if not known:
        return ("m", None)
    total = sum(v for k, v in known if k in ("n", "lt"))
    if len(known) < len(parts):
        return ("p", total)
    if all(k == "t" for k, _ in known):
        return ("t", 0.0)
    if all(k in ("t", "lt") for k, _ in known):
        return ("lt", total)
    return ("n", total)


def main(src, dst):
    ws = openpyxl.load_workbook(src, read_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    idx = {norm_header(h): i for i, h in enumerate(next(rows))}
    groups, gindex, foods = [], {}, []
    for r in rows:
        code, name = r[idx["alim_code"]], r[idx["alim_nom_fr"]]
        if not code or not name:
            continue
        g = f'{r[idx["alim_grp_nom_fr"]] or ""}|{r[idx["alim_ssgrp_nom_fr"]] or ""}|{r[idx["alim_ssssgrp_nom_fr"]] or ""}'
        if g not in gindex:
            gindex[g] = len(groups)
            groups.append(g)
        vals = []
        for nid, (col, backup) in NUTRIMENTS.items():
            kind, v = parse(r[idx[col]])
            if kind == "m" and backup:
                kind, v = combine([(lambda k_v: (k_v[0], (k_v[1] or 0) * coef))(parse(r[idx[c]])) for c, coef in backup])
            if nid == "vitK" and kind in ("n", "lt", "p"):
                k2, v2 = parse(r[idx[K2]])
                if k2 == "n":
                    v += v2
            vals.append(encode(kind, v))
        foods.append([str(code), str(name).strip(), gindex[g]] + vals)
    out = {
        "source": "Anses. 2025. Table de composition nutritionnelle des aliments Ciqual",
        "nutriments": list(NUTRIMENTS.keys()),
        "groupes": groups,
        "aliments": foods,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(foods)} aliments, {len(groups)} groupes -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
