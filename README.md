# Mes apports

Journal alimentaire et suivi des vitamines, minéraux et macronutriments. C'est une web app installable (PWA) : elle tourne dans le navigateur, fonctionne hors ligne et garde les données sur chaque appareil (IndexedDB).

## Mettre l'app en ligne (5 minutes, gratuit)

L'app doit être servie en HTTPS. Un double-clic sur `index.html` ne suffit pas, car le navigateur bloque alors la lecture des données.

1. Va sur **https://app.netlify.com/drop** et crée un compte gratuit.
2. Glisse **le dossier entier** `app alimentation` dans la zone de dépôt.
3. Netlify te donne une adresse du type `https://nom-au-hasard.netlify.app`. Tu peux la renommer dans *Site configuration → Change site name*.

Pour une mise à jour, glisse à nouveau le dossier dans *Deploys* du même site, en ayant d'abord changé `VERSION` dans `sw.js` (par exemple `mes-apports-v2`). Les appareils récupèrent alors la nouvelle version et proposent de recharger.

Pour tester sur le Mac sans mettre en ligne : ouvre le Terminal dans le dossier, lance `python3 -m http.server 8000`, puis va sur http://localhost:8000.

## Installer sur l'iPhone

Ouvre l'adresse dans **Safari**, touche **Partager**, puis **Sur l'écran d'accueil**. C'est important : sans ça, Safari peut effacer les données d'un site non visité pendant quelques jours.

Sur Mac : dans Safari, *Fichier → Ajouter au Dock*. Dans Chrome, l'icône d'installation se trouve dans la barre d'adresse.

## Données et sauvegardes

- Tout est enregistré automatiquement sur l'appareil, à chaque modification.
- Le Mac et l'iPhone ne se synchronisent pas tout seuls. *Réglages → Exporter une sauvegarde* crée un fichier JSON, et *Importer une sauvegarde* sur l'autre appareil le fusionne : les repas absents sont ajoutés, et les repas modifiés plus récemment remplacent les anciens. Les suppressions ne sont pas transmises.
- Un rappel apparaît si aucune sauvegarde n'a été faite depuis 7 jours.

## Comment les jauges sont calculées

Pour chaque nutriment :

1. **Total du jour.** Une valeur manquante, « traces » ou « < x » dans Ciqual compte pour 0. Exception : pour le sel, les sucres et les AG saturés, « < x » compte pour x, afin de ne pas masquer un excès.
2. **Plafond.** L'apport d'un jour est plafonné à 150 % de la référence (réglable), pour qu'un gros apport ponctuel ne compense pas les jours sans. Il n'y a pas de plafond pour l'énergie, le sel, les sucres et les AG saturés.
3. **Moyenne pondérée** sur 60 jours, avec un poids de 0,5^(âge en jours / demi-vie). Les jours sans saisie, y compris ceux d'avant le premier lancement, comptent pour 0.
   Demi-vies par défaut : macronutriments 1,5 j ; vitamines C, B1, B2, B3, B5, B6, B9 : 3 j ; vitamines A, D, E, K, B12 et minéraux : 10 j ; sel, sucres, AG saturés : 1,5 j.
4. **Journée en cours.** Elle n'est pas terminée, donc elle ne compte que si elle fait monter la jauge. Sinon, toutes les jauges baisseraient chaque matin avant le premier repas. Pour le sel, les sucres et les AG saturés, elle compte toujours.
5. **Couleurs.** Rouge sous 50 %, orange de 50 à 90 %, vert à partir de 90 %. Violet signale un dépassement : énergie au-delà de 110 % du besoin, ou nutriment à limiter au-delà de 100 % de la limite.
6. **Icône en pointillés.** Elle apparaît quand plus d'un quart des quantités récemment consommées n'ont pas de valeur dans Ciqual pour ce nutriment : la jauge est alors probablement sous-estimée.

Références : ANSES 2021 (vitamines et minéraux, adultes) et ANSES pour les macronutriments. Le besoin énergétique est estimé par la formule de Schofield × le niveau d'activité. Le détail de chaque nutriment s'affiche en touchant sa jauge.

Ces jauges sont une estimation indicative, pas un diagnostic.

## Format d'import d'un aliment

*Réglages → Importer un aliment* accepte un fichier ou un texte collé :

```json
{
  "format": "mes-apports-aliment",
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
    "unites": { "portion": 80, "unite": 125 }
  }]
}
```

- `pour_100g` : valeurs pour 100 g. Clés possibles : `energie` (kcal), `proteines`, `glucides`, `lipides`, `sucres`, `fibres`, `ags`, `sel` (g) ; `vitA`, `vitD`, `vitK`, `vitB9`, `vitB12`, `iode`, `selenium` (µg) ; `vitB1`, `vitB2`, `vitB3`, `vitB5`, `vitB6`, `vitC`, `vitE`, `calcium`, `cuivre`, `fer`, `magnesium`, `manganese`, `phosphore`, `potassium`, `sodium`, `zinc` (mg).
- `ciqual_ref` : code Ciqual de l'aliment le plus proche. Les nutriments absents de l'étiquette reprennent ses valeurs au lieu de compter pour 0.
- `source` : `etiquette`, `ciqual` ou `manuel`. Un objet `sources` permet aussi de préciser la source nutriment par nutriment.
- `unites` : poids en grammes de `cas` (cuillère à soupe), `cac` (cuillère à café), `unite` ou `portion`.
- Un aliment qui a le même `code_barres` qu'un aliment déjà importé le remplace.

## Mettre à jour la table Ciqual

```
pip install openpyxl
python3 outils/convertir_ciqual.py Table_Ciqual_2025_FR.xlsx data/ciqual.json
```

## Fichiers

- `index.html`, `styles.css` : interface
- `js/app.js` : écran et interactions
- `js/model.js` : calcul des apports et des jauges
- `js/nutrients.js` : liste des nutriments, références ANSES, besoin énergétique
- `js/foods.js` : base d'aliments, recherche, unités
- `js/db.js` : stockage local
- `sw.js`, `manifest.webmanifest`, `icons/` : hors ligne et installation
- `data/ciqual.json` : table Ciqual 2025 convertie

Source des données : Anses. 2025. Table de composition nutritionnelle des aliments Ciqual (Licence Ouverte).
