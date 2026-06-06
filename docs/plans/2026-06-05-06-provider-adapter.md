# Provider Adapter Implementation Plan (plan 06)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** The single provider-specific seam (design spec §5): one `LLM.complete()` interface with `ClaudeLLM` (Anthropic Messages API) and `OpenAILLM` (OpenAI Responses API) behind it. BYO-key, direct-browser-callable, with vision, hosted web search, structured JSON output, retries/backoff, zero-retention defaults (D6), and **API-key redaction** so a key can never leak into an error or log.

**Architecture:** `src/provider/` — `types.ts` (the agnostic `LLM` interface), `errors.ts` (typed `ProviderError` + key redaction), `retry.ts` (deterministic exponential backoff, injectable `sleep`), `transport.ts` (an injectable `Transport` HTTP seam + a thin real `fetchTransport`), `claude.ts` and `openai.ts` (the two implementations, built as a pure request-builder + response-parser around an injected transport), `index.ts` (factory + barrel). Everything is tested against a **mock transport** — no network in tests, fully deterministic.

**Tech Stack:** TypeScript strict / Vitest. No SDK dependency — thin `fetch`-based adapters (per spec §15: "provider SDKs *or* thin fetch wrappers"), which keeps the static-SPA bundle small and the wire shape fully under test.

**Key wire facts (confirmed at build time, 2026-06-05):**
- **Claude** `POST https://api.anthropic.com/v1/messages` — headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`, and **`anthropic-dangerous-direct-browser-access: true`** (enables browser CORS). Body: `{model, max_tokens, system?, messages:[{role, content:[{type:"text",text}|{type:"image",source:{type:"base64",media_type,data}}]}], tools?, output_config?}`. Web search tool: `{type:"web_search_20260209", name:"web_search"}` (GA, no beta header). Structured output: `output_config:{format:{type:"json_schema", schema}}`. Opus 4.8 **rejects** `temperature`/`top_p`/`top_k`/`budget_tokens` (400) — the interface omits them. Response: `{content:[{type:"text",text}|…], stop_reason, usage:{input_tokens, output_tokens}}`. No per-request retention flag — no-train is the API default (ZDR is org-configured); the adapter sends no bogus header.
- **OpenAI** `POST https://api.openai.com/v1/responses` — header `Authorization: Bearer <key>`. Body: `{model, input:[{role, content:[{type:"input_text",text}|{type:"input_image",image_url:{url:"data:<mt>;base64,<data>"}}]}], instructions?, tools?:[{type:"web_search"}], max_output_tokens?, text?:{format:{type:"json_schema",name,schema,strict:true}}, store:false}`. **`store` defaults to true (server retains the response ~30d); the adapter defaults `store:false`** for the zero-retention posture (D6). Response: `{output:[{type:"message",role:"assistant",content:[{type:"output_text",text}]}], output_text, usage:{input_tokens, output_tokens}}`. Browser CORS on `/v1/responses` is reportedly intermittent → network failures classify to a clear typed error.

---

### Task 1 (TS): provider interface + types
- Files: `src/provider/types.ts`
- The agnostic surface (deviates from the §5 sketch in two deliberate ways: images live **per-message** since analysis sends a chart-bearing user turn, and `temperature` is **dropped** because Opus 4.8 rejects it):
  ```ts
  type Role = 'user' | 'assistant';
  interface ImageInput { mediaType: string; dataBase64: string; }
  interface Message { role: Role; content: string; images?: ImageInput[]; }
  interface JsonSchema { name: string; schema: Record<string, unknown>; }
  interface CompleteOptions { system?: string; messages: Message[]; webSearch?: boolean;
    jsonSchema?: JsonSchema; model: string; maxTokens?: number; signal?: AbortSignal; }
  interface Usage { inputTokens: number; outputTokens: number; }
  interface CompleteResult { text: string; usage: Usage; raw: unknown; }
  interface LLM { complete(opts: CompleteOptions): Promise<CompleteResult>; }
  type ProviderName = 'claude' | 'openai';
  ```
- No standalone test (types only); exercised by every later test.

### Task 2 (TS): typed errors + API-key redaction
- Files: `src/provider/errors.ts`, `src/provider/errors.test.ts`
- `ProviderErrorKind = 'auth'|'rate_limit'|'invalid_request'|'server'|'network'|'unknown'`; `class ProviderError extends Error { kind; status?; provider; retryable; }`.
- `classifyStatus(status) → kind` (401/403→auth, 429→rate_limit, 400→invalid_request, ≥500→server, else unknown); `retryable` true for rate_limit/server/network.
- `redactKey(text, key)`: replaces every occurrence of `key` (and, defensively, any `sk-…`/`sk-ant-…`-looking token) with `***`. Used on every message built from a response body.
- Tests (red→green→commit): classify maps the status ranges; a `ProviderError` built from a 401 body that echoes the key **does not contain the key** when stringified (`String(err)` + `err.message`); `redactKey('… sk-ant-abc123 …', 'sk-ant-abc123')` has no key; redaction is a no-op when the key is absent/empty.

