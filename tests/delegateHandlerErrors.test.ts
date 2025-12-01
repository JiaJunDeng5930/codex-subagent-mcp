import { describe, it, expect } from 'vitest';
import { delegateHandler } from '../src/codex-subagents.mcp';

type DelegateResponse = Awaited<ReturnType<typeof delegateHandler>>;

describe('delegateHandler error surfaces', () => {
  it('rejects unknown agents when no persona is provided', async () => {
    const response: DelegateResponse = await delegateHandler({ agent: 'not-registered', task: 'unregistered-task' });
    expect(response.ok).toBe(false);
    expect(response.stderr).toContain('Unknown agent');
  });

  it('returns numeric code and stderr when codex is missing or fails', async () => {
    const response: DelegateResponse = await delegateHandler({ agent: 'reviewer', task: 'noop-command' });
    expect(typeof response.code).toBe('number');
    expect(typeof response.stderr).toBe('string');
    if (response.code === 127) {
      expect(response.stderr).toContain('codex binary not found');
    }
    if (response.code !== 0) {
      expect(response.ok).toBe(false);
      expect(response.stderr.trim().length).toBeGreaterThan(0);
    } else {
      expect(response.ok).toBe(true);
    }
  });
});
