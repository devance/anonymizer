import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CLI_MAX_OUTPUT, cliClaude } from '../src/cli-claude';
import { CutOffError } from '../src/model';

/** A stand-in `claude` that checks it was locked down, then answers like the real CLI. */
function fakeCli(answer: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const need = [['--tools', ''], ['--setting-sources', ''], ['--strict-mcp-config'], ['--no-session-persistence'], ['--output-format', 'json'], ['-p']];
for (const [flag, value] of need) {
  const i = args.indexOf(flag);
  if (i < 0 || (value !== undefined && args[i + 1] !== value)) { console.log(JSON.stringify({ is_error: true, result: 'missing ' + flag })); process.exit(1); }
}
if (!args.includes('--json-schema') || !args.includes('--system-prompt')) { console.log(JSON.stringify({ is_error: true, result: 'no schema' })); process.exit(1); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const cwd = process.cwd();
  process.stdout.write(${JSON.stringify(answer)}.replace('__INPUT__', JSON.stringify(input)).replace('__CWD__', JSON.stringify(cwd)).replace('__MAXOUT__', JSON.stringify(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '')));
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('cliClaude', () => {
  it('runs the CLI locked down, feeds the document on stdin and returns the structured output', async () => {
    const bin = fakeCli('{"type":"result","is_error":false,"structured_output":{"echo":__INPUT__,"cwd":__CWD__},"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":3}}');
    const claude = cliClaude({ bin });
    const r = await claude.structured<{ echo: string; cwd: string }>('system', 'Jean Tremblay', { type: 'object' });
    expect(r.data.echo).toBe('Jean Tremblay');
    expect(r.data.cwd).toContain('anon-claude-');
    expect(r.usage).toEqual({ input_tokens: 15, output_tokens: 3 });
  });

  it('surfaces CLI errors such as an expired login', async () => {
    const bin = fakeCli('{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired"}');
    await expect(cliClaude({ bin }).structured('s', 'u', {})).rejects.toThrow(/OAuth session expired/);
  });

  it('turns an answer over the output limit into a cut-off, with the limit set explicitly', async () => {
    const limit = fakeCli('{"type":"result","is_error":false,"structured_output":{"max":__MAXOUT__},"usage":{}}');
    expect((await cliClaude({ bin: limit }).structured<{ max: string }>('s', 'u', {})).data.max).toBe(String(CLAUDE_CLI_MAX_OUTPUT));
    const over = fakeCli('{"type":"result","is_error":true,"result":"API Error: Claude\'s response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable."}');
    await expect(cliClaude({ bin: over }).structured('s', 'u', {})).rejects.toBeInstanceOf(CutOffError);
    const stopped = fakeCli('{"type":"result","is_error":false,"stop_reason":"max_tokens","result":"{\\"entities\\":["}');
    await expect(cliClaude({ bin: stopped }).structured('s', 'u', {})).rejects.toBeInstanceOf(CutOffError);
  });
});
