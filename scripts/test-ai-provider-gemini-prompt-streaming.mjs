#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { importTs } from './lib/ts-import.mjs';

const HTTPS_STUB = `
export function request(options, callback) {
  const harness = globalThis.__geminiHttpsHarness;
  if (!harness) throw new Error('Gemini HTTPS harness is not installed');
  return harness.request(options, callback);
}
export default { request };
`;

const { streamAI } = await importTs(path.resolve('src/main/ai-provider.ts'), {
  stubs: { https: HTTPS_STUB },
});

const GEMINI_CONFIG = {
  enabled: true,
  provider: 'gemini',
  geminiApiKey: 'test-gemini-key',
};

function createGeminiHttpsHarness(harnessOptions = {}) {
  const requests = [];

  return {
    requests,
    request(options, callback) {
      const record = {
        options,
        body: '',
        destroyed: false,
        response: null,
        responseBytesWritten: 0,
      };

      const req = new EventEmitter();
      req.write = (chunk) => {
        record.body += chunk.toString();
        return true;
      };
      req.end = () => {
        if (harnessOptions.requestError) {
          queueMicrotask(() => req.emit('error', harnessOptions.requestError));
          return;
        }
        if (harnessOptions.autoRespond === false) return;
        const response = new PassThrough();
        response.statusCode = harnessOptions.statusCode ?? 200;
        record.response = response;
        callback(response);
        if (harnessOptions.responseBody !== undefined) {
          response.end(harnessOptions.responseBody);
        }
      };
      req.destroy = () => {
        record.destroyed = true;
        record.response?.destroy();
      };

      requests.push(record);
      return req;
    },
  };
}

function installGeminiHarness(options = {}) {
  const harness = createGeminiHttpsHarness(options);
  globalThis.__geminiHttpsHarness = harness;
  return harness;
}

async function waitForRequest(harness) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const request = harness.requests[0];
    if (request) return request;
    await waitImmediate();
  }
  assert.fail('timed out waiting for Gemini HTTPS request');
}

async function waitForRequestResponse(harness) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const request = harness.requests[0];
    if (request?.response) return request;
    await waitImmediate();
  }
  assert.fail('timed out waiting for Gemini HTTPS request');
}

function geminiSseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function geminiTextFrame(parts) {
  return geminiSseFrame({
    candidates: [{ content: { parts } }],
  });
}

function writeResponseChunk(request, chunk) {
  request.responseBytesWritten += Buffer.byteLength(chunk);
  request.response.write(chunk);
}

function endResponse(request, chunk = '') {
  if (chunk) writeResponseChunk(request, chunk);
  request.response.end();
}

async function collectGeminiPrompt(frames, options = {}) {
  const harness = installGeminiHarness();
  const chunks = [];
  const stream = streamAI(GEMINI_CONFIG, {
    prompt: options.prompt || 'Write a concise answer',
    model: 'gemini-gemini-2.5-flash',
    creativity: 0.3,
    systemPrompt: options.systemPrompt,
  });

  const collecting = (async () => {
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  })();

  const request = await waitForRequestResponse(harness);
  for (const frame of frames) writeResponseChunk(request, frame);
  request.response.end();

  return {
    chunks: await collecting,
    request,
  };
}

function legacyGeminiResponseText(parsed) {
  const parts = parsed?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

function trackAbortSignal(signal) {
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const active = new Set();
  const counts = { adds: 0, removes: 0 };

  Object.defineProperty(signal, 'addEventListener', {
    configurable: true,
    value(type, listener, options) {
      if (type === 'abort') {
        counts.adds += 1;
        active.add(listener);
      }
      return originalAdd(type, listener, options);
    },
  });
  Object.defineProperty(signal, 'removeEventListener', {
    configurable: true,
    value(type, listener, options) {
      if (type === 'abort' && active.delete(listener)) {
        counts.removes += 1;
      }
      return originalRemove(type, listener, options);
    },
  });

  return {
    snapshot() {
      return { adds: counts.adds, removes: counts.removes, active: active.size };
    },
  };
}

test('Gemini prompt streaming uses SSE and yields before the response ends', async (t) => {
  const harness = installGeminiHarness();
  const stream = streamAI(GEMINI_CONFIG, {
    prompt: 'Stream this answer',
    model: 'gemini-gemini-2.5-flash',
    creativity: 0.4,
    systemPrompt: 'Keep it short',
  });
  const iterator = stream[Symbol.asyncIterator]();

  let firstSettled = false;
  const firstRead = iterator.next().then((result) => {
    firstSettled = true;
    return result;
  });

  const request = await waitForRequestResponse(harness);
  await waitImmediate();
  assert.equal(firstSettled, false, 'first read should wait for provider bytes');
  assert.match(request.options.path, /:streamGenerateContent\?alt=sse&key=test-gemini-key$/);
  assert.doesNotMatch(request.options.path, /:generateContent\?/);

  const body = JSON.parse(request.body);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Stream this answer' }] }]);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Keep it short' }] });

  const firstFrame = geminiTextFrame([{ text: 'Hello ' }]);
  const secondFrame = geminiTextFrame([{ text: 'world' }]);
  const finishFrame = geminiSseFrame({ candidates: [{ finishReason: 'STOP' }] });
  const totalSseBytes = Buffer.byteLength(firstFrame + secondFrame + finishFrame);

  writeResponseChunk(request, firstFrame);
  const first = await firstRead;
  assert.deepEqual(first, { done: false, value: 'Hello ' });
  assert.equal(request.response.readableEnded, false, 'first chunk should be visible before stream end');

  const bytesBeforeFirstYield = request.responseBytesWritten;
  const secondRead = iterator.next();
  writeResponseChunk(request, secondFrame);
  assert.deepEqual(await secondRead, { done: false, value: 'world' });

  const doneRead = iterator.next();
  endResponse(request, finishFrame);
  assert.deepEqual(await doneRead, { done: true, value: undefined });

  const legacyGenerateContentBody = JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world' }] } }],
  });

  assert.ok(bytesBeforeFirstYield < totalSseBytes);
  t.diagnostic(`legacy generateContent buffered bytes before first yield: ${Buffer.byteLength(legacyGenerateContentBody)}`);
  t.diagnostic(`streamGenerateContent bytes before first yield: ${bytesBeforeFirstYield} of ${totalSseBytes}`);
  t.diagnostic('streamGenerateContent first yield occurred before response end: true');
});

