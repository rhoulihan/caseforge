// The ONLY LLM-touching code in classify. Thin, deterministic wrappers around LLM.complete for
// the two escalation cases heuristics can't resolve: VISION (read a value off a chart image) and
// ambiguous PROSE (label a categorical signal). Hard boundary: the LLM only LABELS roles and READS
// values off pictures/prose — it never computes a stat (stats.ts) or a coverage/tier/total
// (sufficiency.ts). Confidences are emitted RAW; the per-method cap is applied later in sufficiency.

import type { LLM, JsonSchema } from '../provider';
import type { ImagePrimitive, TextPrimitive, TablePrimitive } from '../ingest/types';
import type { SignalSchema } from '../profile/types';
import type { BindingResult } from './types';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of raw bytes — pure, no Buffer/btoa, so it works in the browser and node. */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (bytes[i]! << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(triple >> 18) & 63]! + B64[(triple >> 12) & 63]!;
    out += b1 === undefined ? '=' : B64[(triple >> 6) & 63]!;
    out += b2 === undefined ? '=' : B64[triple & 63]!;
  }
  return out;
}

export const CHART_SCHEMA: JsonSchema = {
  name: 'chart_reading',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['signalId', 'avgPct', 'peakPct', 'confidence'],
    properties: {
      signalId: { type: 'string' },
      avgPct: { type: 'number' },
      peakPct: { type: 'number' },
      confidence: { type: 'number' },
    },
  },
};

export const PROSE_SCHEMA: JsonSchema = {
  name: 'prose_signals',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['bindings'],
    properties: {
      bindings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['signalId', 'value', 'confidence'],
          properties: {
            signalId: { type: 'string' },
            value: { type: 'string' },
            confidence: { type: 'number' },
          },
        },
      },
    },
  },
};

/** Vision: read one chart image into an avgPeak binding. Method 'vision', raw confidence. */
export async function readChartImage(
  llm: LLM,
  img: ImagePrimitive,
  schema: SignalSchema,
  model: string,
): Promise<BindingResult[]> {
  const visionIds = schema.signals.filter((s) => s.derivableBy.includes('vision')).map((s) => s.id);
  const res = await llm.complete({
    model,
    system: `You are reading a monitoring chart. Identify which ONE of these signals it shows: ${visionIds.join(', ')}. Read its average and peak as 0-1 fractions. Reply as JSON. You only READ what the picture shows — never compute or extrapolate.`,
    messages: [
      {
        role: 'user',
        content: 'Identify the signal in this chart and read its average and peak.',
        images: [{ mediaType: img.mime, dataBase64: toBase64(img.bytes) }],
      },
    ],
    jsonSchema: CHART_SCHEMA,
  });
  let parsed: { signalId?: unknown; avgPct?: unknown; peakPct?: unknown; confidence?: unknown };
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return [];
  }
  if (typeof parsed.signalId !== 'string') return [];
  const sig = schema.signals.find((s) => s.id === parsed.signalId);
  if (!sig || sig.valueKind !== 'avgPeak') return []; // vision only reads avgPeak signals (util/iops/ops/concurrency)
  const avgPct = Number(parsed.avgPct);
  const peakPct = Number(parsed.peakPct);
  // The LLM only READS values off the chart — reject anything that is not a 0-1 fraction (NaN, negative, >1).
  if (!Number.isFinite(avgPct) || !Number.isFinite(peakPct) || avgPct < 0 || avgPct > 1 || peakPct < 0 || peakPct > 1) {
    return [];
  }
  return [
    {
      signalId: parsed.signalId,
      value: { avgPct, peakPct },
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
      method: 'vision',
      evidence: [{ source: img.source, primitiveKind: 'image' }],
    },
  ];
}

/** Ambiguous prose/table -> categorical (enum) binds. Method 'llm-text', raw confidence. */
export async function classifyProse(
  llm: LLM,
  p: TextPrimitive | TablePrimitive,
  schema: SignalSchema,
  model: string,
): Promise<BindingResult[]> {
  const text = p.kind === 'text' ? p.text : p.rows.map((r) => r.join(' ')).join('\n');
  const enumIds = schema.signals.filter((s) => s.valueKind === 'enum').map((s) => s.id);
  const res = await llm.complete({
    model,
    system: `Extract any of these categorical signals that the text clearly states: ${enumIds.join(', ')}. Reply JSON {"bindings":[{"signalId","value","confidence"}]}. Only label what the text states — never infer numbers.`,
    messages: [{ role: 'user', content: text }],
    jsonSchema: PROSE_SCHEMA,
  });
  let parsed: { bindings?: unknown };
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed.bindings) ? (parsed.bindings as Array<Record<string, unknown>>) : [];
  return arr
    .filter(
      (b) => b && typeof b.signalId === 'string' && schema.signals.some((s) => s.id === b.signalId && s.valueKind === 'enum'),
    )
    .map((b) => ({
      signalId: b.signalId as string,
      value: String(b.value),
      confidence: typeof b.confidence === 'number' ? b.confidence : 0.6,
      method: 'llm-text' as const,
      evidence: [{ source: p.source, primitiveKind: p.kind }],
    }));
}
