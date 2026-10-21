import { applyMatches, findMatches, type Entity } from '@anon/core';
import { describe, expect, it } from 'vitest';
import { analyze, nerDetections } from '../src/compute';
import type { NerSpan } from '../src/engine';

/** Spans for each string, wherever it appears, as the engine's small model would give them. */
function spans(text: string, found: Array<[string, NerSpan['type']]>): NerSpan[] {
  return found.flatMap(([value, type]) => {
    const out: NerSpan[] = [];
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) out.push({ start: at, end: at + value.length, type });
    return out;
  });
}

describe('small model detections', () => {
  it('joins a surname or initials mention to the full name it belongs to', async () => {
    const text = 'Assuré : M. Jean-François Tremblay. Coassurée : Mme Isabelle Côté.\nMonsieur Tremblay,\nJ.-F. Tremblay et Isabelle Côté';
    const found = spans(text, [
      ['Jean-François Tremblay', 'person'],
      ['Isabelle Côté', 'person'],
      ['Tremblay,', 'person'],
      ['J.-F. Tremblay', 'person'],
    ]).map((s) => (text.slice(s.start, s.end) === 'Tremblay,' ? { ...s, end: s.end - 1 } : s));
    const r = await analyze({ engine: null as never, model: () => null, ner: async () => found }, text, [], true);
    const people = r.candidates.filter((c) => c.type === 'person');
    expect(people).toHaveLength(2);
    expect(people.find((c) => c.real.text === 'Jean-François Tremblay')?.surfaces.sort()).toEqual(['J.-F. Tremblay', 'Jean-François Tremblay', 'Tremblay']);
  });

  it('picks the right one of two people with the same surname by the title', () => {
    const text = 'M. Karim Haddad et Mme Nadia Haddad. Mme Haddad signe; M. Haddad aussi.';
    const dets = nerDetections(
      text,
      spans(text, [
        ['Karim Haddad', 'person'],
        ['Nadia Haddad', 'person'],
      ]).concat([
        { start: text.indexOf('Haddad signe'), end: text.indexOf('Haddad signe') + 6, type: 'person' },
        { start: text.indexOf('Haddad aussi'), end: text.indexOf('Haddad aussi') + 6, type: 'person' },
      ]),
    );
    const group = (t: string) => dets.find((d) => d.start === text.indexOf(t))?.groupKey;
    expect(group('Haddad signe')).toBe(group('Nadia Haddad'));
    expect(group('Haddad aussi')).toBe(group('Karim Haddad'));
  });

  it('makes one person of a first name and the surname the OCR put on the next line, and replaces both', async () => {
    const text = 'Nom du représentant\nJacques 5 S Ê\nPoulin Agent aux programmes';
    const at = (w: string) => text.indexOf(w);
    const found: NerSpan[] = [{ start: at('Jacques'), end: at('Jacques') + 7, type: 'person', last: [at('Poulin'), at('Poulin') + 6] }];
    const r = await analyze({ engine: null as never, model: () => null, ner: async () => found }, text, [], true);
    const people = r.candidates.filter((c) => c.type === 'person');
    expect(people.map((c) => c.real.text)).toEqual(['Jacques Poulin']);
    const e: Entity = { id: 'p', type: 'person', real: people[0]!.real, fake: { text: 'Luc Gagnon', person: { first: 'Luc', last: 'Gagnon' } }, enabled: true };
    expect(applyMatches(text, findMatches(text, [e], 'anonymize'))).toBe('Nom du représentant\nLuc 5 S Ê\nGagnon Agent aux programmes');
  });

  it('never takes an amount or a rate for an identifier, whoever found it', async () => {
    const text = 'Taux affichés\n7,3318 12,750 13,1186\nSolde 4827,35 $ au dossier 559102\nQuébec G0A 2S4 $';
    const found = spans(text, [
      ['3318 12', 'id_number'],
      ['13,1186', 'id_number'],
      ['4827', 'card_number'],
      ['559102', 'id_number'],
    ]);
    const r = await analyze({ engine: null as never, model: () => null, ner: async () => found }, text, [], true);
    expect(r.candidates.map((c) => c.real.text)).toEqual(['559102', 'G0A 2S4']);
  });

  it('keeps a date written as a number, unless a label makes it a reference', async () => {
    const text = 'Émis 2018-05, échéance 20240331. Dossier 2021-06.';
    const found = spans(text, [
      ['2018-05', 'id_number'],
      ['20240331', 'id_number'],
      ['2021-06', 'id_number'],
    ]);
    const r = await analyze({ engine: null as never, model: () => null, ner: async () => found }, text, [], true);
    expect(r.candidates.map((c) => c.real.text)).toEqual(['2021-06']);
  });

  it('keeps a "date of birth" only where the text says so', () => {
    const text = 'Né le 14 mars 1981. Signé le 2 avril 2026.';
    const dets = nerDetections(text, spans(text, [['14 mars 1981', 'dob'], ['2 avril 2026', 'dob']]));
    expect(dets.map((d) => [d.text, d.type])).toEqual([
      ['14 mars 1981', 'dob'],
      ['2 avril 2026', 'date'],
    ]);
  });
});
