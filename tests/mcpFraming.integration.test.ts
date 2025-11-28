import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

function buildFramedPayload(message: Record<string, unknown>) {
  const jsonText = JSON.stringify(message);
  const body = Buffer.from(jsonText, 'utf8');
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), body]);
}

function readContentLengthFrame(processHandle: ReturnType<typeof spawn>, timeoutMs = 2000): Promise<string> {
  const state = { buffer: Buffer.alloc(0) };

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      processHandle.stdout.off('data', handleData);
    };

    const deliverFirstResponse = (frame: string) => {
      if (isNotification(frame)) return false;
      cleanup();
      resolve(frame);
      return true;
    };

    const handleData = (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      drainFrames(state, deliverFirstResponse);
    };

    processHandle.stdout.on('data', handleData);
  });
}

type FrameState = { buffer: Buffer };

function drainFrames(state: FrameState, onFrame: (frame: string) => boolean) {
  let frame = consumeNextFrame(state);
  while (frame !== null) {
    if (onFrame(frame)) return;
    frame = consumeNextFrame(state);
  }
}

function consumeNextFrame(state: FrameState): string | null {
  const headerEnd = findHeaderEnd(state.buffer);
  if (headerEnd === -1) return null;

  const separatorLength = headerSeparatorLength(state.buffer, headerEnd);
  const headerText = state.buffer.slice(0, headerEnd).toString('utf8');
  const contentLength = parseContentLengthHeader(headerText);
  if (contentLength === null) {
    state.buffer = state.buffer.slice(headerEnd + separatorLength);
    return consumeNextFrame(state);
  }

  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + contentLength;
  if (state.buffer.length < bodyEnd) return null;

  const body = state.buffer.slice(bodyStart, bodyEnd).toString('utf8');
  state.buffer = state.buffer.slice(bodyEnd);
  return body;
}

function findHeaderEnd(buffer: Buffer) {
  const crlfBoundary = buffer.indexOf(Buffer.from('\r\n\r\n'));
  const lfBoundary = buffer.indexOf(Buffer.from('\n\n'));
  if (crlfBoundary === -1 && lfBoundary === -1) return -1;
  if (crlfBoundary === -1) return lfBoundary;
  if (lfBoundary === -1) return crlfBoundary;
  return Math.min(crlfBoundary, lfBoundary);
}

function headerSeparatorLength(buffer: Buffer, headerEnd: number) {
  const usesCrlf = buffer.slice(headerEnd, headerEnd + 2).toString('utf8') === '\r\n';
  return usesCrlf ? 4 : 2;
}

function parseContentLengthHeader(headerText: string) {
  const match = /Content-Length:\s*(\d+)/i.exec(headerText);
  if (!match) return null;
  return parseInt(match[1], 10);
}

function isNotification(bodyText: string) {
  try {
    const parsed = JSON.parse(bodyText);
    return Boolean(parsed && parsed.method && !parsed.result && !parsed.error);
  } catch {
    return false;
  }
}

describe('MCP framing (initialize, tools/list)', () => {
  it('responds to framed initialize and tools/list', async () => {
    const binaryPath = join(process.cwd(), 'dist', 'codex-subagents.mcp.js');
    const child = spawn(process.execPath, [binaryPath], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdin.write(buildFramedPayload({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    const initializeBody = await readContentLengthFrame(child);
    const initializeResponse = JSON.parse(initializeBody);
    expect(initializeResponse.result.serverInfo.name).toBeDefined();

    child.stdin.write(buildFramedPayload({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    const listBody = await readContentLengthFrame(child);
    const listResponse = JSON.parse(listBody) as { result: { tools: Array<{ name: string }> } };
    const toolNames = listResponse.result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['delegate', 'list_agents', 'validate_agents']));

    try {
      child.stdin.end();
      child.kill();
    } catch {
      // ignore when sandbox prevents signals
    }
  });
});
