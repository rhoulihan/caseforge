import { describe, it, expect } from 'vitest';
import { createLLM } from './index';
import type { HttpRequest, HttpResponse, Transport } from './transport';
import type { CompleteOptions } from './types';

const opts: CompleteOptions = {
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
};

function recorder(): { transport: Transport; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const res: HttpResponse = {
    status: 200,
    body: JSON.stringify({
      content: [{ type: 'text', text: 'x' }],
      output_text: 'x',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
  return { transport: async (req) => (seen.push(req), res), seen };
}

describe('createLLM', () => {
  it('builds a Claude adapter that hits the Anthropic endpoint', async () => {
    const { transport, seen } = recorder();
    const llm = createLLM('claude', { apiKey: 'sk-ant-x', transport, sleep: async () => {} });
    await llm.complete(opts);
    expect(seen[0]!.url).toContain('anthropic.com');
    expect(seen[0]!.headers['x-api-key']).toBe('sk-ant-x');
  });

  it('builds an OpenAI adapter that hits the Responses endpoint', async () => {
    const { transport, seen } = recorder();
    const llm = createLLM('openai', { apiKey: 'sk-proj-x', transport, sleep: async () => {} });
    await llm.complete(opts);
    expect(seen[0]!.url).toContain('openai.com/v1/responses');
    expect(seen[0]!.headers['authorization']).toBe('Bearer sk-proj-x');
  });

  it('throws on an unknown provider', () => {
    // @ts-expect-error — exercising the runtime guard for a bad provider name
    expect(() => createLLM('gemini', { apiKey: 'x' })).toThrow(/unknown provider/i);
  });
});
