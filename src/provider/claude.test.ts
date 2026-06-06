import { describe, it, expect } from 'vitest';
import { ClaudeLLM, buildRequest, parseResponse } from './claude';
import type { HttpRequest, HttpResponse, Transport } from './transport';
import { ProviderError } from './errors';
import type { CompleteOptions } from './types';

const KEY = 'sk-ant-secret-XYZ';

const base: CompleteOptions = {
  model: 'claude-opus-4-8',
  system: 'You are a sizing analyst.',
  messages: [
    {
      role: 'user',
      content: 'What is in this chart?',
      images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }],
    },
  ],
};

function body(req: HttpRequest): Record<string, unknown> {
  return JSON.parse(req.body) as Record<string, unknown>;
}

describe('claude buildRequest', () => {
  it('targets the Messages API with all required headers incl. the browser-access header', () => {
    const req = buildRequest(base, KEY);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.method).toBe('POST');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('builds model, default max_tokens, system, and text+image content blocks', () => {
    const b = body(buildRequest(base, KEY));
    expect(b.model).toBe('claude-opus-4-8');
    expect(b.max_tokens).toBe(8192);
    expect(b.system).toBe('You are a sizing analyst.');
    const msgs = b.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content[0]).toEqual({ type: 'text', text: 'What is in this chart?' });
    expect(msgs[0]!.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('honors an explicit maxTokens', () => {
    expect(body(buildRequest({ ...base, maxTokens: 1024 }, KEY)).max_tokens).toBe(1024);
  });

  it('adds the GA web_search tool only when webSearch is set', () => {
    expect(body(buildRequest(base, KEY)).tools).toBeUndefined();
    const b = body(buildRequest({ ...base, webSearch: true }, KEY));
    expect(b.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search' }]);
  });

  it('adds output_config.format only when a jsonSchema is given', () => {
    expect(body(buildRequest(base, KEY)).output_config).toBeUndefined();
    const schema = { type: 'object', properties: {}, additionalProperties: false, required: [] };
    const b = body(buildRequest({ ...base, jsonSchema: { name: 'sizing', schema } }, KEY));
    expect(b.output_config).toEqual({ format: { type: 'json_schema', schema } });
  });

  it('never sends temperature / top_p / top_k / budget_tokens (Opus 4.8 rejects them)', () => {
    const b = body(buildRequest(base, KEY));
    expect(b).not.toHaveProperty('temperature');
    expect(b).not.toHaveProperty('top_p');
    expect(b).not.toHaveProperty('top_k');
    expect(b).not.toHaveProperty('thinking');
    expect(JSON.stringify(b)).not.toContain('budget_tokens');
  });

  it('throws invalid_request when a message has empty content and no images', () => {
    expect(() => buildRequest({ ...base, messages: [{ role: 'user', content: '' }] }, KEY)).toThrow(
      ProviderError,
    );
  });
});

describe('claude parseResponse', () => {
  it('concatenates text blocks and ignores tool_use / thinking blocks; maps usage', () => {
    const http: HttpResponse = {
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Hello ' },
          { type: 'tool_use', id: 't1', name: 'web_search', input: {} },
          { type: 'text', text: 'world.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 7 },
      }),
    };
    const out = parseResponse(http, KEY);
    expect(out.text).toBe('Hello world.');
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it('throws an auth ProviderError on 401 with the key redacted from the body', () => {
    const http: HttpResponse = {
      status: 401,
      body: JSON.stringify({ error: { message: `invalid key ${KEY}` } }),
    };
    try {
      parseResponse(http, KEY);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const err = e as ProviderError;
      expect(err.kind).toBe('auth');
      expect(err.status).toBe(401);
      expect(err.message).not.toContain(KEY);
    }
  });

  it('throws on a non-JSON body', () => {
    expect(() => parseResponse({ status: 200, body: '<html>oops' }, KEY)).toThrow(ProviderError);
  });

  it('throws on a 200 with no text blocks (server tool pause_turn)', () => {
    const http: HttpResponse = {
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'tool_use', id: 't', name: 'web_search', input: {} }],
        stop_reason: 'pause_turn',
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
    };
    expect(() => parseResponse(http, KEY)).toThrow(/no text/i);
  });
});

// A mock transport that returns a queue of responses and records the requests it saw.
function queueTransport(responses: HttpResponse[]): { transport: Transport; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  let i = 0;
  const transport: Transport = async (req) => {
    seen.push(req);
    return responses[Math.min(i++, responses.length - 1)]!;
  };
  return { transport, seen };
}

const ok: HttpResponse = {
  status: 200,
  body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }),
};

describe('ClaudeLLM.complete', () => {
  it('sends one request and returns the parsed result', async () => {
    const { transport, seen } = queueTransport([ok]);
    const llm = new ClaudeLLM({ apiKey: KEY, transport, retry: { maxRetries: 2, baseDelayMs: 1 }, sleep: async () => {} });
    const out = await llm.complete(base);
    expect(out.text).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain('anthropic.com');
  });

  it('retries a 429 then succeeds', async () => {
    const rate: HttpResponse = { status: 429, body: '{"error":{"message":"slow"}}' };
    const { transport, seen } = queueTransport([rate, ok]);
    const delays: number[] = [];
    const llm = new ClaudeLLM({
      apiKey: KEY,
      transport,
      retry: { maxRetries: 2, baseDelayMs: 10 },
      sleep: async (ms) => void delays.push(ms),
    });
    const out = await llm.complete(base);
    expect(out.text).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(delays).toEqual([10]);
  });
});
