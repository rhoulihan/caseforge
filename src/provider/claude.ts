// ClaudeLLM — Anthropic Messages API (https://api.anthropic.com/v1/messages), built for
// direct browser BYO-key calls. buildRequest / parseResponse are pure so the wire shape is
// directly testable; ClaudeLLM wires them to an injected transport + retry.
//
// Opus 4.8 rejects temperature/top_p/top_k/budget_tokens (400) — we never send them.
// No per-request retention flag exists; no-train is the API default (ZDR is org-configured),
// so we send no retention header.

import type { CompleteOptions, CompleteResult, LLM, Message } from './types';
import type { HttpRequest, HttpResponse, Transport } from './transport';
import { fetchTransport } from './transport';
import { ProviderError, classifyStatus } from './errors';
import { withRetry, realSleep, type RetryConfig, type Sleep } from './retry';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search' };
const DEFAULT_RETRY: RetryConfig = { maxRetries: 2, baseDelayMs: 500 };

function contentBlocks(m: Message): unknown[] {
  const blocks: unknown[] = [];
  if (m.content) blocks.push({ type: 'text', text: m.content });
  for (const img of m.images ?? []) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } });
  }
  return blocks;
}

export function buildRequest(opts: CompleteOptions, apiKey: string): HttpRequest {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: opts.messages.map((m) => {
      const content = contentBlocks(m);
      if (content.length === 0) {
        // The API rejects a message with an empty content array (400); fail early and clearly.
        throw new ProviderError({
          kind: 'invalid_request',
          provider: 'claude',
          retryable: false,
          message: `message (role=${m.role}) has no content — empty text and no images`,
        });
      }
      return { role: m.role, content };
    }),
  };
  if (opts.system) body.system = opts.system;
  if (opts.webSearch) body.tools = [WEB_SEARCH_TOOL];
  if (opts.jsonSchema) {
    body.output_config = { format: { type: 'json_schema', schema: opts.jsonSchema.schema } };
  }
  return {
    url: ENDPOINT,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  };
}

interface AnthropicBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseResponse(http: HttpResponse, apiKey: string): CompleteResult {
  if (http.status < 200 || http.status >= 300) {
    const kind = classifyStatus(http.status);
    throw new ProviderError({
      kind,
      provider: 'claude',
      status: http.status,
      retryable: kind === 'rate_limit' || kind === 'server',
      message: `Claude API error ${http.status}: ${http.body}`,
      apiKey,
    });
  }
  let json: AnthropicResponse;
  try {
    json = JSON.parse(http.body);
  } catch {
    throw new ProviderError({
      kind: 'unknown',
      provider: 'claude',
      status: http.status,
      retryable: false,
      message: `Claude returned a non-JSON body (status ${http.status})`,
    });
  }
  const blocks = Array.isArray(json.content) ? json.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (text === '') {
    // A 200 with no text means the turn ended on a server tool step (stop_reason="pause_turn")
    // rather than a final answer. Surface it loudly instead of returning a blank result;
    // web-search multi-turn continuation is not supported in v1.
    throw new ProviderError({
      kind: 'unknown',
      provider: 'claude',
      status: http.status,
      retryable: false,
      message: `Claude returned no text content (stop_reason=${json.stop_reason ?? 'unknown'}); web-search multi-turn continuation is not supported in v1`,
    });
  }
  return {
    text,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
    // `raw` is the verbatim parsed provider response (no API key — the key travels only in
    // request headers). Callers may read tool results / citations from it, but should not
    // log it wholesale.
    raw: json,
  };
}

export interface ClaudeLLMConfig {
  apiKey: string;
  transport?: Transport;
  retry?: RetryConfig;
  sleep?: Sleep;
}

export class ClaudeLLM implements LLM {
  private readonly cfg: ClaudeLLMConfig;
  constructor(cfg: ClaudeLLMConfig) {
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
