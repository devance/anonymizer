import { makeFake, mergeDetections, seededRng, type Entity } from '@anon/core';
import { describe, expect, it } from 'vitest';
import { filenameLeaks, swapFilename } from '../src/compute';

function entities(texts: string[]): Entity[] {
  const cands = mergeDetections(texts.map((text) => ({ type: 'person' as const, text, source: 'manual' as const })));
  const ctx = { rng: seededRng(7), isTaken: () => false, claim: () => {}, realParts: new Set<string>() };
  return cands.map((c, i) => ({ id: `e${i}`, type: c.type, real: c.real, surfaces: c.surfaces, fake: makeFake(c.type, c.real, c.attrs, ctx).value, enabled: true, projectId: 'p' }));
}

describe('filenames', () => {
  const ents = entities(['Jean-François Tremblay', 'Isabelle Gagné']);
  const fake = (real: string) => ents.find((e) => e.real.text === real)!.fake.text;
  const last = (real: string) => fake(real).split(' ').pop()!;

  it('swaps names joined by spaces, underscores, hyphens or dots, and keeps the separator', () => {
    expect(swapFilename('police Tremblay.pdf', ents, 'anonymize')).toBe(`police ${last('Jean-François Tremblay')}.pdf`);
    expect(swapFilename('Tremblay_assurance.txt', ents, 'anonymize')).toBe(`${last('Jean-François Tremblay')}_assurance.txt`);
    expect(swapFilename('Demande-financement-Tremblay.txt', ents, 'anonymize')).toBe(`Demande-financement-${last('Jean-François Tremblay')}.txt`);
    expect(swapFilename('JF.Tremblay.2024.pdf', ents, 'anonymize')).toBe(`JF.${last('Jean-François Tremblay')}.2024.pdf`);
    expect(swapFilename('Lettre Tremblay-Gagné.pdf', ents, 'anonymize')).toBe(`Lettre ${last('Jean-François Tremblay')}-${last('Isabelle Gagné')}.pdf`);
    expect(swapFilename('Jean-François Tremblay.pdf', ents, 'anonymize')).toBe(`${fake('Jean-François Tremblay')}.pdf`);
    expect(swapFilename('Jean-François_Tremblay.pdf', ents, 'anonymize')).toBe(`${fake('Jean-François Tremblay').replace(/ /g, '_')}.pdf`);
  });

  it('leaves no real name in any of them, and says so when one is left', () => {
    for (const name of ['Demande-financement-Tremblay.txt', 'tremblay-jf.pdf', 'Gagné-Tremblay.docx', 'TREMBLAY_Isabelle_Gagne.pdf']) {
      const out = swapFilename(name, ents, 'anonymize');
      expect(out, name).not.toMatch(/tremblay|gagn/i);
      expect(filenameLeaks(out, ents)).toEqual([]);
    }
    expect(filenameLeaks('Demande-Tremblay.pdf', ents)).toEqual([expect.objectContaining({ type: 'person', where: 'filename' })]);
  });

  it('puts the real names back in a restored copy', () => {
    expect(swapFilename(`Note-${last('Jean-François Tremblay')}.docx`, ents, 'restore')).toBe('Note-Tremblay.docx');
  });
});
