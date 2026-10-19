import type { Detector, DetectorEngine } from './platform';

const MODEL_NAME = /^[\w.:/-]{1,100}$/;

/** A detector setting from a request, for a target that offers these engines. */
export function isDetector(d: unknown, engines: readonly DetectorEngine[]): d is Detector {
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  if (typeof x.engine !== 'string' || !(engines as readonly string[]).includes(x.engine)) return false;
  if (x.engine === 'none' || x.engine === 'claude') return true;
  return typeof x.model === 'string' && MODEL_NAME.test(x.model);
}

/** Just the fields of a detector, whatever else the request carried. */
export function cleanDetector(d: Detector): Detector {
  if (d.engine === 'none' || d.engine === 'claude') return { engine: d.engine };
  return { engine: d.engine, model: d.model };
}

/**
 * A stored setting, old forms included: the first web version wrote
 * {"engine":"local","model":"gemma4:26b"} for Ollama on the PC.
 */
export function parseDetector(value: string | null | undefined, fallback: Detector): Detector {
  if (!value) return fallback;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  if (d.engine === 'local') return typeof d.model === 'string' && d.model ? { engine: 'ollama', model: d.model } : fallback;
  if (isDetector(d, ['none', 'builtin', 'ollama', 'claude'])) return cleanDetector(d);
  return fallback;
}

/** Billed per token and capped per user (Claude); local models are free. */
export function isCloud(d: Detector): boolean {
  return d.engine === 'claude';
}
