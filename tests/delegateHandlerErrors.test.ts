import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function readLogEntries(logPath: string) {
  const content = readFileSync(logPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findLatest<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (predicate(item)) return item;
  }
  return undefined;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('delegateHandler error surfaces', () => {
  it('rejects unknown agents when no persona is provided', async () => {
    vi.resetModules();
    const stateHome = mkdtempSync(join(tmpdir(), 'delegate-error-unknown-'));
    tempDirs.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;

    const { delegateHandler } = await import('../src/codex-subagents.mcp');
    const response = await delegateHandler({ agent: 'not-registered', task: 'unregistered-task' });
    expect(response.stdout).toBeDefined();

    const logPath = join(stateHome, 'codex-subagent-mcp', 'logs', 'mcp.log');
    const entries = readLogEntries(logPath);
    const delegateEntry = findLatest(entries, (entry) => entry.event === 'delegate_result' && entry.agent === 'not-registered');
    expect(delegateEntry?.code).toBe(2);
    expect(String(delegateEntry?.stderr || '')).toContain('Unknown agent');
  });

  it('returns numeric code and stderr when codex is missing or fails', async () => {
    vi.resetModules();
    const stateHome = mkdtempSync(join(tmpdir(), 'delegate-error-codex-'));
    tempDirs.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;

    const { delegateHandler } = await import('../src/codex-subagents.mcp');
    const response = await delegateHandler({ agent: 'reviewer', task: 'noop-command' });
    expect(response.stdout).toBeDefined();

    const logPath = join(stateHome, 'codex-subagent-mcp', 'logs', 'mcp.log');
    const entries = readLogEntries(logPath);
    const delegateEntry = findLatest(entries, (entry) => entry.event === 'delegate_result' && entry.agent === 'reviewer');
    expect(typeof delegateEntry?.code).toBe('number');
    expect(typeof delegateEntry?.stderr).toBe('string');
    if (delegateEntry?.code === 127) {
      expect(String(delegateEntry.stderr)).toContain('codex binary not found');
    }
    if (delegateEntry?.code !== 0) {
      expect(delegateEntry?.ok).toBe(false);
      expect(String(delegateEntry?.stderr || '').trim().length).toBeGreaterThan(0);
    } else {
      expect(delegateEntry?.ok).toBe(true);
    }
  });
});
