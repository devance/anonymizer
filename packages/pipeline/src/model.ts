import { fold, type ClaudeUsage } from '@anon/core';

/**
 * A model that fills a JSON schema. Detection and restore suggestions only
 * need this, so Claude (CLI or API), Ollama and llama-server are
 * interchangeable.
 */
export interface ModelClient {
  /** For logs and errors. */
  readonly name: string;
  /** Runs on our own hardware: nothing leaves, and its tokens aren't billed. */
  readonly local: boolean;
  /** Longest piece of document sent in one call; longer documents are split. */
  readonly maxChunkChars: number;
  /** Most calls in flight at once. Unset: all chunks at once. */
  readonly maxParallel?: number;
  /** Tokens the prompt and the answer share in one call (the context window). Unset: far more than any chunk needs. */
  readonly contextTokens?: number;
  /** Longest answer one call may write (tokens). */
  readonly maxAnswerTokens: number;
  /** Throws CutOffError when the answer didn't fit, or the prompt leaves no room for one. */
  structured<T>(system: string, user: string, schema: Record<string, unknown>): Promise<{ data: T; usage: ClaudeUsage }>;
}

export class ModelError extends Error {}

/**
 * The answer was cut off: it hit the answer or context limit, or the model
 * started repeating itself and was stopped. The caller sends less text per
 * call (detectEntities splits the piece and asks again). `partial` is what
 * the model wrote before the cut, for salvaging complete entries.
 */
export class CutOffError extends ModelError {
  constructor(
    message: string,
    public reason: 'length' | 'repetition' | 'prompt',
    public partial = '',
    /** Tokens the cut-off call used, when the server said: they count toward Claude's cap all the same. */
    public usage?: ClaudeUsage,
  ) {
    super(message);
  }
}

/**
 * Rough token count of text for a budget, on the high side: the fixtures
 * measured 3.0 to 3.3 characters per token with Gemma (French prose, tables,
 * identifiers), and lists of identifiers alone about 2.1.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/** Room left for the answer in one call, kept free of the prompt's estimate. */
export const PROMPT_MARGIN_TOKENS = 256;

/** Below this much room for the answer, a call is not worth sending: the text is split first. */
export const MIN_ANSWER_TOKENS = 1024;

/**
 * How many answer tokens a call may use: the model's cap, or what the window
 * leaves after the prompt. Throws CutOffError ('prompt') when that is too
 * little, so the caller splits the text before anything is sent.
 */
export function answerBudget(name: string, maxAnswerTokens: number, contextTokens: number | undefined, system: string, user: string): number {
  const room = contextTokens === undefined ? maxAnswerTokens : contextTokens - estimateTokens(system) - estimateTokens(user) - PROMPT_MARGIN_TOKENS;
  const budget = Math.min(maxAnswerTokens, room);
  if (budget < Math.min(MIN_ANSWER_TOKENS, maxAnswerTokens)) throw new CutOffError(`${name}: the text is too long for one call`, 'prompt');
  return budget;
}

/** Folded, with every run of non-letters and non-digits as one space: "Laval (Québec)" and "Laval, Québec" read alike. */
const plain = (text: string) => ` ${fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Watches an answer as it streams and says when the model is stuck: a long
 * run of whitespace (the JSON grammar allows any amount), the same stretch
 * of output repeated back to back, the same "text" value written over and
 * over, or, given the text that was sent (`source`), value after value that
 * isn't in it (Gemma 4 E4B, on the 11 440-character mortgage file, went from
 * the real values to "p3", "p4", "o1"… then "i457", "i458"… until its limit).
 * A real answer does none of these: on the fixtures, at most 3 values in a
 * row weren't written as in the text. A stuck one would otherwise run to the
 * answer limit (16k tokens: about a minute of the PC's GPU).
 */
export function repetitionGuard(opts: { source?: string; maxSameText?: number; minRepeatChars?: number; maxWhitespace?: number; maxInvented?: number } = {}) {
  const maxSame = opts.maxSameText ?? 40;
  const minRepeat = opts.minRepeatChars ?? 1200;
  const maxWs = opts.maxWhitespace ?? 200;
  const maxInvented = opts.maxInvented ?? 15;
  const source = opts.source === undefined ? undefined : plain(opts.source);
  let out = '';
  let scanned = 0;
  let checkedAt = 0;
  let wsRun = 0;
  let invented = 0;
  const texts = new Map<string, number>();
  const textRe = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  /** The last `minRepeat` characters repeat with some period p (at most a third of them): a loop. */
  const periodic = (): number => {
    const n = out.length;
    if (n < minRepeat) return 0;
    for (let p = 1; p <= minRepeat / 3; p++) {
      let i = n - 1;
      const stop = n - minRepeat + p;
      while (i >= stop && out.charCodeAt(i) === out.charCodeAt(i - p)) i--;
      if (i < stop) return p;
    }
    return 0;
  };
  const unescape = (raw: string) => {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  };
  return {
    /** Feed the next piece of the answer; returns why it's stuck (its rule and numbers, never content), or null. */
    push(piece: string): string | null {
      out += piece;
      for (const c of piece) {
        wsRun = c === ' ' || c === '\n' || c === '\t' || c === '\r' ? wsRun + 1 : 0;
        if (wsRun > maxWs) return `rule whitespace: ${wsRun} whitespace characters in a row`;
      }
      // Complete "text" values written since the last look (start a little back: one may straddle pieces).
      textRe.lastIndex = Math.max(0, scanned - 400);
      for (let m = textRe.exec(out); m; m = textRe.exec(out)) {
        if (m.index + m[0].length <= scanned) continue;
        const n = (texts.get(m[1]!) ?? 0) + 1;
        texts.set(m[1]!, n);
        if (n > maxSame) return `rule same-value: one value written ${n} times`;
        if (source !== undefined) {
          const v = plain(unescape(m[1]!));
          invented = v.trim() && !source.includes(v) ? invented + 1 : 0;
          if (invented >= maxInvented) return `rule invented: ${invented} values in a row that aren't in the text`;
        }
      }
      scanned = out.length;
      if (out.length - checkedAt >= 256) {
        checkedAt = out.length;
        const p = periodic();
        if (p) return `rule repeat: the last ${minRepeat} characters repeat every ${p}`;
      }
      return null;
    },
  };
}

/**
 * The PC with the local model is off or unreachable. Not a failure: the
 * Worker parks the document and analyzes it once the PC is back.
 */
export class DetectorOfflineError extends Error {
  constructor(public detail = '') {
    super('detector_offline');
  }
}

/**
 * fetch with paths ('/v1/chat/completions') instead of URLs. The app passes
 * one that goes through its Rust proxy; Node uses baseUrlFetch.
 */
export type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

/** Called as a plain function: WebKit rejects fetch called on another object. */
export const globalFetch: FetchLike = (path, init) => globalThis.fetch(path, init);

/** Resolve paths against a server, with its API key as a bearer token. */
export function baseUrlFetch(base: string, apiKey?: string): FetchLike {
  const root = base.replace(/\/+$/, '');
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
    return globalThis.fetch(root + path, { ...init, headers });
  };
}

export function offlineFrom(err: unknown): DetectorOfflineError {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return new DetectorOfflineError(cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err)));
}

/** Abort when the first output takes longer than `first` ms, then when the stream goes quiet for `idle` ms. */
export function watchdog(first: number, idle: number) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), first);
  return {
    signal: ctrl.signal,
    bump() {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), idle);
    },
    stop: () => clearTimeout(timer),
  };
}
