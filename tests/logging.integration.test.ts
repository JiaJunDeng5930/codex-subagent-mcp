import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

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

describe('logging integration', () => {
  it('records codex exec stdout/stderr into dedicated files and references them in logs', async () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'mcp-logs-'));
    tempDirs.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;
    vi.resetModules();
    const { delegateHandler } = await import('../src/codex-subagents.mcp');

    await delegateHandler({ agent: 'orchestrator', task: 'noop' });

    const logDir = join(stateHome, 'codex-subagent-mcp', 'logs');
    const stdoutDir = join(logDir, 'exec-stdout');
    const stderrDir = join(logDir, 'exec-stderr');
    const logFiles = readdirSync(logDir).filter((file) => file.endsWith('.log'));
    expect(logFiles.length).toBeGreaterThan(0);

    const entries = readFileSync(join(logDir, logFiles[0]), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const startEntry = entries.find((entry) => entry.event === 'codex_exec_start');
    const resultEntry = entries.find((entry) => entry.event === 'codex_exec_result');
    expect(startEntry?.stdout_file).toBeTruthy();
    expect(resultEntry?.stdout_file).toBe(startEntry?.stdout_file);
    const stdoutFile = startEntry?.stdout_file as string;
    expect(stdoutFile.startsWith(stdoutDir)).toBe(true);
    expect(existsSync(stdoutFile)).toBe(true);

    expect(startEntry?.stderr_file).toBeTruthy();
    expect(resultEntry?.stderr_file).toBe(startEntry?.stderr_file);
    const stderrFile = startEntry?.stderr_file as string;
    expect(stderrFile.startsWith(stderrDir)).toBe(true);
    expect(existsSync(stderrFile)).toBe(true);
    readFileSync(stderrFile, 'utf8');
    expect(resultEntry).not.toHaveProperty('stderr');
  }, 15000);

  it('writes full stdout to file when run is given a stdout path', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'stdout-'));
    tempDirs.push(temp);
    const stdoutPath = join(temp, 'out.txt');
    const { run } = await import('../src/codex-subagents.mcp');

    const result = await run(process.execPath, ['-e', 'console.log("hello stdout")'], temp, stdoutPath);

    expect(result.stdout).toContain('hello stdout');
    const fileContent = readFileSync(stdoutPath, 'utf8');
    expect(fileContent).toContain('hello stdout');
  });

  it('writes full stderr to file when run is given a stderr path', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'stderr-'));
    tempDirs.push(temp);
    const stderrPath = join(temp, 'err.txt');
    const { run } = await import('../src/codex-subagents.mcp');

    const result = await run(process.execPath, ['-e', 'console.error("hello stderr")'], temp, undefined, stderrPath);

    expect(result.stderr).toContain('hello stderr');
    const fileContent = readFileSync(stderrPath, 'utf8');
    expect(fileContent).toContain('hello stderr');
  });
});
