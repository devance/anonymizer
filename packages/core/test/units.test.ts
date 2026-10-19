import { describe, expect, it } from 'vitest';
import {
  applyMatches,
  detectRegex,
  findAmounts,
  findDates,
  findMatches,
  fold,
  foldWithMap,
  isLocality,
  matchCase,
  parseAddress,
  parsePersonName,
  rankProjects,
  renderAmount,
  renderDate,
  reshapeAlnum,
  reshapeDigits,
  substitutePerson,
  type Entity,
} from '../src';

describe('fold', () => {
  it('ignores case, accents, hyphens and apostrophe style', () => {
    expect(fold('Marie-Ève  CÔTÉ')).toBe('marie eve cote');
    expect(fold('l’Érablière')).toBe("l'erabliere");
    expect(fold('Cœur')).toBe('coeur');
  });

  it('maps folded offsets back to the original', () => {
    const f = foldWithMap('Rue  Côté-Nord');
    const at = f.text.indexOf('cote');
    expect(f.starts[at]).toBe(5);
  });

  it('matches case', () => {
    expect(matchCase('TREMBLAY', 'Gagnon')).toBe('GAGNON');
    expect(matchCase('tremblay', 'Gagnon')).toBe('gagnon');
    expect(matchCase('Tremblay', 'Gagnon')).toBe('Gagnon');
  });
});

describe('dates', () => {
  it('finds French and English dates and re-renders in the same style', () => {
    const hits = findDates('né le 1er mars 1984, signed March 3rd, 2020, échéance 2026-12-01 et 05/04/1990');
    expect(hits.map((h) => h.candidates[0]!.iso)).toEqual(['1984-03-01', '2020-03-03', '2026-12-01', '1990-04-05']);
    expect(hits[3]!.candidates).toHaveLength(2);
    expect(renderDate('1984-06-17', hits[0]!.candidates[0]!.format)).toBe('17 juin 1984');
    expect(renderDate('1984-06-01', hits[0]!.candidates[0]!.format)).toBe('1er juin 1984');
    expect(renderDate('2020-06-22', hits[1]!.candidates[0]!.format)).toBe('June 22nd, 2020');
    expect(renderDate('1990-11-09', hits[3]!.candidates[0]!.format)).toBe('09/11/1990');
  });
});

describe('amounts', () => {
  it('parses both conventions', () => {
    const hits = findAmounts('prime de 1 284,00 $ ou $1,284.00 ou 250 000 $');
    expect(hits.map((h) => h.value)).toEqual([1284, 1284, 250000]);
    expect(renderAmount(1400.5, hits[0]!.format)).toBe('1 400,50 $');
    expect(renderAmount(1400.5, hits[1]!.format)).toBe('$1,400.50');
  });
});

describe('regex detection', () => {
  it('catches structured identifiers', () => {
    const types = detectRegex('NAS : 046 454 286, tél. 514-555-1234, H2X 1Y4, a.b@c.example, carte 4111 1111 1111 1111, né le 3 mai 1970').map((d) => d.type);
    expect(types).toEqual(['sin', 'phone', 'postal_code', 'email', 'card_number', 'dob']);
  });

  it('finds French civic addresses, rural ones included', () => {
    const text =
      'Caution : 1180, rang Saint-Félix, Saint-Narcisse (Québec) G0X 2Y0. Bureau au 45 rue Notre-Dame Est. ' +
      'Ancienne adresse : 2215, boulevard des Forges, app. 302; 12A, chemin de l’Église. 3390 rue Papineau G8Z 3M6';
    expect(detectRegex(text).filter((d) => d.type === 'address').map((d) => d.text)).toEqual([
      '1180, rang Saint-Félix',
      '45 rue Notre-Dame Est',
      '2215, boulevard des Forges',
      '12A, chemin de l’Église',
      '3390 rue Papineau',
    ]);
  });

  it('leaves street words without a civic number or a proper name alone', () => {
    const text = 'Article 12, chemin de fer. Le 3 rue. En 2021, route 132. Voir la rue Principale.';
    expect(detectRegex(text).filter((d) => d.type === 'address')).toHaveLength(0);
  });

  it('skips unformatted nine-digit numbers without SIN context', () => {
    expect(detectRegex('Facture 046454286').filter((d) => d.type === 'sin')).toHaveLength(0);
  });

  it('takes a number labelled NAS even when its check digit is off', () => {
    expect(detectRegex('NAS (aux fins de la paie) : 527 384 912').map((d) => [d.type, d.text])).toEqual([['sin', '527 384 912']]);
  });

  it('finds reference numbers by shape or label, and leaves amounts, dates and years alone', () => {
    const text =
      'Police HAB-48210937, VIN 1FUJHHDR8NLNA2849, permis G3205-041186-04, SCHL 7731-0094-26, compte 0418827, ' +
      'matricule 118842, numéro d’employé U-2207, lot 5 912 448, plaque AY 74215. ' +
      'Montant 42 180,00 $, le 2026-08-29, en 2019, à 14h30, 1 425,00 $.';
    expect(detectRegex(text).filter((d) => d.type === 'id_number').map((d) => d.text)).toEqual([
      'HAB-48210937',
      '1FUJHHDR8NLNA2849',
      'G3205-041186-04',
      '7731-0094-26',
      '0418827',
      '118842',
      'U-2207',
      '5 912 448',
      'AY 74215',
    ]);
  });

  it('reads dates under a birth date column as dates of birth, and OCR misreads too', () => {
    const table = ['Rôle      Nom                 Naissance    Signé le', 'Emp. 1    Véronique Lamy      1986-11-04   2026-08-21'].join('\n');
    expect(detectRegex(table).filter((d) => d.type === 'dob').map((d) => d.text)).toEqual(['1986-11-04']);
    expect(detectRegex('Ëtienne Lebeau, né le l5 janvier 1975, domicilié').filter((d) => d.type === 'dob').map((d) => d.text)).toEqual(['l5 janvier 1975']);
  });

  it('finds English and capitalised street addresses', () => {
    const text = 'at 4388 Sherbrooke Street West, 2217 Maple Grove Avenue and 1186 CONCESSION ROAD 7; 218 RANG SAINT-JOSEPH. Section 3 of the Highway Act.';
    expect(detectRegex(text).filter((d) => d.type === 'address').map((d) => d.text)).toEqual([
      '4388 Sherbrooke Street West',
      '2217 Maple Grove Avenue',
      '1186 CONCESSION ROAD 7',
      '218 RANG SAINT-JOSEPH',
    ]);
  });
});

