import { describe, it, expect } from 'vitest';
import { DelegateParamsSchema, prepareWorkingDirectory, mirrorRepoIfRequested, run, loadAgentsFromDir, validateAgents } from '../src/codex-subagents.mcp';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Zod validation', () => {
  it('accepts minimal valid input and defaults mirror_repo', () => {
    // When
    const parsed = DelegateParamsSchema.parse({ agent: 'reviewer', task: 'basic-task' });

    // Then
    expect(parsed.agent).toBe('reviewer');
    expect(parsed.task).toBe('basic-task');
    expect(parsed.mirror_repo).toBe(false);
  });
});

describe('Working directory creation', () => {
  it('creates a temp directory and keeps it for inspection', () => {
    const workingDir = prepareWorkingDirectory('reviewer');
    expect(existsSync(workingDir)).toBe(true);
  });
});

describe('Mirroring', () => {
  it('mirrors directory contents under base cwd', () => {
    const basePath = process.cwd();
    const sourceDir = join(basePath, `tmp-mcp-src-${Date.now()}`);
    const destinationDir = join(basePath, `tmp-mcp-dest-${Date.now()}`);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'file.txt'), 'content', 'utf8');
    mkdirSync(destinationDir, { recursive: true });
    mirrorRepoIfRequested(sourceDir, destinationDir, true);
    expect(existsSync(join(destinationDir, 'file.txt'))).toBe(true);
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destinationDir, { recursive: true, force: true });
  });
});

describe('Spawn wrapper', () => {
  it('returns error when command is missing', async () => {
    const response = await run('non-existent-command-xyz', [], undefined);
    expect(response.code).toBe(127);
  });
});

describe('Custom agents loading', () => {
  it('loads markdown agent definitions with frontmatter', () => {
    const directory = join(tmpdir(), `agents-${Date.now()}`);
    mkdirSync(directory, { recursive: true });
    const markdown = `---\nprofile: debugger\napproval_policy: on-request\nsandbox_mode: workspace-write\n---\nYou are a performance expert.`;
    writeFileSync(join(directory, 'perf.md'), markdown, 'utf8');
    const registry = loadAgentsFromDir(directory);
    expect(registry.perf.profile).toBe('debugger');
    expect(registry.perf.persona).toContain('performance expert');
    expect(registry.perf.approval_policy).toBe('on-request');
    expect(registry.perf.sandbox_mode).toBe('workspace-write');
    rmSync(directory, { recursive: true, force: true });
  });

  it('ignores invalid policy values gracefully', () => {
    const directory = join(tmpdir(), `agents-${Date.now()}`);
    mkdirSync(directory, { recursive: true });
    const markdown = `---\nprofile: reviewer\napproval_policy: unknown\nsandbox_mode: not-a-mode\n---\nPersona text.`;
    writeFileSync(join(directory, 'weird.md'), markdown, 'utf8');
    const registry = loadAgentsFromDir(directory);
    expect(registry.weird.profile).toBe('reviewer');
    expect(registry.weird.approval_policy).toBeUndefined();
    expect(registry.weird.sandbox_mode).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('validate_agents tool logic', () => {
  it('reports errors and warnings per file', async () => {
    const baseDirectory = join(tmpdir(), `agents-validate-${Date.now()}`);
    mkdirSync(baseDirectory, { recursive: true });
    writeFileSync(join(baseDirectory, 'ok.md'), `---\nprofile: reviewer\n---\nPersona ok.`, 'utf8');
    writeFileSync(join(baseDirectory, 'bad.json'), JSON.stringify({ profile: 'debugger', approval_policy: 'nope' }), 'utf8');
    writeFileSync(join(baseDirectory, 'notes.txt'), 'hello', 'utf8');

    const result = await validateAgents(baseDirectory);
    expect(result.dir).toBe(baseDirectory);
    expect(result.summary.files).toBe(3);

    const badFile = result.files.find(file => file.file === 'bad.json');
    expect(badFile?.errors).toBeGreaterThan(0);

    const notesFile = result.files.find(file => file.file === 'notes.txt');
    expect(notesFile?.warnings).toBeGreaterThan(0);

    rmSync(baseDirectory, { recursive: true, force: true });
  });
});
