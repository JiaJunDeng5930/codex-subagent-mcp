import { describe, it, expect } from 'vitest';
import { delegateBatchHandler, delegateHandler } from '../src/codex-subagents.mcp';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function createTempWorkingDir() {
  return mkdtempSync(join(tmpdir(), 'orch-'));
}

describe('delegate basics without request/token', () => {
  it('runs orchestrator agent without request metadata and does not create orchestration artifacts', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    const workingDir = createTempWorkingDir();
    try {
      const response = await delegateHandler({ agent: 'orchestrator', task: 'noop', cwd: workingDir });
      expect(response).toHaveProperty('stdout');
      expect(existsSync(join(workingDir, 'orchestration'))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('delegate_batch', () => {
  it('returns one result per input item in order', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const response = await delegateBatchHandler({
        items: [
          { agent: 'orchestrator', task: 'noop-1' },
          { agent: 'orchestrator', task: 'noop-2' },
        ],
      });
      expect(response.results.length).toBe(2);
      expect(typeof response.results[0].stdout).toBe('string');
      expect(typeof response.results[1].stdout).toBe('string');
    } finally {
      process.env.PATH = originalPath;
    }
  }, 60000);

  it('accepts legacy single-item input shape', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const response = await delegateBatchHandler({ agent: 'orchestrator', task: 'single-review-task' });
      expect(response.results.length).toBe(1);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 60000);
});