test('Gemini HTTP helper removes abort listeners on success, HTTP error, request error, and abort', async (t) => {
  {
    const controller = new AbortController();
    const counts = trackAbortSignal(controller.signal);
    const harness = installGeminiHarness();
    const stream = streamAI(GEMINI_CONFIG, {
      prompt: 'listener cleanup success',
      model: 'gemini-gemini-2.5-flash',
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const firstRead = iterator.next();
    const request = await waitForRequestResponse(harness);

    assert.deepEqual(counts.snapshot(), { adds: 1, removes: 0, active: 1 });
    endResponse(request, geminiTextFrame([{ text: 'ok' }]));
    assert.deepEqual(await firstRead, { done: false, value: 'ok' });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.deepEqual(counts.snapshot(), { adds: 1, removes: 1, active: 0 });
  }

  {
    const controller = new AbortController();
    const counts = trackAbortSignal(controller.signal);
    installGeminiHarness({ statusCode: 429, responseBody: 'rate limited by test' });
    const stream = streamAI(GEMINI_CONFIG, {
      prompt: 'listener cleanup http error',
      model: 'gemini-gemini-2.5-flash',
      signal: controller.signal,
    });

    await assert.rejects(stream[Symbol.asyncIterator]().next(), /HTTP 429: rate limited by test/);
    assert.deepEqual(counts.snapshot(), { adds: 1, removes: 1, active: 0 });
  }

  {
    const controller = new AbortController();
    const counts = trackAbortSignal(controller.signal);
    installGeminiHarness({ requestError: new Error('socket failed by test') });
    const stream = streamAI(GEMINI_CONFIG, {
      prompt: 'listener cleanup request error',
      model: 'gemini-gemini-2.5-flash',
      signal: controller.signal,
    });

    await assert.rejects(stream[Symbol.asyncIterator]().next(), /socket failed by test/);
    assert.deepEqual(counts.snapshot(), { adds: 1, removes: 1, active: 0 });
  }

  {
    const controller = new AbortController();
    const counts = trackAbortSignal(controller.signal);
    const harness = installGeminiHarness({ autoRespond: false });
    const stream = streamAI(GEMINI_CONFIG, {
      prompt: 'listener cleanup abort',
      model: 'gemini-gemini-2.5-flash',
      signal: controller.signal,
    });
    const pendingRead = stream[Symbol.asyncIterator]().next();
    const request = await waitForRequest(harness);

    controller.abort();

    await assert.rejects(pendingRead, /Request aborted/);
    assert.equal(request.destroyed, true);
    assert.deepEqual(counts.snapshot(), { adds: 1, removes: 1, active: 0 });
  }

  t.diagnostic('before: HTTP helper retained one abort listener on successful, HTTP-error, and request-error requests');
  t.diagnostic('after: tracked AbortSignal counts balanced at adds=1 removes=1 active=0 for success, HTTP error, request error, and abort');
});

test('Gemini prompt SSE extraction preserves final joined text', async () => {
  const legacyShape = {
    candidates: [{
      content: {
        parts: [
          { text: 'Alpha ' },
          { text: 'beta' },
          { inlineData: { mimeType: 'text/plain' } },
          { text: ' gamma' },
        ],
      },
    }],
  };
  const frames = [
    geminiTextFrame([{ text: 'Alpha ' }, { text: 'beta' }, { inlineData: { mimeType: 'text/plain' } }]),
    geminiTextFrame([{ text: ' gamma' }]),
  ];

  const { chunks } = await collectGeminiPrompt(frames);

  assert.deepEqual(chunks, ['Alpha beta', ' gamma']);
  assert.equal(chunks.join(''), legacyGeminiResponseText(legacyShape));
});

test('Gemini prompt streaming preserves finishReason no-text errors', async () => {
  await assert.rejects(
    collectGeminiPrompt([
      geminiSseFrame({ candidates: [{ finishReason: 'SAFETY' }] }),
    ]),
    /Gemini returned no text \(SAFETY\)\./,
  );
});

test('Gemini prompt streaming preserves generic no-text errors', async () => {
  await assert.rejects(
    collectGeminiPrompt([
      geminiSseFrame({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
    ]),
    /Gemini returned no text\./,
  );
});
