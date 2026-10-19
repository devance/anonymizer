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

  it('keeps a "date of birth" only where the text says so', () => {
    const text = 'Né le 14 mars 1981. Signé le 2 avril 2026.';
    const dets = nerDetections(text, spans(text, [['14 mars 1981', 'dob'], ['2 avril 2026', 'dob']]));
    expect(dets.map((d) => [d.text, d.type])).toEqual([
      ['14 mars 1981', 'dob'],
      ['2 avril 2026', 'date'],
    ]);
  });
});
