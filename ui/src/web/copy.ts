import type { Target } from '../target-types';

/** Where the web reads differently from the desktop: the server and the remote PC instead of "this computer". */
export const webCopy: Target['copy'] = {
  fr: {
    'home.reading': 'Le serveur repère les noms, adresses et numéros…',
    'doc.waitingTitle': 'L’ordinateur du modèle est éteint',
    'doc.waitingBody':
      'Le modèle qui relit les documents tourne sur un ordinateur relié au serveur, éteint pour le moment. Ce document sera analysé dès son retour; vous pouvez quitter cette page.',
    'doc.pickModel': 'Voir les Réglages',
  },
  en: {
    'home.reading': 'The server is finding names, addresses and numbers…',
    'doc.waitingTitle': 'The model’s PC is off',
    'doc.waitingBody': 'The model that reads documents again runs on a PC linked to the server, which is off for now. This document will be analyzed once it’s back; you can leave this page.',
    'doc.pickModel': 'Open Settings',
  },
};
