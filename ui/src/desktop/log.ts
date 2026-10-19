import { invoke } from '@tauri-apps/api/core';
import type { LogLevel } from '@anon/backend';

/**
 * The page's side of the diagnostic log (~/.devance/logs). Lines carry ids,
 * steps, timings and error messages, never document text or values; Rust
 * masks quoted strings on the way in.
 */
export function log(level: LogLevel, source: string, message: string): void {
  void invoke('log_write', { level, source, message: message.slice(0, 4000) }).catch(() => {});
}

function describe(x: unknown): string {
  if (x instanceof Error) return `${x.name}: ${x.message}${x.stack ? `\n${x.stack.split('\n').slice(0, 8).join('\n')}` : ''}`;
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x)?.slice(0, 500) ?? String(x);
  } catch {
    return String(x);
  }
}

/**
 * Uncaught errors, console warnings and errors, and a heartbeat every 20 s:
 * when the page's script hangs, Rust notices the missing beats and logs it.
 */
export function installLogging(busy: () => boolean): void {
  window.addEventListener('error', (e) => log('error', 'ui', `${e.message} (${e.filename?.split('/').pop() ?? '?'}:${e.lineno}:${e.colno})`));
  window.addEventListener('unhandledrejection', (e) => log('error', 'ui', `unhandled rejection: ${describe(e.reason)}`));
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      log(level, 'console', args.map(describe).join(' '));
    };
  }
  const beat = () => void invoke('log_heartbeat', { busy: busy(), visible: document.visibilityState === 'visible' }).catch(() => {});
  beat();
  setInterval(beat, 20_000);
}
