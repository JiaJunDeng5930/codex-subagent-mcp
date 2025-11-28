#!/usr/bin/env tsx
import { spawn } from 'child_process';
import { Buffer } from 'buffer';

type Rpc = {
  send: (method: string, params?: unknown) => Promise<unknown>;
  close: () => void;
};

type FrameState = { buffer: Buffer };
type PendingMap = Map<number, (v: unknown) => void>;

function extractFrame(state: FrameState) {
  const headerEnd = state.buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const header = state.buffer.slice(0, headerEnd).toString('utf8');
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) {
    state.buffer = state.buffer.slice(headerEnd + 4);
    return null;
  }
  const length = parseInt(match[1], 10);
  const bodyEnd = headerEnd + 4 + length;
  if (state.buffer.length < bodyEnd) return null;
  const body = state.buffer.slice(headerEnd + 4, bodyEnd).toString('utf8');
  state.buffer = state.buffer.slice(bodyEnd);
  return body;
}

function dispatchFrame(body: string, pending: PendingMap) {
  const message = JSON.parse(body);
  const responseId = message.id;
  const payload = message.result ?? message.error;
  const resolver = pending.get(responseId);
  if (!resolver) return;
  pending.delete(responseId);
  resolver(payload);
}

function startServer(): Rpc {
  const child = spawn('node', ['dist/codex-subagents.mcp.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const state: FrameState = { buffer: Buffer.alloc(0) };
  const pending: PendingMap = new Map();
  let id = 1;

  child.stdout.on('data', (chunk: Buffer) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    let frame: string | null;
    do {
      frame = extractFrame(state);
      if (frame) dispatchFrame(frame, pending);
    } while (frame);
  });

  const send = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve) => {
      const thisId = id++;
      pending.set(thisId, resolve);
      const payload = Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: thisId, method, params }),
        'utf8'
      );
      const header = Buffer.from(
        `Content-Length: ${payload.length}\r\n\r\n`,
        'utf8'
      );
      child.stdin.write(header);
      child.stdin.write(payload);
    });

  return {
    send,
    close: () => child.kill('SIGTERM'),
  };
}

async function run(cmd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => res({ code: code ?? 0, stdout, stderr }));
    child.on('error', (err) => res({ code: 127, stdout, stderr: String(err) }));
  });
}

async function main() {
  console.log('Building server...');
  const build = await run('npm', ['run', 'build']);
  if (build.code !== 0) {
    console.error(build.stderr || build.stdout);
    process.exit(build.code);
  }

  console.log('Checking codex --version...');
  const ver = await run(process.platform === 'win32' ? 'where' : 'which', ['codex']);
  if (ver.code !== 0) {
    console.warn('codex not found; e2e will still run but will show an actionable error');
  }

  console.log('Starting MCP server...');
  const rpc = startServer();
  await rpc.send('initialize', { clientInfo: { name: 'e2e', version: '0' } });
  const list = await rpc.send('tools/list');
  const listTools = (list as { tools: Array<{ name: string }> }).tools;
  console.log('Tools:', listTools.map((t) => t.name).join(', '));

  const samples = [
    { agent: 'reviewer', task: 'Review the last commit for readability.' },
    { agent: 'debugger', task: 'Reproduce and fix the failing test in foo.spec.ts.' },
    { agent: 'security', task: 'Scan for secrets and unsafe shell usage; propose fixes.' },
  ];

  for (const s of samples) {
    console.log(`\nCalling delegate for agent=${s.agent} ...`);
    const res = await rpc.send('tools/call', {
      name: 'delegate',
      arguments: { agent: s.agent, task: s.task, mirror_repo: false },
    });
    const asText = res?.content?.[0]?.text ?? '';
    console.log(asText);
  }

  rpc.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
