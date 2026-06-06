import { describe, it, expect } from 'vitest';
import { OpenAILLM, buildRequest, parseResponse } from './openai';
import type { HttpRequest, HttpResponse, Transport } from './transport';
import { ProviderError } from './errors';
import type { CompleteOptions } from './types';

const KEY = 'sk-proj-secret-XYZ';

const base: CompleteOptions = {
  model: 'gpt-5.5',
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

describe('openai buildRequest', () => {
  it('targets the Responses API with a Bearer key', () => {
    const req = buildRequest(base, KEY);
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('maps system to instructions and builds input_text + input_image (data URL) parts', () => {
    const b = body(buildRequest(base, KEY));
    expect(b.model).toBe('gpt-5.5');
    expect(b.instructions).toBe('You are a sizing analyst.');
    const input = b.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(input[0]!.role).toBe('user');
    expect(input[0]!.content[0]).toEqual({ type: 'input_text', text: 'What is in this chart?' });
    expect(input[0]!.content[1]).toEqual({
      type: 'input_image',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('always sets store:false for the zero-retention posture', () => {
    expect(body(buildRequest(base, KEY)).store).toBe(false);
  });

  it('adds the web_search tool only when webSearch is set', () => {
    expect(body(buildRequest(base, KEY)).tools).toBeUndefined();
    expect(body(buildRequest({ ...base, webSearch: true }, KEY)).tools).toEqual([{ type: 'web_search' }]);
  });

  it('adds text.format only when a jsonSchema is given', () => {
    expect(body(buildRequest(base, KEY)).text).toBeUndefined();
    const schema = { type: 'object', properties: {}, additionalProperties: false, required: [] };
    const b = body(buildRequest({ ...base, jsonSchema: { name: 'sizing', schema } }, KEY));
    expect(b.text).toEqual({ format: { type: 'json_schema', name: 'sizing', schema, strict: true } });
  });

  it('sets max_output_tokens only when maxTokens is given', () => {
    expect(body(buildRequest(base, KEY)).max_output_tokens).toBeUndefined();
    expect(body(buildRequest({ ...base, maxTokens: 2048 }, KEY)).max_output_tokens).toBe(2048);
  });

  it('throws invalid_request when a message has empty content and no images', () => {
    expect(() => buildRequest({ ...base, messages: [{ role: 'user', content: '' }] }, KEY)).toThrow(
      ProviderError,
    );
  });
});

describe('openai parseResponse', () => {
  it('prefers output_text and maps usage', () => {
    const http: HttpResponse = {
      status: 200,
      body: JSON.stringify({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
        output_text: 'hi',
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }),
    };
    const out = parseResponse(http, KEY);
    expect(out.text).toBe('hi');
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('falls back to walking output[].content[] when output_text is absent, ignoring web_search_call items', () => {
    const http: HttpResponse = {
      status: 200,
      body: JSON.stringify({
        output: [
          { type: 'web_search_call', id: 'ws1', status: 'completed' },
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'part 1 ' },
              { type: 'output_text', text: 'part 2' },
            ],
          },
        ],
        usage: { input_tokens: 9, output_tokens: 2 },
      }),
    };
    const out = parseResponse(http, KEY);
    expect(out.text).toBe('part 1 part 2');
    expect(out.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
  });

  it('throws an auth ProviderError on 401 with the key redacted', () => {
    const http: HttpResponse = {
      status: 401,
      body: JSON.stringify({ error: { message: `bad key ${KEY}` } }),
    };
    try {
      parseResponse(http, KEY);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).kind).toBe('auth');
      expect((e as ProviderError).message).not.toContain(KEY);
    }
  });

  it('throws on a non-JSON body', () => {
    expect(() => parseResponse({ status: 200, body: 'not json' }, KEY)).toThrow(ProviderError);
  });

  it('throws on a 200 with no message text (only a web_search_call item)', () => {
    const http: HttpResponse = {
      status: 200,
      body: JSON.stringify({
        output: [{ type: 'web_search_call', id: 'ws', status: 'completed' }],
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
    };
    expect(() => parseResponse(http, KEY)).toThrow(/no text/i);
  });
});

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
  body: JSON.stringify({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }),
};

describe('OpenAILLM.complete', () => {
  it('sends one request to the Responses endpoint and returns the parsed result', async () => {
    const { transport, seen } = queueTransport([ok]);
    const llm = new OpenAILLM({ apiKey: KEY, transport, retry: { maxRetries: 2, baseDelayMs: 1 }, sleep: async () => {} });
    const out = await llm.complete(base);
    expect(out.text).toBe('ok');
    expect(seen[0]!.url).toContain('openai.com/v1/responses');
  });

  it('retries a 500 then succeeds', async () => {
    const fail: HttpResponse = { status: 500, body: '{"error":{"message":"boom"}}' };
    const { transport, seen } = queueTransport([fail, ok]);
    const delays: number[] = [];
    const llm = new OpenAILLM({
      apiKey: KEY,
      transport,
      retry: { maxRetries: 2, baseDelayMs: 20 },
      sleep: async (ms) => void delays.push(ms),
    });
    const out = await llm.complete(base);
    expect(out.text).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(delays).toEqual([20]);
  });
});