describe('parsing', () => {
  it('parses names in several orders', () => {
    expect(parsePersonName('M. Jean-Pierre Tremblay')).toEqual({ first: 'Jean-Pierre', last: 'Tremblay' });
    expect(parsePersonName('Tremblay, Jean')).toEqual({ first: 'Jean', last: 'Tremblay' });
    expect(parsePersonName('TREMBLAY Jean')).toEqual({ first: 'Jean', last: 'Tremblay'.toUpperCase() });
  });

  it('tells a lone city from an address', () => {
    for (const t of ['MILLBROOK, ON', 'Saint-Narcisse (Québec)', 'Côte-Saint-Luc', 'Trois-Rivières']) expect(isLocality(t)).toBe(true);
    for (const t of ['rue Principale', 'King Street East', '1186 CONCESSION ROAD 7', 'C.P. 1234, Laval', 'boulevard Saint-Laurent']) expect(isLocality(t)).toBe(false);
  });

  it('keeps the direction out of the street name', () => {
    expect(parseAddress('4388 Sherbrooke Street West, apartment 6')).toEqual({ civic: '4388', streetType: 'Street', streetName: 'Sherbrooke' });
    expect(parseAddress('45, rue Notre-Dame Est')).toEqual({ civic: '45', streetType: 'rue', streetName: 'Notre-Dame' });
  });

  it('parses French and English addresses', () => {
    expect(parseAddress('123, rue des Érables, Laval')).toEqual({ civic: '123', streetType: 'rue', particle: 'des', streetName: 'Érables' });
    expect(parseAddress("45 boul. de l'Église")).toEqual({ civic: '45', streetType: 'boul.', particle: "de l'", streetName: 'Église' });
    expect(parseAddress('456 Maple Street')).toEqual({ civic: '456', streetType: 'Street', streetName: 'Maple' });
  });
});

describe('reshape', () => {
  it('keeps separators and casing', () => {
    expect(reshapeAlnum('ab-123 456', 'QX987321')).toBe('qx-987 321');
    expect(reshapeDigits('+1 (514) 555-1234', '4385550142')).toBe('+1 (438) 555-0142');
  });
});

describe('substitutePerson', () => {
  const src = { first: 'Jean-Pierre', last: 'Tremblay' };
  const dst = { first: 'Marc-André', last: 'Gagnier' };
  it('keeps the mention shape', () => {
    expect(substitutePerson('TREMBLAY, Jean-Pierre', src, dst, 'Marc-André Gagnier')).toBe('GAGNIER, Marc-André');
    expect(substitutePerson('J.-P. Tremblay', src, dst, 'Marc-André Gagnier')).toBe('M.-A. Gagnier');
    expect(substitutePerson('the Tremblays', src, dst, 'Marc-André Gagnier')).toBe('the Gagniers');
  });
});

function person(id: string, real: [string, string], fake: [string, string], projectId?: string): Entity {
  return {
    id,
    type: 'person',
    real: { text: real.join(' '), person: { first: real[0], last: real[1] } },
    fake: { text: fake.join(' '), person: { first: fake[0], last: fake[1] } },
    enabled: true,
    projectId,
  };
}

