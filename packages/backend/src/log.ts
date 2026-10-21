/** Time since `since` for the log: "340 ms", "12.4 s". */
export function elapsed(since: number): string {
  const ms = Date.now() - since;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "person 4, address 2": what was found, by type, without the values. */
export function countByType(items: Array<{ type: string }>): string {
  const n = new Map<string, number>();
  for (const i of items) n.set(i.type, (n.get(i.type) ?? 0) + 1);
  return [...n].map(([t, c]) => `${t} ${c}`).join(', ') || 'nothing';
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
