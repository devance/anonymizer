/**
 * Pools for fake names. Surnames that are also ordinary words (Roy, Blanc,
 * Paradis, Lafleur, Champagne…), common first names (Richard, Simon…) or
 * famous people are left out: a fake that reads as a word or a celebrity can't
 * be told apart from real text when an AI's document comes back. The ten most
 * common Québec surnames are out too, since they're the likeliest to belong to
 * a real person in the same project.
 */

export const FR_SURNAMES = [
  'Ouellet', 'Pelletier', 'Bélanger', 'Bergeron', 'Paquette', 'Girard', 'Simard', 'Boucher', 'Caron', 'Beaulieu',
  'Cloutier', 'Dubé', 'Poirier', 'Fournier', 'Lapointe', 'Leclerc', 'Lefebvre', 'Poulin', 'Thibault', 'Nadeau',
  'Landry', 'Martel', 'Bédard', 'Lessard', 'Bernier', 'Michaud', 'Hébert', 'Couture', 'Turcotte', 'Lachance',
  'Blais', 'Gosselin', 'Savard', 'Proulx', 'Beaudoin', 'Demers', 'Perron', 'Boudreau', 'Charbonneau', 'Allard',
  'Mercier', 'Boivin', 'Vachon', 'Labbé', 'Leduc', 'Dufour', 'Lavallée', 'Brassard', 'Dupuis', 'Gaudreault',
  'Guay', 'Lemay', 'Langlois', 'Vaillancourt', 'Robitaille', 'Rioux', 'Gingras', 'Daigle', 'Larouche', 'Larivière',
  'Bélisle', 'Létourneau', 'Picard', 'Thériault', 'Massé', 'Desrosiers', 'Doyon', 'Grondin', 'Patry', 'Bisson',
  'Tessier', 'Brunet', 'Laflamme', 'Cyr', 'Normandin', 'Asselin', 'Laplante', 'Boisvert', 'Rheault', 'Chabot',
  'Lacasse', 'Corriveau', 'Lacombe', 'Paré', 'Laberge', 'Fréchette', 'Trudel', 'Delisle', 'Arsenault', 'Talbot',
  'Duchesne', 'Fecteau', 'Veilleux', 'Trépanier', 'Rochon', 'Sirois', 'Paquin', 'Ménard', 'Lalonde', 'Lebel',
  'Laroche', 'Beauchamp', 'Dumont', 'Lamontagne', 'Brisson', 'Faucher', 'Bolduc', 'Goulet', 'Huard', 'Hamel',
  'Lemire', 'Bergevin', 'Duguay', 'Croteau', 'Messier', 'Sénécal', 'Gendron', 'Bilodeau', 'Duval', 'Langevin',
  'Beaupré', 'Gauvin', 'Charron', 'Labrecque', 'Désilets', 'Jobin', 'Lauzon', 'Marcotte', 'Nolet', 'Ricard',
  'St-Onge', 'Thivierge', 'Vézina', 'Plourde', 'Pouliot', 'Soucy', 'Tardif', 'Tanguay', 'Viens', 'Lacoursière',
  'Beauregard', 'Boisclair', 'Chartier', 'Desbiens', 'Drouin', 'Dussault', 'Filion', 'Gamache', 'Garneau', 'Hudon',
  'Juneau', 'Lamarche', 'Landreville', 'Laurin', 'Lepage', 'Lussier', 'Mailhot', 'Monette', 'Ouimet', 'Pépin',
  'Quintal', 'Riopel', 'Sauvé', 'Séguin', 'Tétreault', 'Thibodeau', 'Vallières', 'Vigneault', 'Brochu', 'Cantin',
  'Dallaire', 'Dagenais', 'Deschênes', 'Fafard', 'Gagnier', 'Guérin', 'Jutras', 'Lanctôt', 'Larocque', 'Malenfant',
  'Mongeau', 'Ouellette', 'Pilon', 'Poitras', 'Rivard', 'Rondeau', 'Saucier', 'Thibeault', 'Turgeon', 'Bérubé',
  'Bouffard', 'Caouette', 'Chouinard', 'Dumais', 'Émond', 'Gélinas', 'Jolicoeur', 'Lachapelle', 'Lajeunesse', 'Lapierre',
  'Lemelin', 'Mainville', 'Nantel', 'Pinard', 'Prévost', 'Rancourt', 'Sabourin', 'Sansoucy', 'Tousignant', 'Villeneuve',
  'Aubin', 'Audet', 'Babin', 'Barrette', 'Beaulne', 'Bellemare', 'Bissonnette', 'Blanchette', 'Bonin', 'Boudreault',
  'Bourassa', 'Brault', 'Brière', 'Brousseau', 'Cadieux', 'Campeau', 'Castonguay', 'Chamberland', 'Charland', 'Chénier',
  'Courchesne', 'Courtemanche', 'Cousineau', 'Crépeau', 'Daoust', 'Darveau', 'Desautels', 'Deslauriers', 'Desmarais', 'Diotte',
  'Doiron', 'Ducharme', 'Durocher', 'Fiset', 'Fleurant', 'Fortier', 'Gadbois', 'Giguère', 'Godbout', 'Goyette',
  'Groleau', 'Guilbault', 'Hamelin', 'Hétu', 'Houle', 'Jodoin', 'Joyal', 'Labonté', 'Lacerte', 'Lafond',
  'Laganière', 'Lalancette', 'Lamarre', 'Lamoureux', 'Lanoue', 'Laprise', 'Larue', 'Lavigne', 'Leboeuf', 'Lecours',
  'Lefort', 'Lemaire', 'Lépine', 'Leroux', 'Lizotte', 'Loiselle', 'Mallette', 'Marleau', 'Moisan', 'Morency',
  'Nault', 'Pellerin', 'Perreault', 'Petitclerc', 'Pichette', 'Primeau', 'Rainville', 'Robillard', 'Roussel', 'Sanschagrin',
  'Savoie', 'Sévigny', 'Simoneau', 'Taillon', 'Thiffault', 'Trottier', 'Vandal', 'Verreault', 'Vincelette', 'Viau',
];

