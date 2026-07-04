#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { importTs } from './lib/ts-import.mjs';

const { parseNDJSON, parseSSE, streamAI } = await importTs(path.resolve('src/main/ai-provider.ts'), {
  stubs: {
    http: `
      export function request(options, callback) {
        const harness = globalThis.__aiProviderHttpHarness;
        if (!harness) throw new Error('HTTP harness is not installed');
        return harness.request(options, callback);
      }
      export default { request };
    `,
  },
});

async function collect(generator) {
  const chunks = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

test('SSE parser preserves partial lines and done frames while skipping malformed data', async (t) => {
  const stream = new PassThrough();
  const collecting = collect(parseSSE(stream, (data) => {
    if (data === '[DONE]') return null;
    try {
      return JSON.parse(data).text || null;
    } catch {
      return null;
    }
  }));

  stream.write('data: {"text":"hel');
  stream.write('lo"}\n\n');
  stream.write('event: ignored\n');
  stream.write('data: not json\n');
  stream.write('data: {"text":" world"}\n');
  stream.end('data: [DONE]');

  const chunks = await collecting;
  assert.deepEqual(chunks, ['hello', ' world']);
  t.diagnostic('[ai-stream-parser-stress] sse partial/malformed/done frames preserved');
});

test('NDJSON parser preserves partial objects and skips malformed lines', async (t) => {
  const stream = new PassThrough();
  const collecting = collect(parseNDJSON(stream, (obj) => obj?.text || null));

  stream.write('{"text":"one"}\n{"text":"tw');
  stream.write('o"}\nnot-json\n');
  stream.end('{"text":"three"}');

  const chunks = await collecting;
  assert.deepEqual(chunks, ['one', 'two', 'three']);
  t.diagnostic('[ai-stream-parser-stress] ndjson partial/malformed frames preserved');
});

test('stream parser caps malformed carry and HTTP error bodies', async (t) => {
  const stream = new PassThrough();
  const collecting = collect(parseSSE(stream, (data) => data));
  stream.write('x'.repeat(1_100_000));
  stream.end('\ndata: ok\n');
  assert.deepEqual(await collecting, ['ok']);

  const requests = [];
  globalThis.__aiProviderHttpHarness = {
    request(_options, callback) {
      const req = new PassThrough();
      req.destroyed = false;
      req.destroy = () => {
        req.destroyed = true;
      };
      req.setHeader = () => {};
      req.getHeader = () => undefined;
      req.removeHeader = () => {};
      req.end = () => {
        const response = new PassThrough();
        response.statusCode = 500;
        callback(response);
        response.end('E'.repeat(20_000));
      };
      requests.push(req);
      return req;
    },
  };

  await assert.rejects(
    async () => {
      for await (const _chunk of streamAI({
        enabled: true,
        provider: 'ollama',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
      }, {
        prompt: 'hello',
        model: 'ollama-llama3',
      })) {
        // unreachable
      }
    },
    (error) => {
      assert.match(error.message, /^HTTP 500: E+/);
      assert.ok(error.message.length < 600);
      return true;
    }
  );

  assert.equal(requests.length, 1);
  t.diagnostic('[ai-stream-parser-stress] malformed carry capped and error body reporting bounded');
});
