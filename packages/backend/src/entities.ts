import { collidesWith, collisionKeys, cryptoRng, DEFAULT_ON, isPublicOrg, makeFake, toValue, valueKey, valueParts, type Candidate, type EntityType, type EntityValue, type FakeContext, type FakeKind, type Rng } from '@anon/core';
import type { LoadedEntity } from '@anon/pipeline';
import { ConflictError, type EntityWrites, type Store } from './platform';

export const newId = () => crypto.randomUUID();

/** Fakes are unique across the whole database, except phones: unique within their project. */
const PROJECT_SCOPED: ReadonlySet<FakeKind> = new Set(['phone']);

/** Random by default; tests and the parity check pass a seeded one to compare outputs byte for byte. */
let rngFactory: () => Rng = cryptoRng;
export function setFakeRng(factory: (() => Rng) | null): void {
  rngFactory = factory ?? cryptoRng;
}

/**
 * Turn detected values into project entities: existing ones (matched by the
 * key of their normalized value) get any new surface forms, new ones get a
 * fake. No fake may equal a real value of the project (collisionKeys): a new
 * fake is drawn again until it doesn't, and an existing fake that a newly
 * seen real value turns out to equal (the profile's fake surname is the
 * surname of someone in a later document) is drawn again, the old one kept
 * as an alias once it has left the tool so its outputs still restore. Every
 * other fake stays as it is. One transaction, so two analyses can't create
 * duplicates or claim the same fake; on a conflict it reloads and plans
 * again, a few times at most.
 */
export async function upsertCandidates(store: Store, projectId: string, candidates: Candidate[]): Promise<LoadedEntity[]> {
  for (let attempt = 0; ; attempt++) {
    const writes = await planWrites(store, projectId, candidates);
    if (writes.inserts.length + writes.reals.length + writes.fakes.length === 0) break;
    try {
      await store.writeEntities(projectId, writes);
      break;
    } catch (err) {
      if (!(err instanceof ConflictError) || attempt >= 3) throw err;
    }
  }
  return store.loadEntities([projectId]);
}