export const EN_SURNAMES = [
  'Abbott', 'Ainsworth', 'Atkinson', 'Bancroft', 'Barlow', 'Beckett', 'Bellamy', 'Blackwood', 'Bradshaw', 'Brennan',
  'Calloway', 'Carmichael', 'Callahan', 'Davenport', 'Delaney', 'Donnelly', 'Doyle', 'Drummond', 'Fairbanks', 'Farrell',
  'Fitzgerald', 'Fletcher', 'Gallagher', 'Garrison', 'Hargrove', 'Hartley', 'Hawthorne', 'Hennessy', 'Holloway', 'Kavanagh',
  'Keegan', 'Kendrick', 'Kingsley', 'Langford', 'Lockhart', 'MacAllister', 'MacKinnon', 'MacLeod', 'Mahoney', 'McBride',
  'McCormick', 'McGregor', 'McKenna', 'Merriweather', 'Montgomery', 'Mulligan', 'Nolan', "O'Connell", "O'Hara", "O'Sullivan",
  'Pemberton', 'Prescott', 'Quinlan', 'Radcliffe', 'Redmond', 'Rutherford', 'Sinclair', 'Stanton', 'Sutherland', 'Thornton',
  'Underwood', 'Wakefield', 'Whitaker', 'Whitmore', 'Winslow', 'Yardley', 'Ashby', 'Babcock', 'Brewster', 'Caldwell',
  'Crawley', 'Dalton', 'Ellison', 'Forsythe', 'Gilmore', 'Harlow', 'Hollister', 'Ingram', 'Kirkland', 'Lowell',
  'Mercer', 'Norwood', 'Osborne', 'Pritchard', 'Ramsey', 'Sheridan', 'Thatcher', 'Townsend', 'Wexler', 'Whitfield',
  'Ackerman', 'Brannigan', 'Corrigan', 'Delgado', 'Ferreira', 'Kowalski', 'Lombardi', 'Moretti', 'Nakamura', 'Novak',
  'Petrov', 'Romano', 'Santoro', 'Sorensen', 'Tanaka', 'Varga', 'Zielinski',
];