### Task 3 (TS): retry with exponential backoff (deterministic)
- Files: `src/provider/retry.ts`, `src/provider/retry.test.ts`
- `withRetry<T>(fn, {maxRetries, baseDelayMs}, sleep)`: calls `fn()`; on a thrown `ProviderError` with `retryable`, waits `baseDelayMs * 2**attempt` (honoring a `retryAfterMs` carried on the error if present) via the injected `sleep`, up to `maxRetries`; re-throws non-retryable immediately; re-throws the last error after exhausting retries. No `Math.random` jitter (deterministic, fine for a single-user local app).
- Tests: succeeds first try (no sleep); retries a 429 then succeeds (asserts the sleep delays via a recording `sleep`); does **not** retry a 400; exhausts and throws after `maxRetries`; honors `retryAfterMs`.

### Task 4 (TS): HTTP transport seam + real fetch transport
- Files: `src/provider/transport.ts`, `src/provider/transport.test.ts`
- `interface HttpRequest { url; method:'POST'; headers; body }`, `interface HttpResponse { status; body }`, `type Transport = (req, signal?) => Promise<HttpResponse>`.
- `fetchTransport`: wraps global `fetch`; maps a thrown `TypeError` (network/CORS) to a `ProviderError{kind:'network', retryable:true}` with a browser-CORS hint; returns `{status, body}` otherwise.
- Tests: stub `globalThis.fetch` to return a 200 → passes through `{status, body}`; stub `fetch` to reject with `TypeError` → throws `ProviderError{kind:'network'}` (and the message mentions CORS); forwards method/headers/body to `fetch`.

### Task 5 (TS): ClaudeLLM
- Files: `src/provider/claude.ts`, `src/provider/claude.test.ts`
- `buildRequest(opts, apiKey) → HttpRequest`: pure; sets the four headers incl. the browser header; body with `model`, `max_tokens` (default 8192), `system?`, `messages` (text + base64 image blocks), `tools:[web_search_20260209]` when `webSearch`, `output_config.format` when `jsonSchema`; **never** sets temperature/top_p/budget_tokens.
- `parseResponse(http) → CompleteResult`: on non-2xx throw a classified, key-redacted `ProviderError`; else concatenate every `content[].type==='text'` block (ignoring tool_use / server_tool_use / web_search results / thinking), map `usage`.
- `ClaudeLLM` implements `LLM` via injected `transport` + `withRetry`.
- Tests (mock transport): request has the browser header + `x-api-key`, `anthropic-version`, default max_tokens, system, an image block from `images`, the web_search tool when enabled, `output_config.format` when `jsonSchema`, and **no `temperature`**; response parse concatenates multiple text blocks and ignores a tool_use block; usage mapped; a 401 → `ProviderError{kind:'auth'}` with the key redacted; a 429 is retried (inject a transport that 429s once then 200s).

### Task 6 (TS): OpenAILLM
- Files: `src/provider/openai.ts`, `src/provider/openai.test.ts`
- `buildRequest(opts, apiKey) → HttpRequest`: `Authorization: Bearer`; body `{model, input (input_text/input_image data-URL parts), instructions:system?, tools:[{type:'web_search'}] when webSearch, max_output_tokens:maxTokens?, text.format when jsonSchema, store:false}`.
- `parseResponse(http) → CompleteResult`: non-2xx → classified redacted error; else prefer `output_text`, else walk `output[].content[].type==='output_text'`; map `usage`.
- `OpenAILLM` implements `LLM` via injected transport + retry.
- Tests (mock transport): `Authorization` header carries the key; an `input_image` data URL is built from `images`; `tools:[{type:'web_search'}]` when enabled; `text.format` when `jsonSchema`; **`store:false` always present**; parse uses `output_text`, and a fallback test where `output_text` is absent walks `output[]`; usage mapped; 401→auth (key redacted); 429 retried.

### Task 7 (TS): factory + barrel
- Files: `src/provider/index.ts`, `src/provider/index.test.ts`
- `createLLM(provider: ProviderName, { apiKey, transport?, retry? }): LLM` — defaults `transport=fetchTransport`, `retry={maxRetries:2, baseDelayMs:500}`. Re-export types.
- Tests: `createLLM('claude', …)` returns something whose `complete` hits the Anthropic URL (assert via an injected mock transport); `createLLM('openai', …)` hits the Responses URL; an unknown provider throws.

## Self-Review
- Realizes spec §5 and the D6 zero-retention posture (OpenAI `store:false`; Anthropic no-train default). Two deliberate, documented deviations from the §5 sketch: per-message images, no `temperature` (Opus-4.8 compatibility).
- Security-sensitive: **key redaction is a tested invariant** (no key in any thrown error), analogous to the anonymizer's leak-check and the charts' `noCollisions`.
- Fully deterministic & offline: the `Transport` seam + injected `sleep` mean zero network and no timers in tests.
- Pure request-builder / response-parser split keeps the wire shape directly assertable. Streaming, thinking/effort, and prompt-caching are **deferred** to the orchestrator plan (YAGNI) behind the same interface.
- Adversarial review before merge (a key leak or a mis-shaped request is a real defect).
