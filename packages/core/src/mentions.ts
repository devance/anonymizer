import type { Entity, Match, MentionLog } from './types';

/** Outputs remembered per value; the oldest are forgotten first (restore then falls back to rebuilding the real value). */
export const MAX_MENTION_LOGS = 40;

/**
 * What an anonymized output wrote, per entity: each fake surface → the real
 * surfaces it replaced, in text order, kept as one entry when they're all the
 * same. Only what was actually swapped counts (the checked matches).
 */
export function mentionsOf(matches: Match[]): Map<string, Record<string, string[]>> {
  const out = new Map<string, Record<string, string[]>>();
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    let map = out.get(m.entityId);
    if (!map) out.set(m.entityId, (map = {}));
    if (Object.hasOwn(map, m.replacement)) map[m.replacement]!.push(m.surface);
    else map[m.replacement] = [m.surface];
  }
  for (const map of out.values()) {
    for (const [k, seq] of Object.entries(map)) if (seq.every((s) => s === seq[0])) map[k] = [seq[0]!];
  }
  return out;
}

function sameMap(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = a[k]!;
    const y = b[k];
    return !!y && x.length === y.length && x.every((s, i) => s === y[i]);
  });
}

/**
 * An entity's logs with a new output's entry added (newest last). Earlier
 * outputs keep theirs: a file already downloaded still restores as it was,
 * even after a fake was edited and the document rendered again. Null when
 * nothing changes (the output doesn't use the value, or wrote exactly what an
 * earlier one did), so rendering the same thing again writes nothing.
 */
export function withMentions(logs: MentionLog[] | undefined, output: string, map: Record<string, string[]> | undefined): MentionLog[] | null {
  const prev = logs ?? [];
  if (!map || Object.keys(map).length === 0) return null;
  if (prev.some((l) => sameMap(l.map, map))) return null;
  const next = [...prev, { doc: output, map }];
  return next.slice(Math.max(0, next.length - MAX_MENTION_LOGS));
}

/** The fake surfaces any output wrote for an entity, each with the first real surface it replaced. */
export function mentionKeys(e: Entity): Map<string, string> {
  const keys = new Map<string, string>();
  for (const l of e.mentions ?? []) for (const [k, seq] of Object.entries(l.map)) keys.set(k, seq[0]!);
  return keys;
}

/**
 * Restore: a match whose text is exactly a fake surface an output wrote gets
 * back the real surface it replaced there. When several outputs wrote it, the
 * one sharing the most such surfaces with this text decides (the newest on a
 * tie); when one output wrote it over different real surfaces (an OCR'd
 * "Ëtienne" and an "Étienne", both "Jonathan"), they come back in the order
 * they were written. Anything else (reworded by an AI, or from before outputs
 * were logged) keeps the replacement the matcher rebuilt.
 */
export function applyMentionLogs(matches: Match[], entities: Entity[]): Match[] {
  const byId = new Map(entities.filter((e) => e.mentions?.length).map((e) => [e.id, e]));
  if (byId.size === 0) return matches;
  const logsFor = (m: Match) => byId.get(m.entityId)?.mentions?.filter((l) => Object.hasOwn(l.map, m.surface)) ?? [];
  const score = new Map<string, number>();
  for (const m of matches) for (const l of logsFor(m)) score.set(l.doc, (score.get(l.doc) ?? 0) + 1);
  const seen = new Map<string, number>();
  return matches.map((m) => {
    const logs = logsFor(m);
    if (logs.length === 0) return m;
    let best = logs[0]!;
    for (const l of logs) if ((score.get(l.doc) ?? 0) >= (score.get(best.doc) ?? 0)) best = l;
    const seq = best.map[m.surface]!;
    const k = `${m.entityId}\u0000${m.surface}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return { ...m, replacement: seq[Math.min(n, seq.length - 1)]! };
  });
}
