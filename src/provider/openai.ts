// OpenAILLM — OpenAI Responses API (https://api.openai.com/v1/responses). buildRequest /
// parseResponse are pure for direct wire-shape testing; OpenAILLM wires them to an injected
// transport + retry.
//
// The Responses API stores responses server-side for ~30 days by default (store:true); we
// send store:false for the zero-retention posture (design D6). API data is not used for
// training by default.

import type { CompleteOptions, CompleteResult, LLM, Message } from './types';
import type { HttpRequest, HttpResponse, Transport } from './transport';
import { fetchTransport } from './transport';
import { ProviderError, classifyStatus } from './errors';
import { withRetry, realSleep, type RetryConfig, type Sleep } from './retry';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const WEB_SEARCH_TOOL = { type: 'web_search' };
const DEFAULT_RETRY: RetryConfig = { maxRetries: 2, baseDelayMs: 500 };

function inputParts(m: Message): unknown[] {
  const parts: unknown[] = [];
  if (m.content) parts.push({ type: 'input_text', text: m.content });
  for (const img of m.images ?? []) {
    // Responses API: input_image.image_url is the data-URL STRING itself (NOT a { url } object — that
    // is the Chat Completions shape, which the Responses API rejects with a 400 invalid_type).
    parts.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.dataBase64}` });
  }
  return parts;
}

export function buildRequest(opts: CompleteOptions, apiKey: string): HttpRequest {
  const body: Record<string, unknown> = {
    model: opts.model,
    input: opts.messages.map((m) => {
      const content = inputParts(m);
      if (content.length === 0) {
        throw new ProviderError({
          kind: 'invalid_request',
          provider: 'openai',
          retryable: false,
          message: `message (role=${m.role}) has no content — empty text and no images`,
        });
      }
      return { role: m.role, content };
    }),
    store: false,
  };
  if (opts.system) body.instructions = opts.system;
  if (opts.webSearch) body.tools = [WEB_SEARCH_TOOL];
  if (opts.maxTokens !== undefined) body.max_output_tokens = opts.maxTokens;
  if (opts.jsonSchema) {
    body.text = {
      format: { type: 'json_schema', name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
    };
  }
  return {
    url: ENDPOINT,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

interface ResponsesOutputItem {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

export function parseResponse(http: HttpResponse, apiKey: string): CompleteResult {
  if (http.status < 200 || http.status >= 300) {
    const kind = classifyStatus(http.status);
    throw new ProviderError({
      kind,
      provider: 'openai',
      status: http.status,
      retryable: kind === 'rate_limit' || kind === 'server',
      message: `OpenAI API error ${http.status}: ${http.body}`,
      apiKey,
    });
  }
  let json: {
    output_text?: string;
    output?: ResponsesOutputItem[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    json = JSON.parse(http.body);
  } catch {
    throw new ProviderError({
      kind: 'unknown',
      provider: 'openai',
      status: http.status,
      retryable: false,
      message: `OpenAI returned a non-JSON body (status ${http.status})`,
    });
  }
  let text = typeof json.output_text === 'string' ? json.output_text : '';
  if (!text && Array.isArray(json.output)) {
    text = json.output
      .filter((item) => item && item.type === 'message' && Array.isArray(item.content))
      .flatMap((item) => item.content!)
      .filter((c) => c && c.type === 'output_text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
  }
  if (text === '') {
    // A 200 with no message text means the response ended on a server tool step
    // (e.g. a web_search_call) rather than a final answer. Surface it loudly instead of a
    // blank result; web-search multi-turn continuation is not supported in v1.
    throw new ProviderError({
      kind: 'unknown',
      provider: 'openai',
      status: http.status,
      retryable: false,
      message: 'OpenAI returned no text content (possible web-search continuation, not supported in v1)',
    });
  }
  return {
    text,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
    // `raw` is the verbatim parsed provider response (no API key — the key travels only in
    // the Authorization header). Callers may read tool/citation items from it, but should
    // not log it wholesale.
    raw: json,
  };
}

export interface OpenAILLMConfig {
  apiKey: string;
  transport?: Transport;
  retry?: RetryConfig;
  sleep?: Sleep;
}

export class OpenAILLM implements LLM {
  private readonly cfg: OpenAILLMConfig;
  constructor(cfg: OpenAILLMConfig) {
    this.cfg = cfg;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const transport = this.cfg.transport ?? fetchTransport;
    const retry = this.cfg.retry ?? DEFAULT_RETRY;
    const sleep = this.cfg.sleep ?? realSleep;
    const req = buildRequest(opts, this.cfg.apiKey);
    return withRetry(
      async () => parseResponse(await transport(req, opts.signal), this.cfg.apiKey),
      retry,
      sleep,
      opts.signal,
    );
  }
}
