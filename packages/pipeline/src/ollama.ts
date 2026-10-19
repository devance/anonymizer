import type { ClaudeUsage } from '@anon/core';
import { answerBudget, baseUrlFetch, CutOffError, DetectorOfflineError, globalFetch, ModelError, offlineFrom, repetitionGuard, watchdog, type FetchLike, type ModelClient } from './model';

/**
 * A model served by Ollama, at the address it is given. When nothing listens
 * there, calls fail with DetectorOfflineError and the caller parks the
 * document until the model is back.
 */

export interface OllamaOptions {
  /** Ollama's address, for Node. Without it, paths go to `fetch`. */
  url?: string;
  /** Resolves paths like '/api/chat'; defaults to the global fetch. */
  fetch?: FetchLike;
  model: string;
  /** Longest piece of document per call (default OLLAMA_CHUNK_CHARS). */
  maxChunkChars?: number;
  /**
   * Context window requested per call (tokens), prompt and answer together.
   * The same on every call: Ollama reloads the model when it changes. Match
   * OLLAMA_CONTEXT_LENGTH on the PC (web/deploy/pc/run-ollama.ps1).
   */
  numCtx?: number;
  /** Longest answer (tokens, num_predict); less when the prompt leaves less room in numCtx. */
  maxAnswerTokens?: number;
  /**
   * Calls in flight at once (default 1). The PC runs one at a time
   * (OLLAMA_NUM_PARALLEL=1): more would only wait in its queue, where the
   * first-output timeout of a long document's last parts keeps running.
   */
  maxParallel?: number;
  /** Wait this long for the first output: loading a model into the GPU can take minutes. */
  firstOutputTimeoutMs?: number;
  /** Then abort when the stream goes quiet this long: the PC hung or vanished. */
  idleTimeoutMs?: number;
}

/** Reasoning models (gpt-oss) can't turn thinking off, only down. */
function thinkFor(model: string): boolean | 'low' {
  return /^gpt-oss/i.test(model) ? 'low' : false;
}

/**
 * 16 000 characters: 26b and 12b kept 100% and 98% recall there with prompt v2
 * in the detection benchmark, and a dense part's answer (up to about one token
 * per character) still fits in the answer limit.
 */
export const OLLAMA_CHUNK_CHARS = 16_000;

export function ollamaClient(opts: OllamaOptions): ModelClient {
  const numCtx = opts.numCtx ?? 32768;
  const maxAnswer = opts.maxAnswerTokens ?? 16384;
  const first = opts.firstOutputTimeoutMs ?? 600_000;
  const idle = opts.idleTimeoutMs ?? 120_000;
  const f = opts.fetch ?? (opts.url ? baseUrlFetch(opts.url) : globalFetch);
  return {
    name: `${opts.model} on the PC`,
    local: true,
    maxChunkChars: opts.maxChunkChars ?? OLLAMA_CHUNK_CHARS,
    maxParallel: opts.maxParallel ?? 1,
    contextTokens: numCtx,
    maxAnswerTokens: maxAnswer,
    async structured<T>(system: string, user: string, schema: Record<string, unknown>) {
      // The window is fixed: past it, Ollama stops with done_reason "length" like at num_predict.
      const numPredict = answerBudget(opts.model, maxAnswer, numCtx, system, user);
      const dog = watchdog(first, idle);
      const guard = repetitionGuard({ source: user });
      try {
        let res: Response;
        try {
          res = await f('/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: dog.signal,
            body: JSON.stringify({
              model: opts.model,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              format: schema,
              think: thinkFor(opts.model),
              stream: true,
              keep_alive: '10m',
              options: { temperature: 0, num_ctx: numCtx, num_predict: numPredict },
            }),
          });
        } catch (err) {
          throw offlineFrom(err);
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          if (res.status === 404) throw new ModelError(`${opts.model} is not installed on the PC`);
          throw new ModelError(`${opts.model}: ${body?.error ?? `HTTP ${res.status}`}`);
        }
        type Chunk = { error?: string; done?: boolean; message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
        let content = '';
        let final: Chunk | null = null;
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            dog.bump();
            buf += dec.decode(value, { stream: true });
            for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              const msg = JSON.parse(line) as Chunk;
              if (msg.error) throw new ModelError(`${opts.model}: ${msg.error}`);
              const piece = msg.message?.content ?? '';
              content += piece;
              const stuck = guard.push(piece);
              // Stopping the stream frees the GPU: Ollama cancels a request whose connection closes.
              if (stuck) throw new CutOffError(`${opts.model}: stopped, ${stuck}`, 'repetition', content);
              if (msg.done) final = msg;
            }
          }
        } catch (err) {
          if (err instanceof ModelError) throw err;
          throw offlineFrom(err);
        } finally {
          void reader.cancel().catch(() => {});
        }
        if (!final) throw new DetectorOfflineError('the PC stopped answering');
        if (final.done_reason === 'length') {
          throw new CutOffError(
            `${opts.model}: the answer was cut off (${final.prompt_eval_count ?? '?'} prompt + ${final.eval_count ?? '?'} answer tokens, limit ${numPredict} of ${numCtx})`,
            'length',
            content,
            { input_tokens: final.prompt_eval_count ?? 0, output_tokens: final.eval_count ?? 0 },
          );
        }
        let data: T;
        try {
          data = JSON.parse(content) as T;
        } catch {
          throw new ModelError(`${opts.model} returned invalid JSON`);
        }
        const usage: ClaudeUsage = { input_tokens: final.prompt_eval_count ?? 0, output_tokens: final.eval_count ?? 0 };
        return { data, usage };
      } finally {
        dog.stop();
      }
    },
  };
}

export interface LocalStatus {
  online: boolean;
  /** Installed models, largest first. */
  models: Array<{ name: string; sizeGb: number }>;
  /** Models in GPU memory right now. */
  loaded: string[];
}

/** `target`: Ollama's address, or a fetch that resolves paths. */
export async function ollamaStatus(target: string | FetchLike = globalFetch): Promise<LocalStatus> {
  const f = typeof target === 'string' ? baseUrlFetch(target) : target;
  try {
    const get = async <T>(path: string) => {
      const res = await f(path, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as T;
    };
    const [tags, ps] = await Promise.all([
      get<{ models: Array<{ name: string; size: number }> }>('/api/tags'),
      get<{ models: Array<{ name: string }> }>('/api/ps'),
    ]);
    return {
      online: true,
      models: tags.models.map((m) => ({ name: m.name, sizeGb: Math.round(m.size / 1e8) / 10 })).sort((a, b) => b.sizeGb - a.sizeGb),
      loaded: ps.models.map((m) => m.name),
    };
  } catch {
    return { online: false, models: [], loaded: [] };
  }
}
