import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeUsage } from '@anon/core';
import { CutOffError, ModelError, type ModelClient } from './model';

/** Claude refused, timed out or returned something unusable. */
export class ClaudeError extends ModelError {}

/** ~100k tokens of text per call. The answer limit makes the parts smaller (detect.ts: planPieces). */
export const CLAUDE_CHUNK_CHARS = 350_000;

/** The CLI's answer limit, set explicitly (CLAUDE_CODE_MAX_OUTPUT_TOKENS) so the parts can be sized for it. */
export const CLAUDE_CLI_MAX_OUTPUT = 32_000;

/** How the CLI says the answer or the context ran out. */
const CUT_OFF = /output token maximum|context window limit|max_tokens/i;

/**
 * Claude through the `claude` CLI on the VPS owner's subscription.
 *
 * Document text is untrusted: a document could carry instructions. So the CLI
 * runs with no tools at all, no user settings, hooks or MCP servers, in an
 * empty temporary directory, and without saving the session (which would
 * otherwise leave the document's text in ~/.claude on disk).
 */
export function cliClaude(opts: { bin?: string; model?: string; effort?: string; timeoutMs?: number; concurrency?: number } = {}): ModelClient {
  const bin = opts.bin ?? 'claude';
  const limit = opts.concurrency ?? 2;
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (running < limit) {
        running++;
        resolve();
      } else waiting.push(() => (running++, resolve()));
    });
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  return {
    name: `Claude CLI (${opts.model ?? 'default'})`,
    local: false,
    maxChunkChars: CLAUDE_CHUNK_CHARS,
    maxAnswerTokens: CLAUDE_CLI_MAX_OUTPUT,
    async structured<T>(system: string, user: string, schema: Record<string, unknown>) {
      await acquire();
      const dir = await mkdtemp(join(tmpdir(), 'anon-claude-'));
      try {
        const args = [
          '-p',
          '--setting-sources',
          '',
          '--tools',
          '',
          '--strict-mcp-config',
          '--no-session-persistence',
          '--model',
          opts.model ?? 'opus',
          '--effort',
          opts.effort ?? 'medium',
          '--output-format',
          'json',
          '--system-prompt',
          system,
          '--json-schema',
          JSON.stringify(schema),
        ];
        const out = await run(bin, args, user, dir, opts.timeoutMs ?? 10 * 60_000, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(CLAUDE_CLI_MAX_OUTPUT) });
        let parsed: {
          is_error?: boolean;
          stop_reason?: string | null;
          result?: string;
          structured_output?: unknown;
          usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
        };
        try {
          parsed = JSON.parse(out);
        } catch {
          throw new ClaudeError(`claude CLI returned something that isn't JSON: ${out.slice(0, 200)}`);
        }
        const u = parsed.usage ?? {};
        const usage: ClaudeUsage = {
          input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          output_tokens: u.output_tokens ?? 0,
        };
        if (parsed.stop_reason === 'max_tokens' || (parsed.is_error && CUT_OFF.test(parsed.result ?? ''))) {
          // The CLI hands back no partial answer: the split halves are asked from scratch.
          throw new CutOffError(`claude CLI: the answer was cut off${parsed.is_error && parsed.result ? ` (${parsed.result.slice(0, 200)})` : ''}`, 'length', '', usage);
        }
        if (parsed.is_error) throw new ClaudeError(`claude CLI: ${parsed.result ?? 'unknown error'}`);
        const data = (parsed.structured_output ?? JSON.parse(parsed.result ?? 'null')) as T;
        if (data === null || data === undefined) throw new ClaudeError('claude CLI returned no structured output');
        return { data, usage };
      } finally {
        await rm(dir, { recursive: true, force: true });
        release();
      }
    },
  };
}

function run(bin: string, args: string[], stdin: string, cwd: string, timeoutMs: number, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ClaudeError(`claude CLI timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ClaudeError(`could not start the claude CLI: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      // The CLI reports API-side errors as JSON on stdout with a non-zero exit; let the caller read them.
      if (code !== 0 && !out.trim().startsWith('{')) {
        reject(new ClaudeError(`claude CLI exited with ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`));
      } else resolve(out);
    });
    child.stdin.end(stdin);
  });
}
