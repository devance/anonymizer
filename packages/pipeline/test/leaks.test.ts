import { describe, expect, it } from 'vitest';
import { toValue, type Entity } from '@anon/core';
import { findLeaks } from '../src/compute';

// Fakes are drawn as documents come in; a real value found later can sit an edit away from one.
const person = (id: string, real: string, fake: string): Entity => ({ id, type: 'person', real: toValue({ type: 'person', text: real }), fake: toValue({ type: 'person', text: fake }), enabled: true });
const phone = (id: string, real: string, fake: string): Entity => ({ id, type: 'phone', real: { text: real }, fake: { text: fake }, enabled: true });
const ENTITIES = [
  person('karim', 'Karim Benali', 'Denise Brochu'),
  person('denis', 'Denis Ouellet', 'Benoît Fournier'),
  phone('p1', '450 555-0164', '450 555-0186'),
  phone('p2', '450 555-0187', '450 555-0102'),
];
const check = (text: string, raster: string[] = []) => findLeaks({ text, fields: [], raster, codes: {} }, ENTITIES).leaks.map((l) => `${l.entityId} ${l.where}`);

describe('leak check', () => {
  it('reads a fake an edit away from a real value as the fake', () => {
    const copy = '| 2417 | Denise Brochu | 450 555-0186 |\nLocateur : Benoît Fournier, tél. 450 555-0102';
    expect(check(copy, [copy])).toEqual([]);
  });

  it('still finds a real value, as written or misread by the OCR', () => {
    expect(check('Locateur : Denis Ouellet')).toEqual(['denis text']);
    expect(check('', ['Locateur : Denls Ouellet'])).toEqual(['denis page image']);
    expect(check('', ['tél. 450 555-0181'])).toEqual(['p2 page image']);
  });
});
