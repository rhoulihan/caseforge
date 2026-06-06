// The provider-agnostic LLM surface (design spec §5). Everything downstream of this
// interface is provider-neutral; only claude.ts / openai.ts know a wire format.
// Two deliberate deviations from the §5 sketch:
//   - images live PER-MESSAGE (the analysis step sends one user turn carrying chart images);
//   - there is NO temperature (Opus 4.8 rejects temperature/top_p/top_k with a 400).

export type Role = 'user' | 'assistant';
export type ProviderName = 'claude' | 'openai';

/** A base64-encoded image attached to a user turn (local files, never a remote URL in v1). */
export interface ImageInput {
  mediaType: string; // e.g. "image/png"
  dataBase64: string; // raw base64 (no data: prefix)
}

export interface Message {
  role: Role;
  content: string;
  images?: ImageInput[];
}

/** A JSON Schema for structured output. `schema` must set `additionalProperties:false` and list `required`. */
export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface CompleteOptions {
  system?: string;
  messages: Message[];
  webSearch?: boolean; // enable the provider's hosted web-search tool
  jsonSchema?: JsonSchema; // constrain output to this schema (text is the JSON string)
  model: string;
  maxTokens?: number;
  signal?: AbortSignal; // cancellation
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompleteResult {
  text: string; // concatenated assistant text (the JSON string when jsonSchema is set)
  usage: Usage;
  raw: unknown; // the parsed provider response, for callers that need tool results/citations
}

export interface LLM {
  complete(opts: CompleteOptions): Promise<CompleteResult>;
}
