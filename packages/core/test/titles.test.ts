import { describe, expect, it } from 'vitest';
import { applyMatches, findMatches, isTitleOnly, mergeDetections, withoutTitles, type Detection, type Entity } from '../src';

// Line 20 and 129-131 of fixtures/detect/dossier-hypothecaire.txt.
const TEXT =
  'Véronique Gauthier-Lamy\nTéléphones : 819 555-0131 (cellulaire, Mme) ; 819 694-2738 (domicile)\n' +
  'Mme Gauthier-Lamy confirme le retour au travail. La caution, Mme D. Lamy, a été rencontrée. M. et Mme Lamy signent.';

const person = (text: string, group = 'c0:p2', parts?: Detection['person']): Detection => ({ text, type: 'person', groupKey: group, person: parts, source: 'claude' });

describe('courtesy titles', () => {
  it('knows a title alone from a name', () => {
    for (const t of ['Mme', 'M.', 'M', 'Mr', 'Mrs.', 'Ms', 'Dr', 'Dre', 'Me', 'Maître', 'Madame', 'Monsieur', 'Mlle', 'M. et Mme', 'Mr & Mrs', 'Pr', 'MME']) expect(isTitleOnly(t), t).toBe(true);
    for (const t of ['Mme Gauthier-Lamy', 'M. Lamy', 'Lamy', 'Médard', 'Meunier', 'Drolet', 'D. Lamy', 'et', '']) expect(isTitleOnly(t), t).toBe(false);
  });

  it('strips titles a model put in the name parts', () => {
    expect(withoutTitles({ first: 'Mme', middle: '', last: 'Lebeau' })).toEqual({ last: 'Lebeau' });
    expect(withoutTitles({ first: 'Mme Isabelle', last: 'Côté' })).toEqual({ first: 'Isabelle', last: 'Côté' });
    expect(withoutTitles({ first: 'M.' })).toEqual({});
  });

  it('a model\'s "Mme" in a woman\'s group is neither a value nor a surface of hers', () => {
    const cands = mergeDetections([
      person('Véronique Gauthier-Lamy', 'c0:p2', { first: 'Véronique', last: 'Gauthier-Lamy' }),
      person('Mme'),
      person('Mme Gauthier-Lamy'),
      person('Mme', 'c0:p9'),
      person('Mme Lebeau', 'c0:p5', { first: 'Mme', last: 'Lebeau' }),
    ]);
    const people = cands.filter((c) => c.type === 'person');
    expect(people.flatMap((c) => c.surfaces).some(isTitleOnly)).toBe(false);
    expect(people.map((c) => c.real.text).sort()).toEqual(['Mme Lebeau', 'Véronique Gauthier-Lamy']);
    expect(people.find((c) => c.real.text === 'Mme Lebeau')!.real.person).toEqual({ last: 'Lebeau' });
  });

  it('values saved with a title in them never replace a lone title, and the copy keeps every "Mme"', () => {
    // As the live project held them before the fix: "Mme" among her surfaces, "Mme" as a first name.
    const e: Entity[] = [
      {
        id: 'v',
        type: 'person',
        real: { text: 'Véronique Gauthier-Lamy', person: { first: 'Véronique', last: 'Gauthier-Lamy' } },
        fake: { text: 'Catherine Doiron-Fleurant', person: { first: 'Catherine', last: 'Doiron-Fleurant' } },
        surfaces: ['Véronique Gauthier-Lamy', 'Mme', 'Mme Gauthier-Lamy'],
        enabled: true,
      },
      { id: 'g', type: 'person', real: { text: 'Mme Gauthier-Lamy', person: { first: 'Mme', last: 'Gauthier-Lamy' } }, fake: { text: 'Léa Bilodeau', person: { first: 'Léa', last: 'Bilodeau' } }, enabled: true },
      { id: 't', type: 'person', real: { text: 'Mme' }, fake: { text: 'Roy' }, enabled: true },
      { id: 'd', type: 'person', real: { text: 'Denise Lamy', person: { first: 'Denise', last: 'Lamy' } }, fake: { text: 'Clara Guay', person: { first: 'Clara', last: 'Guay' } }, enabled: true },
    ];
    const matches = findMatches(TEXT, e, 'anonymize');
    expect(matches.filter((m) => isTitleOnly(m.surface))).toEqual([]);
    const out = applyMatches(TEXT, matches);
    expect(out).toContain('(cellulaire, Mme)');
    expect(out.match(/\bMme\b/g)).toHaveLength(4);
    expect(out).not.toMatch(/Gauthier-Lamy|Véronique|Denise/);
    // And back: every mention restores as written, the titles untouched.
    const back = applyMatches(out, findMatches(out, e, 'restore'));
    expect(back).toBe(TEXT);
  });
});