describe('findMatches', () => {
  it('does not touch a name inside a hyphenated place', () => {
    const e = person('a', ['Jean', 'Tremblay'], ['Luc', 'Gagnier']);
    const text = 'Jean Tremblay habite à Saint-Jean. Jean est content.';
    const out = applyMatches(text, findMatches(text, [e], 'anonymize'));
    expect(out).toBe('Luc Gagnier habite à Saint-Jean. Luc est content.');
  });

  it('marks shared surnames as low confidence', () => {
    const a = person('a', ['Jean', 'Tremblay'], ['Luc', 'Gagnier']);
    const b = person('b', ['Marie', 'Tremblay'], ['Sophie', 'Lefort']);
    const m = findMatches('Bonjour M. Tremblay', [a, b], 'anonymize');
    expect(m).toHaveLength(1);
    expect(m[0]!.confidence).toBe('low');
  });

  it('restores a lone first name only when the person is also named in full', () => {
    const a = person('a', ['Jean', 'Tremblay'], ['Luc', 'Gagnier']);
    expect(findMatches('Salut Luc', [a], 'restore')[0]!.confidence).toBe('low');
    expect(findMatches('Luc Gagnier. Salut Luc', [a], 'restore').every((m) => m.confidence === 'high')).toBe(true);
  });

  it('matches a translated address by civic number and street name', () => {
    const e: Entity = {
      id: 'addr',
      type: 'address',
      real: { text: '1842, rue des Érables', address: { civic: '1842', streetType: 'rue', particle: 'des', streetName: 'Érables' } },
      fake: { text: '5307, rue des Bouleaux', address: { civic: '5307', streetType: 'rue', particle: 'des', streetName: 'Bouleaux' } },
      enabled: true,
    };
    const text = 'They live at 5307 Bouleaux Street, near rue des Bouleaux.';
    expect(applyMatches(text, findMatches(text, [e], 'restore'))).toBe('They live at 1842 Érables Street, near rue des Érables.');
  });

  it('ranks projects and keeps lone names to the preferred one', () => {
    const a = person('a', ['Jean', 'Tremblay'], ['Luc', 'Gagnier'], 'house');
    const b = person('b', ['Paul', 'Roy'], ['Hugo', 'Gagnier'], 'car');
    const text = 'Luc Gagnier, Luc Gagnier et M. Gagnier';
    const all = findMatches(text, [a, b], 'restore');
    expect(rankProjects(all)[0]).toEqual({ projectId: 'house', hits: 2 });
    const routed = findMatches(text, [a, b], 'restore', { preferProject: 'house' });
    expect(applyMatches(text, routed)).toBe('Jean Tremblay, Jean Tremblay et M. Tremblay');
  });

  it('does not match a phone inside a longer number', () => {
    const e: Entity = { id: 'p', type: 'phone', real: { text: '514-555-1234' }, fake: { text: '514-555-0101' }, enabled: true };
    expect(findMatches('ref 9514555123477', [e], 'anonymize')).toHaveLength(0);
    expect(applyMatches('1-514-555-1234', findMatches('1-514-555-1234', [e], 'anonymize'))).toBe('1-514-555-0101');
  });
});

describe('fuzzyLeaks', () => {
  it('finds real values OCR misread by a letter, and nothing else', async () => {
    const { fuzzyLeaks } = await import('../src');
    const e: Entity = {
      id: 'p',
      type: 'person',
      real: { text: 'Jean Tremblay', person: { first: 'Jean', last: 'Tremblay' } },
      fake: { text: 'Luc Gagnier', person: { first: 'Luc', last: 'Gagnier' } },
      enabled: true,
    };
    const id: Entity = { id: 'i', type: 'id_number', real: { text: 'HAB-48210937' }, fake: { text: 'HAB-77882353' }, enabled: true };
    expect(fuzzyLeaks('Signé : M. Tremb1ay', [e, id])).toEqual(['p']);
    expect(fuzzyLeaks('Police HA8-48210937', [e, id])).toEqual(['i']);
    expect(fuzzyLeaks('Luc Gagnier, police HAB-77882353', [e, id])).toEqual([]);
  });
});

describe('replacementFor', () => {
  it('maps a misspelled lone name to the matching part', async () => {
    const { replacementFor } = await import('../src');
    const e = person('a', ['Jean-François', 'Tremblay'], ['Pierre-Luc', 'Simard']);
    expect(replacementFor(e, 'Simmard', 'restore')).toBe('Tremblay');
    expect(replacementFor(e, 'SIMMARD', 'restore')).toBe('TREMBLAY');
    expect(replacementFor(e, 'Pierre-Luc Simard', 'restore')).toBe('Jean-François Tremblay');
  });
});
