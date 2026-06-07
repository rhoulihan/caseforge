// Structured-output schemas for the artifact (vision) and text extraction calls. The OpenAI adapter
// sends these with strict:true (src/provider/openai.ts), which requires every property to be listed in
// `required` and `additionalProperties:false` everywhere — so the polymorphic value is expressed as four
// always-present NULLABLE fields (numericValue / strValue / avgPct / peakPct) read by `kind`/`valueKind`,
// not an empty `value:{}` (which strict mode rejects). The parser in llm.ts reads only the field(s) that
// match the bound signal's valueKind.

import type { JsonSchema } from '../provider';

/** Qualitative context items — shared by both schemas. `source` is injected in TS, never by the model. */
const QUAL_CONTEXT = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'category'],
    properties: {
      text: { type: 'string' },
      category: { type: 'string', enum: ['concern', 'objection', 'timeline', 'positioning'] },
    },
  },
} as const;

/** Vision: read EVERY panel/field of an artifact image into typed bindings + qualitative context. */
export const ARTIFACT_SCHEMA: JsonSchema = {
  name: 'artifact_reading',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['panels', 'qualContext'],
    properties: {
      panels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'panelLabel', 'signalId', 'numericValue', 'strValue', 'avgPct', 'peakPct', 'confidence'],
          properties: {
            kind: { type: 'string', enum: ['avgPeak', 'scalar', 'enum'] },
            panelLabel: { type: 'string' },
            signalId: { type: 'string' },
            numericValue: { type: ['number', 'null'] },
            strValue: { type: ['string', 'null'] },
            avgPct: { type: ['number', 'null'] },
            peakPct: { type: ['number', 'null'] },
            confidence: { type: 'number' },
          },
        },
      },
      qualContext: QUAL_CONTEXT,
    },
  },
};

/** Text/table: extract any clearly-stated signals (scalar/enum/avgPeak) + qualitative context. */
export const TEXT_SCHEMA: JsonSchema = {
  name: 'text_signals',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['bindings', 'qualContext'],
    properties: {
      bindings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['signalId', 'valueKind', 'numericValue', 'strValue', 'avgPct', 'peakPct', 'confidence'],
          properties: {
            signalId: { type: 'string' },
            valueKind: { type: 'string', enum: ['scalar', 'avgPeak', 'enum'] },
            numericValue: { type: ['number', 'null'] },
            strValue: { type: ['string', 'null'] },
            avgPct: { type: ['number', 'null'] },
            peakPct: { type: ['number', 'null'] },
            confidence: { type: 'number' },
          },
        },
      },
      qualContext: QUAL_CONTEXT,
    },
  },
};