export const FIRST_NAMES = {
  fr: {
    f: [
      'Amélie', 'Anne-Marie', 'Annie', 'Audrey', 'Catherine', 'Chantal', 'Claudine', 'Danielle', 'Élise', 'Émilie',
      'Évelyne', 'Florence', 'Geneviève', 'Isabelle', 'Josée', 'Julie', 'Karine', 'Laurence', 'Lucie', 'Manon',
      'Marie-Claude', 'Marie-Josée', 'Mélanie', 'Mireille', 'Monique', 'Nathalie', 'Pascale', 'Rachel', 'Roxanne', 'Sandrine',
      'Sophie', 'Stéphanie', 'Sylvie', 'Valérie', 'Véronique', 'Ariane', 'Béatrice', 'Camille', 'Chloé', 'Clara',
      'Juliette', 'Léa', 'Rosalie', 'Zoé', 'Maude', 'Gabrielle', 'Jacinthe', 'Nicole', 'Diane', 'Francine',
      'Ginette', 'Hélène', 'Johanne', 'Louise', 'Lise', 'Martine', 'Micheline', 'Suzanne', 'Denise', 'Andrée',
      'Brigitte', 'Carole', 'Colette', 'Édith', 'Fanny', 'Gisèle', 'Huguette', 'Jocelyne', 'Lorraine', 'Marjolaine',
      'Myriam', 'Noémie', 'Océane', 'Raphaëlle', 'Solange', 'Thérèse', 'Yolande',
    ],
    m: [
      'Alain', 'André', 'Antoine', 'Benoît', 'Carl', 'Charles', 'Christian', 'Claude', 'Daniel', 'David',
      'Denis', 'Dominic', 'Éric', 'Étienne', 'François', 'Frédéric', 'Gaétan', 'Gilles', 'Guillaume', 'Hugo',
      'Jacques', 'Jean-François', 'Jean-Philippe', 'Jean-Sébastien', 'Jérôme', 'Jocelyn', 'Julien', 'Louis', 'Luc', 'Marc',
      'Marc-André', 'Mathieu', 'Maxime', 'Nicolas', 'Normand', 'Olivier', 'Pascal', 'Patrick', 'Philippe', 'Pierre',
      'Pierre-Luc', 'Réal', 'Réjean', 'Robert', 'Roger', 'Samuel', 'Sébastien', 'Serge', 'Stéphane', 'Sylvain',
      'Yves', 'Alexandre', 'Félix', 'Émile', 'Jacob', 'Léo', 'Raphaël', 'Zachary', 'Mathis', 'Benjamin',
      'Charles-Antoine', 'Xavier', 'Jonathan', 'Kevin', 'Mario', 'Michaël', 'Marcel', 'Gérard', 'Ghislain', 'Clément',
      'Raynald', 'Rémi', 'Rodrigue', 'Yvon',
    ],
  },
  en: {
    f: [
      'Abigail', 'Amanda', 'Ashley', 'Brittany', 'Caroline', 'Charlotte', 'Courtney', 'Emily', 'Emma', 'Erin',
      'Hannah', 'Jennifer', 'Jessica', 'Kaitlyn', 'Kelly', 'Kimberly', 'Laura', 'Lauren', 'Lindsay', 'Megan',
      'Melissa', 'Michelle', 'Natalie', 'Olivia', 'Rebecca', 'Samantha', 'Sarah', 'Stephanie', 'Tara', 'Vanessa',
      'Victoria', 'Allison', 'Jillian', 'Kristen', 'Leah', 'Meredith', 'Shannon',
    ],
    m: [
      'Aaron', 'Adam', 'Andrew', 'Anthony', 'Brandon', 'Brian', 'Bryce', 'Cameron', 'Christopher', 'Colin',
      'Connor', 'Derek', 'Dylan', 'Edward', 'Ethan', 'Evan', 'Gavin', 'Gregory', 'Ian', 'Jason',
      'Jeffrey', 'Jeremy', 'Joel', 'Joshua', 'Justin', 'Keith', 'Kenneth', 'Kyle', 'Liam', 'Logan',
      'Lucas', 'Matthew', 'Nathan', 'Noah', 'Owen', 'Peter', 'Ryan', 'Scott', 'Sean', 'Spencer',
      'Steven', 'Timothy', 'Trevor', 'Tyler',
    ],
  },
} as const;

/** Never used as fakes: the account owner's own names. */
export const NEVER_USE = ['Grenier', 'Gabriel'];
