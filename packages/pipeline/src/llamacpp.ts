import type { ClaudeUsage } from '@anon/core';
import { answerBudget, CutOffError, DetectorOfflineError, globalFetch, ModelError, offlineFrom, repetitionGuard, watchdog, type FetchLike, type ModelClient } from './model';

/**
 * A model served by llama-server (llama.cpp), the app's own sidecar. Its
 * OpenAI-style endpoint takes a JSON schema and turns it into a grammar, so
 * the answer always parses unless it was cut off. One slot (-np 1): calls go
 * one at a time and reuse the cached system prompt.
 */

/**
 * Chunk size measured best for Gemma 4 E4B, 12B and 26B-A4B: on 16 000-char
 * chunks they skip table rows of long documents (detection benchmark).
 */
export const LLAMA_CHUNK_CHARS = 8_000;

/** The app's llama-server context (resources/models.json `ctx`). */
export const LLAMA_CTX = 16_384;

export interface LlamaCppOptions {
  /** Resolves '/v1/chat/completions'; the app routes it through its Rust proxy. Node: baseUrlFetch(url, key). */
  fetch?: FetchLike;
  /** For logs and errors ("Gemma 4 E4B"). */
  name: string;
  /** Longest piece of document per call. */
  maxChunkChars: number;
  /** The server's context (-c, tokens): prompt and answer share it (one slot, -np 1). Default LLAMA_CTX. */
  contextTokens?: number;
  /** Cap on the answer (tokens); less when the prompt leaves less room in the context. */
  maxTokens?: number;
  /** Wait this long for the first output: a cold model and a long prompt on a CPU can take minutes. */
  firstOutputTimeoutMs?: number;
  /** Then abort when the stream goes quiet this long. */
  idleTimeoutMs?: number;
}

type Chunk = {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
};

const errText = (e: Chunk['error']) => (typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)));

export function llamaCppClient(opts: LlamaCppOptions): ModelClient {
  const f = opts.fetch ?? globalFetch;
  const first = opts.firstOutputTimeoutMs ?? 300_000;
  const idle = opts.idleTimeoutMs ?? 120_000;
  const name = opts.name;
  const ctx = opts.contextTokens ?? LLAMA_CTX;
  // A dense 8000-character part writes up to about 8000 tokens; a longer answer is a model gone astray
  // (on a Mac at 40 tokens/s, 8192 tokens is already over 3 minutes).
  const maxAnswer = opts.maxTokens ?? 8192;
  return {
    name,
    local: true,
    maxChunkChars: opts.maxChunkChars,
    maxParallel: 1,
    contextTokens: ctx,
    maxAnswerTokens: maxAnswer,
    async structured<T>(system: string, user: string, schema: Record<string, unknown>) {
      const maxTokens = answerBudget(name, maxAnswer, ctx, system, user);
      const dog = watchdog(first, idle);
      const guard = repetitionGuard({ source: user });
      try {
        let res: Response;
        try {
          res = await f('/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: dog.signal,
            body: JSON.stringify({
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              temperature: 0,
              max_tokens: maxTokens,
              response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
              stream: true,
              stream_options: { include_usage: true },
              chat_template_kwargs: { enable_thinking: false },
              cache_prompt: true,
            }),
          });
        } catch (err) {
          throw offlineFrom(err);
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as Chunk | null;
          const msg = body?.error ? errText(body.error) : `HTTP ${res.status}`;
          // 503: still loading the model.
          if (res.status === 503) throw new DetectorOfflineError(msg);
          if (res.status === 401 || res.status === 403) throw new ModelError(`${name}: the server refused the API key`);
          throw new ModelError(`${name}: ${msg}`);
        }
        let content = '';
        let finish: string | null = null;
        let usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0 };
        let ended = false;
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
          while (!ended) {
            const { value, done } = await reader.read();
            if (done) break;
            dog.bump();
            buf += dec.decode(value, { stream: true });
            for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              // Events are one "data:" line each; llama-server reports failures mid-stream as "error:".
              const m = /^(data|error):\s?(.*)$/.exec(line);
              if (!m) continue;
              if (m[2] === '[DONE]') {
                ended = true;
                break;
              }
              const msg = JSON.parse(m[2]!) as Chunk;
              if (m[1] === 'error' || msg.error) throw new ModelError(`${name}: ${errText(msg.error ?? (msg as Chunk['error']))}`);
              const c = msg.choices?.[0];
              const piece = c?.delta?.content ?? '';
              content += piece;
              const stuck = guard.push(piece);
              // Closing the stream stops the generation (llama-server checks the connection).
              if (stuck) throw new CutOffError(`${name}: stopped, ${stuck}`, 'repetition', content);
              if (c?.finish_reason) finish = c.finish_reason;
              if (msg.usage) usage = { input_tokens: msg.usage.prompt_tokens ?? 0, output_tokens: msg.usage.completion_tokens ?? 0 };
            }
          }
        } catch (err) {
          if (err instanceof ModelError) throw err;
          throw offlineFrom(err);
        } finally {
          void reader.cancel().catch(() => {});
        }
        if (!finish) throw new DetectorOfflineError('llama-server stopped answering');
        if (finish === 'length') {
          throw new CutOffError(`${name}: the answer was cut off (${usage.input_tokens || '?'} prompt + ${usage.output_tokens || '?'} answer tokens, limit ${maxTokens} of ${ctx})`, 'length', content, usage);
        }
        let data: T;
        try {
          data = JSON.parse(content) as T;
        } catch {
          throw new ModelError(`${name} returned invalid JSON`);
        }
        return { data, usage };
      } finally {
        dog.stop();
      }
    },
  };
}

/** The model llama-server has loaded (its alias or file name), or null when it doesn't answer. */
export async function llamaCppModel(fetch: FetchLike = globalFetch): Promise<string | null> {
  try {
    const res = await fetch('/v1/models', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return body.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}
