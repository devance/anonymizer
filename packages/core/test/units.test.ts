import { describe, expect, it } from 'vitest';
import {
  amountShaped,
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
  partOfAmount,
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

  it('tells digits inside an amount or a rate from an identifier', () => {
    const at = (text: string, part: string, from = 0) => {
      const s = text.indexOf(part, from);
      return partOfAmount(text, s, s + part.length);
    };
    expect(at('Total 4827,35 $', '4827')).toBe(true);
    expect(at('Total 4 827,35 $', '4 827')).toBe(true);
    expect(at('7,3318 12,750 13,1186', '3318 12')).toBe(true);
    expect(at('Prix : 900 $', '900')).toBe(true);
    expect(at('Taux 15 %', '15')).toBe(true);
    expect(at('Dossier 4827, voir plus bas', '4827')).toBe(false);
    expect(at('NAS 046 454 286.', '046 454 286')).toBe(false);
    expect(at('Lot 2 418 305, cadastre du Québec', '2 418 305')).toBe(false);
    expect(at('418555,4185550101', '4185550101')).toBe(false);
    for (const v of ['14,625', '7,3318', '50,000', '4 827,35', '1.234,56', '$900', '15 %']) expect(amountShaped(v)).toBe(true);
    for (const v of ['046 454 286', '046.454.286', '2 418 305', 'QX-40817-563', '4827']) expect(amountShaped(v)).toBe(false);
  });

  it('never swaps a known number inside an amount', () => {
    const e = (type: Entity['type'], real: string, fake: string): Entity => ({ id: real, type, real: { text: real }, fake: { text: fake }, enabled: true });
    const text = 'Facture no 4827. Total 4827,35 $ et 4 827,35 $; taux 7,4827. Tél. 418 555-0142, solde 418 555-0142,50 $';
    const out = applyMatches(text, findMatches(text, [e('id_number', '4827', '9163'), e('phone', '418 555-0142', '819 555-0177')], 'anonymize'));
    expect(out).toBe('Facture no 9163. Total 4827,35 $ et 4 827,35 $; taux 7,4827. Tél. 819 555-0177, solde 418 555-0142,50 $');
  });

  it('restores a long fake the AI glued more to, and a mailbox cut short', () => {
    const e = (type: Entity['type'], real: string, fake: string): Entity => ({ id: real, type, real: { text: real }, fake: { text: fake }, enabled: true });
    const ents = [e('id_number', '0412-73390', '6630-18452'), e('email', 'sbouchard@outlook.com', 'lavoie@example.com')];
    const text = 'Compte 6630-18452-217 et (6630-18452). Écrire à lavoie@ ou lavoie@example.com.';
    expect(applyMatches(text, findMatches(text, ents, 'restore'))).toBe('Compte 0412-73390-217 et (0412-73390). Écrire à sbouchard@ ou sbouchard@outlook.com.');
    // Anonymizing, a number glued to a longer one is still someone else's.
    expect(findMatches('Réf. 0412-73390-217', ents, 'anonymize')).toHaveLength(0);
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

  it('finds three-number civic ranges, abbreviations without a dot and a scanned "boui."', () => {
    const text = 'Immeuble au 10-14-16, rue Saint-Louis. Siège : 418, boui. Monseigneur-Plessis; 12 ch Lambert; 8 AV LAURIER.';
    expect(detectRegex(text).filter((d) => d.type === 'address').map((d) => d.text)).toEqual([
      '10-14-16, rue Saint-Louis',
      '418, boui. Monseigneur-Plessis',
      '12 ch Lambert',
      '8 AV LAURIER',
    ]);
  });

  it('leaves street words without a civic number or a proper name alone', () => {
    const text = 'Article 12, chemin de fer. Le 3 rue. En 2021, route 132. Voir la rue Principale.';
    expect(detectRegex(text).filter((d) => d.type === 'address')).toHaveLength(0);
  });

  it('takes an OCR\'d postal code only after the province', () => {
    const of = (t: string) => detectRegex(t).filter((d) => d.type === 'postal_code').map((d) => d.text);
    expect(of('Baie-Saint-Louis (Québec) G0A 284, connu')).toEqual(['G0A 284']);
    expect(of('Montréal, QC H2X 1Y4')).toEqual(['H2X 1Y4']);
    expect(of('Formulaire G0A 284 page 2')).toEqual([]);
  });

  it('takes a small business\'s site, not a public body\'s or a mailbox domain', () => {
    const of = (t: string) => detectRegex(t).filter((d) => d.type === 'other').map((d) => d.text);
    expect(of('Plans : www.arpenteurduval.com, voir aussi https://plansmorin.ca/plans.')).toEqual(['arpenteurduval', 'plansmorin']);
    expect(of('Voir www.revenuquebec.ca, desjardins.com, canada.ca et info@cabinetmorin.com.')).toEqual([]);
  });

  it('takes a cadastre lot with the word after it', () => {
    const ids = (t: string) => detectRegex(t).filter((d) => d.type === 'id_number').map((d) => d.text);
    expect(ids('Immeuble : 5 128 004 cadastre du Québec')).toEqual(['5 128 004']);
    expect(ids('Total 5 128 004 dollars')).toEqual([]);
  });

  it('takes a social profile handle, not a public body\'s', () => {
    const of = (t: string) => detectRegex(t).filter((d) => d.type === 'other').map((d) => d.text);
    expect(of('Suivez-nous : www.facebook.com/fermedupontinc.')).toEqual(['fermedupontinc']);
    expect(of('linkedin.com/in/marie-tremblay-4b2')).toEqual(['marie-tremblay-4b2']);
    expect(of('facebook.com/desjardins')).toEqual([]);
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
      'Montant 42 180,00 $, le 2026-08-29, en 2019, à 14h30, 1 425,00 $, émis 2018-05, exercice 2022-2023, au 20240331, dossier 2021-06.';
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
      '2021-06',
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

  it('replaces a known address a scan garbled, but not a town or a page number', () => {
    const e: Entity = {
      id: 'a',
      type: 'address',
      real: { text: '10-16, rue Saint-Louis', address: { civic: '10-16', streetType: 'rue', streetName: 'Saint-Louis' } },
      fake: { text: '47-53, rue Forestière', address: { civic: '47-53', streetType: 'rue', streetName: 'Forestière' } },
      enabled: true,
    };
    const scan = "situé au 10-1'6~.roe Saint-Lòuis, Baie-Saint-Louis. Voir page 10 Saint-Louis.";
    expect(applyMatches(scan, findMatches(scan, [e], 'anonymize'))).toBe('situé au 47-53 rue Forestière, Baie-Saint-Louis. Voir page 10 Saint-Louis.');
    const d: Entity = {
      id: 'b',
      type: 'address',
      real: { text: "44 ch. de l'Érablière", address: { civic: '44', streetType: 'ch.', particle: "de l'", streetName: 'Érablière' } },
      fake: { text: "23 ch. de l'Arpent", address: { civic: '23', streetType: 'ch.', particle: "de l'", streetName: 'Arpent' } },
      enabled: true,
    };
    const scan2 = "44, chemfn dë /'Érablière Baie-Saint-Louis";
    expect(applyMatches(scan2, findMatches(scan2, [d], 'anonymize'))).toBe("23 ch. de l'Arpent Baie-Saint-Louis");
    expect(findMatches(scan2, [d], 'restore')).toHaveLength(0);
  });

  it('restores a company an AI named without its suffix, and a name it read in a fake email', () => {
    const org: Entity = { id: 'o', type: 'organization', real: { text: 'Marvale inc.' }, fake: { text: 'Boisfranc CO' }, enabled: true };
    const mail: Entity = { id: 'm', type: 'email', real: { text: 'marc.belanger@videotron.ca' }, fake: { text: 'patrick.cloutier@example.com' }, enabled: true };
    const ai = 'Boisfranc, chef de division. Écrire à patrick.cloutier@example.com, sans doute Patrick Cloutier. Du bois franc.';
    expect(applyMatches(ai, findMatches(ai, [org, mail], 'restore'))).toBe(
      'Marvale, chef de division. Écrire à marc.belanger@videotron.ca, sans doute Marc Belanger. Du bois franc.',
    );
    const doc = 'MARVALE INC. vend. Marvale signe.';
    expect(applyMatches(doc, findMatches(doc, [org], 'anonymize'))).toBe('BOISFRANC INC. vend. Boisfranc signe.');
  });

  it('restores a fake street name an AI quotes alone, never the real one when anonymizing', () => {
    const e: Entity = {
      id: 'a',
      type: 'address',
      real: { text: '23 rue Félix-Leclerc', address: { civic: '23', streetType: 'rue', streetName: 'Félix-Leclerc' } },
      fake: { text: '9 rue Saint-Isidore', address: { civic: '9', streetType: 'rue', streetName: 'Saint-Isidore' } },
      enabled: true,
    };
    const ai = 'Le bail mentionne aussi « Saint-Isidore ». Voir Baie-Saint-Isidore.';
    expect(applyMatches(ai, findMatches(ai, [e], 'restore'))).toBe('Le bail mentionne aussi « Félix-Leclerc ». Voir Baie-Saint-Isidore.');
    expect(findMatches('Le peintre Félix-Leclerc.', [e], 'anonymize')).toHaveLength(0);
  });

  it('restores a fake three-part name an AI shortened to its first two', () => {
    const e = person('p', ['Jacques', 'Poulin'], ['Gaétan', 'Cyr']);
    e.real = { text: 'Jacques Henri Poulin', person: { first: 'Jacques', middle: 'Henri', last: 'Poulin' } };
    e.fake = { text: 'Gaétan Benoît Cyr', person: { first: 'Gaétan', middle: 'Benoît', last: 'Cyr' } };
    const ai = 'Signé par Gaétan Benoît (la mention « CYR » est douteuse).';
    expect(applyMatches(ai, findMatches(ai, [e], 'restore'))).toBe('Signé par Jacques Henri (la mention « POULIN » est douteuse).');
  });

  it('restores a fake identifier an AI shortened to its first block, and a fake name cut before the first name', () => {
    const id: Entity = { id: 'i', type: 'id_number', real: { text: '3f2a9c10-77b1-4e0d-9a2e-0c5b8e1f4d6a' }, fake: { text: 'a70e16b2-dc9f-1481-be0a-8c066a17eb95' }, enabled: true };
    const ai = 'Session a70e16b2-dc9f-1481-be0a-8c066a17eb95, puis à 18:34 (session a70e16b2…).';
    expect(applyMatches(ai, findMatches(ai, [id], 'restore'))).toBe('Session 3f2a9c10-77b1-4e0d-9a2e-0c5b8e1f4d6a, puis à 18:34 (session 3f2a9c10…).');
    const p = person('p', ['Jacques', 'Poulin'], ['Réjean', 'Cantin']);
    p.real = { text: 'Jacques Henri Poulin', person: { first: 'Jacques', middle: 'Henri', last: 'Poulin' } };
    p.fake = { text: 'Réjean Frédéric Cantin', person: { first: 'Réjean', middle: 'Frédéric', last: 'Cantin' } };
    const ai2 = 'Deux signataires : Frédéric Cantin, vice-président.';
    expect(applyMatches(ai2, findMatches(ai2, [p], 'restore'))).toBe('Deux signataires : Henri Poulin, vice-président.');
  });

  it('replaces a profile handle after the slash, both ways', () => {
    const e: Entity = { id: 'h', type: 'other', real: { text: 'fermedupontinc' }, fake: { text: 'qzarbtlmkwepsxo' }, enabled: true };
    const text = 'Suivez-nous : www.facebook.com/fermedupontinc.';
    const anon = applyMatches(text, findMatches(text, [e], 'anonymize'));
    expect(anon).toBe('Suivez-nous : www.facebook.com/qzarbtlmkwepsxo.');
    expect(applyMatches(anon, findMatches(anon, [e], 'restore'))).toBe(text);
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

describe('provinces', () => {
  it('are kept: never matched in a copy nor counted as left, whatever an older value says', async () => {
    const { isProvince, findMatches, fuzzyLeaks } = await import('../src');
    for (const p of ['QC', 'Qc', 'Qué.', 'Québec', 'Ont.', 'Ontario', 'N.-B.', 'British Columbia']) expect(isProvince(p), p).toBe(true);
    for (const p of ['Quebecor', 'Baie-Saint-Paul', 'QC1234', 'Marie Québec']) expect(isProvince(p), p).toBe(false);
    const qc: Entity = { id: 'q', type: 'other', real: { text: 'QC' }, fake: { text: 'XK' }, enabled: true };
    const text = '70-72 rue Sainte-Anne, Baie-Saint-Paul QC G3Z 1P3';
    expect(findMatches(text, [qc], 'anonymize')).toEqual([]);
    expect(fuzzyLeaks(text, [qc])).toEqual([]);
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

  it('never finds a name inside a hyphenated word: the town is kept, and Jean-Paul is someone else', async () => {
    const { fuzzyLeaks } = await import('../src');
    const paul: Entity = { id: 'p', type: 'person', real: { text: 'Paul' }, fake: { text: 'Hudon' }, enabled: true };
    const martine: Entity = { id: 'm', type: 'person', real: { text: 'Martine Lavoie-Bérubé' }, fake: { text: 'Huguette Talbot' }, enabled: true };
    expect(fuzzyLeaks('70-72 rue Sainte-Anne, Baie-Saint-Paul (Québec) / BAIE-SAINT-PAUL / Jean-Paul Roy', [paul, martine])).toEqual([]);
    expect(fuzzyLeaks('Signé par Paul, le 2 mai', [paul])).toEqual(['p']);
    expect(fuzzyLeaks('Présidente : Martine Lavoie-Berubé', [martine])).toEqual(['m']);
    expect(fuzzyLeaks('Mme Lavoie-\nBérubé', [martine])).toEqual(['m']);
  });

  it('reads a fake a character away from a real number as the fake, and the real one misread as a leak', async () => {
    const { fuzzyLeaks } = await import('../src');
    // One tenant's fake drawn first; another's real number, found in a later lease, a digit away from it.
    const a: Entity = { id: 'a', type: 'phone', real: { text: '450 555-0164' }, fake: { text: '450 555-0186' }, enabled: true };
    const b: Entity = { id: 'b', type: 'phone', real: { text: '450 555-0187' }, fake: { text: '450 555-0102' }, enabled: true };
    expect(fuzzyLeaks('tél. 450 555-0186, tél. 450 555-0102', [a, b])).toEqual([]);
    expect(fuzzyLeaks('tél. 450 555-0181', [a, b])).toEqual(['b']);
    expect(fuzzyLeaks('tél. 450 555-0187', [a, b])).toEqual(['b']);
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
