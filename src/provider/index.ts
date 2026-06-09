// Provider adapter barrel + factory. The rest of the app depends only on this module and
// the `LLM` interface — never on a specific provider's wire format.

import type { LLM, ProviderName } from './types';
import type { Transport } from './transport';
import type { RetryConfig, Sleep } from './retry';
import { ClaudeLLM } from './claude';
import { OpenAILLM } from './openai';

export type * from './types';
export { ProviderError } from './errors';
export type { ProviderErrorKind, ErrorOrigin } from './errors';
export type { Transport, HttpRequest, HttpResponse } from './transport';
export { fetchTransport } from './transport';
export type { RetryConfig, Sleep } from './retry';
export { ClaudeLLM } from './claude';
export { OpenAILLM } from './openai';

export interface CreateLLMConfig {
  apiKey: string;
  transport?: Transport;
  retry?: RetryConfig;
  sleep?: Sleep;
}

/** Construct the LLM adapter for a provider. Defaults to the real fetch transport + 2 retries. */
export function createLLM(provider: ProviderName, cfg: CreateLLMConfig): LLM {
  switch (provider) {
    case 'claude':
      return new ClaudeLLM(cfg);
    case 'openai':
      return new OpenAILLM(cfg);
    default:
      throw new Error(`unknown provider: ${String(provider)}`);
  }
}

/** The default model id for a provider. The app sends one model id to whatever provider the rep
 *  picked, so it MUST match the provider (an OpenAI key rejects a Claude model id, and vice-versa). */
export function defaultModelFor(provider: ProviderName): string {
  switch (provider) {
    case 'claude':
      return 'claude-opus-4-8';
    case 'openai':
      return 'gpt-5.5';
    default:
      throw new Error(`unknown provider: ${String(provider)}`);
  }
}
