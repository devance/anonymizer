/**
 * Street-name pools, grouped by the article French puts in front of them so a
 * fake keeps the real address's grammar: "rue des Érables" becomes "rue des
 * Bouleaux", never "rue des Ruisseau".
 */
export const STREETS = {
  des: [
    'Bouleaux', 'Hérons', 'Mélèzes', 'Pruches', 'Saules', 'Tilleuls', 'Trembles', 'Cèdres', 'Épinettes', 'Peupliers',
    'Ormes', 'Noyers', 'Merisiers', 'Cerisiers', 'Pommiers', 'Lilas', 'Pivoines', 'Marguerites', 'Hirondelles', 'Mésanges',
    'Geais', 'Cardinaux', 'Huards', 'Outardes', 'Castors', 'Chevreuils', 'Orignaux', 'Lièvres', 'Renards', 'Loutres',
    'Sources', 'Cascades', 'Falaises', 'Prés', 'Vergers', 'Moissons', 'Semailles', 'Glaïeuls', 'Bleuets', 'Fougères',
    'Quatre-Vents', 'Pionniers', 'Draveurs', 'Bâtisseurs', 'Voyageurs', 'Seigneurs',
  ],
  du: [
    'Ruisseau', 'Coteau', 'Vallon', 'Boisé', 'Plateau', 'Rocher', 'Moulin', 'Quai', 'Domaine', 'Manoir',
    'Verger', 'Sentier', 'Belvédère', 'Bocage', 'Ravin', 'Canton', 'Faubourg', 'Hameau', 'Bassin', 'Carrefour',
    'Merle', 'Pinson', 'Roitelet', 'Tisserand', 'Forgeron', 'Meunier', 'Cordonnier',
  ],
  'de la': [
    'Colline', 'Rivière', 'Prairie', 'Savane', 'Seigneurie', 'Clairière', 'Pinède', 'Futaie', 'Chênaie', 'Sapinière',
    'Cédrière', 'Tourbière', 'Grève', 'Pointe', 'Fabrique', 'Tannerie', 'Commune', 'Corniche', 'Garenne', 'Perdrix',
    'Fauvette', 'Sarcelle',
  ],
  "de l'": [
    'Érablière', 'Anse', 'Étang', 'Orée', 'Escarpement', 'Aqueduc', 'Arpent', 'Oasis', 'Estacade', 'Alouette',
    'Épervier',
  ],
  "d'": ['Avaugour', 'Argenson', 'Aubigny', 'Ormesson', 'Estrées', 'Aiguillon'],
  de: ['Montigny', 'Courcelle', 'Lotbinière', 'Repentigny', 'Vaudreuil', 'Frontenac', 'Beauharnois', 'Contrecoeur', 'Varennes', 'Gentilly'],
  none: [
    'Saint-Ambroise', 'Saint-Cyrille', 'Saint-Édouard', 'Saint-Eugène', 'Saint-Firmin', 'Saint-Gédéon', 'Saint-Hilarion',
    'Saint-Isidore', 'Saint-Léandre', 'Saint-Médard', 'Saint-Norbert', 'Saint-Odilon', 'Saint-Prosper', 'Saint-Sylvère',
    'Sainte-Adèle', 'Sainte-Brigide', 'Sainte-Clotilde', 'Sainte-Émélie', 'Sainte-Hénédine', 'Champêtre', 'Riveraine',
    'Panoramique', 'Forestière', 'Boréale',
  ],
  en: [
    'Birchwood', 'Cedarbrook', 'Elmhurst', 'Fairview', 'Glenwood', 'Hillcrest', 'Kingsway', 'Lakeview', 'Maplewood', 'Meadowbrook',
    'Oakridge', 'Parkview', 'Pinecrest', 'Ravenswood', 'Riverside', 'Rosewood', 'Sherwood', 'Springfield', 'Sunnyside', 'Willowdale',
    'Brookside', 'Clearwater', 'Edgewood', 'Foxhollow', 'Greenfield', 'Highland', 'Ironwood', 'Juniper',
  ],
} as const;

export type StreetClass = keyof typeof STREETS;

/** Folded street-type words, French and English, as they appear before or after the name. */
export const STREET_TYPES = [
  'rue', 'avenue', 'av', 'ave', 'boulevard', 'boul', 'blvd', 'bd', 'chemin', 'ch', 'route', 'rte', 'rang', 'place', 'pl',
  'montee', 'cote', 'croissant', 'terrasse', 'impasse', 'allee', 'promenade', 'carre', 'square', 'rond point', 'autoroute',
  'street', 'st', 'road', 'rd', 'drive', 'dr', 'lane', 'ln', 'way', 'court', 'ct', 'circle', 'cir', 'crescent', 'cres',
  'parkway', 'pkwy', 'highway', 'hwy', 'terrace', 'ter', 'boulevard',
];

export const EN_STREET_TYPES = new Set([
  'street', 'st', 'road', 'rd', 'drive', 'dr', 'lane', 'ln', 'way', 'court', 'ct', 'circle', 'cir', 'crescent', 'cres',
  'parkway', 'pkwy', 'highway', 'hwy', 'terrace', 'ter', 'ave',
]);

export const PARTICLES = ['de la', "de l'", 'des', 'du', 'de', "d'", "l'", 'la', 'le', 'les', 'the', 'of'];

export const ORG_CORES = [
  'Valmont', 'Mirabeau', 'Bellerive', 'Norval', 'Clairval', 'Rivemont', 'Hautrive', 'Beauval', 'Florimont', 'Belcourt',
  'Vertbois', 'Brisemont', 'Grandval', 'Roquemont', 'Sablon', 'Boisfranc', 'Montverdun', 'Lysandre', 'Orvault', 'Castelnoir',
];

/** Leading words that say what kind of organization it is; kept so the fake still reads as an insurer, a bank… */
export const ORG_KIND_WORDS = [
  'assurances', 'assurance', 'banque', 'caisse', 'groupe', 'cabinet', 'services', 'societe', 'clinique', 'hopital',
  'centre', 'notaires', 'immeubles', 'courtage', 'fiducie', 'gestion', 'constructions', 'insurance', 'bank', 'group',
  'law', 'clinic', 'hospital', 'trust', 'realty', 'capital', 'financial', 'financiere', 'mutuelle', 'credit',
];

export const ORG_SUFFIXES = [
  'inc', 'inc.', 'ltee', 'ltee.', 'limitee', 'ltd', 'ltd.', 'limited', 'corp', 'corp.', 'corporation', 'llp', 's.e.n.c.r.l.',
  'senc', 's.e.n.c.', 'sa', 'co', 'co.', 'cie', 'compagnie', 'company',
];