async function planWrites(store: Store, projectId: string, candidates: Candidate[]): Promise<EntityWrites> {
  const existing = await store.loadEntities([projectId]);
  const byKey = await store.entityIndex(projectId);
  const keys = await Promise.all(candidates.map((c) => store.indexKey(projectId, c.type, c.key)));
  const claims = await store.loadClaims(projectId);
  const options = (await store.fakeOptions?.(projectId)) ?? {};
  const realParts = new Set([...existing, ...candidates].flatMap((e) => valueParts(e.type, e.real)));
  // Who each real key belongs to: an existing entity, or a candidate that isn't one yet.
  const owners = new Map<string, Set<string>>();
  const own = (owner: string, type: EntityType, real: EntityValue) => {
    for (const k of collisionKeys(type, real)) {
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k)!.add(owner);
    }
  };
  for (const e of existing) own(e.id, e.type, e.real);
  candidates.forEach((c, i) => own(byKey.get(`${c.type}|${keys[i]}`) ?? `new:${i}`, c.type, c.real));
  const realKeys = new Set(owners.keys());
  const people: NonNullable<FakeContext['people']> = existing
    .filter((e) => e.type === 'person' && e.real.person && e.fake.person)
    .map((e) => ({ real: e.real.person!, fake: e.fake.person! }));
  const writes: EntityWrites = { inserts: [], reals: [], fakes: [], claims: [] };
  let currentEntity = '';
  const ctx: FakeContext = {
    rng: rngFactory(),
    isTaken: (k, v) => claims.get(k)?.has(v) ?? false,
    claim: (k, v) => {
      if (!claims.has(k)) claims.set(k, new Set());
      claims.get(k)!.add(v);
      writes.claims.push({ kind: k, scope: PROJECT_SCOPED.has(k) ? projectId : '', key: v, entityId: currentEntity });
    },
    realParts,
    people,
    realKeys,
    keepCivic: options.keepCivic,
  };

  // Existing fakes that equal some other real value of the project, in load order (the seed decides the rest).
  for (const e of existing) {
    const clash = collisionKeys(e.type, e.fake).some((k) => [...(owners.get(k) ?? [])].some((o) => o !== e.id));
    if (!clash) continue;
    currentEntity = e.id;
    const { value: fake } = makeFake(e.type, e.real, e.attrs, ctx);
    // A pool run dry: keep the fake rather than churn it on every analysis.
    if (collidesWith(e.type, fake, new Set([...realKeys].filter((k) => [...owners.get(k)!].some((o) => o !== e.id))))) continue;
    writes.fakes.push({ id: e.id, fake, aliases: e.frozen ? [...(e.aliases ?? []), e.fake] : (e.aliases ?? []) });
    if (e.type === 'person' && e.real.person && fake.person) {
      const i = people.findIndex((p) => p.real === e.real.person);
      if (i >= 0) people[i] = { real: e.real.person, fake: fake.person };
    }
  }

  // People first so emails can be built from their owner's fake name.
  const order = candidates.map((_, i) => i).sort((a, b) => (candidates[a]!.type === 'person' ? 0 : 1) - (candidates[b]!.type === 'person' ? 0 : 1));
  for (const i of order) {
    const c = candidates[i]!;
    const slot = `${c.type}|${keys[i]}`;
    const existingId = byKey.get(slot);
    if (existingId) {
      const e = existing.find((x) => x.id === existingId);
      const pending = writes.reals.find((s) => s.id === existingId) ?? writes.inserts.find((s) => s.id === existingId);
      const before = pending ? pending.real.surfaces : (e?.surfaces ?? []);
      const surfaces = [...new Set([...before, ...c.surfaces])];
      if (surfaces.length !== before.length) {
        if (pending) pending.real = { ...pending.real, surfaces };
        else if (e) writes.reals.push({ id: e.id, real: { real: e.real, surfaces, mentions: e.mentions } });
      }
      continue;
    }
    const id = newId();
    currentEntity = id;
    const { value: fake } = makeFake(c.type, c.real, c.attrs, ctx);
    if (c.type === 'person' && c.real.person && fake.person) people.push({ real: c.real.person, fake: fake.person });
    writes.inserts.push({ id, type: c.type, real: { real: c.real, surfaces: c.surfaces }, indexKey: keys[i]!, fake, attrs: c.attrs ?? {}, enabled: DEFAULT_ON.has(c.type) && !(c.type === 'organization' && isPublicOrg(c.real.text)) });
    byKey.set(slot, id);
  }
  return writes;
}

/**
 * Change an entity's fake. Once a document using the old fake has left the
 * tool, the old one stays recognizable as an alias. A fake typed by hand may
 * not equal a real value of the project either (its own included): 'fake_is_real'.
 */
export async function updateEntity(
  store: Store,
  projectId: string,
  id: string,
  patch: { enabled?: boolean; fakeText?: string },
): Promise<'ok' | 'not_found' | 'fake_is_real'> {
  const all = await store.loadEntities([projectId]);
  const e = all.find((x) => x.id === id);
  if (!e) return 'not_found';
  const text = patch.fakeText?.trim();
  if (text && text !== e.fake.text && collidesWith(e.type, toValue({ type: e.type, text }), new Set(all.flatMap((x) => collisionKeys(x.type, x.real))))) return 'fake_is_real';
  if (patch.enabled !== undefined) await store.setEntity(projectId, id, { enabled: patch.enabled });
  if (text && text !== e.fake.text) {
    const fake: EntityValue = { ...e.fake, text };
    if (e.type === 'person') {
      const words = text.split(/\s+/);
      fake.person = words.length > 1 ? { first: words.slice(0, -1).join(' '), last: words[words.length - 1] } : { last: words[0] };
    }
    if (e.type === 'address') delete fake.address;
    const aliases = e.frozen ? [...(e.aliases ?? []), e.fake] : (e.aliases ?? []);
    await store.setEntity(projectId, id, { fake, aliases });
  }
  return 'ok';
}

/** The user's own values, as candidates for a project. */
export function profileCandidates(entries: Array<{ type: EntityType; real: EntityValue }>): Candidate[] {
  return entries.map((p) => ({ type: p.type, real: p.real, key: valueKey(p.type, p.real), surfaces: [p.real.text] }));
}
