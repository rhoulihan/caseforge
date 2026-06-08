// The ONLY LLM-touching code in classify. Two escalation paths heuristics can't resolve:
//   - readArtifactImage  (VISION): read every panel/field of an artifact image into typed bindings + context;
//   - classifyText       (TEXT/TABLE): extract clearly-stated signals + context from prose/tables.
// Hard boundary: the LLM only READS values off pictures/prose — it never computes a stat (stats.ts), a
// coverage/tier/total (sufficiency.ts), or a tier->vCPU conversion (triage does that). Confidences are
// emitted RAW; the per-method cap is applied later in sufficiency. Both return { bindings, qualContext, usage }.

import type { LLM, Usage } from '../provider';
import type { ImagePrimitive, TextPrimitive, TablePrimitive } from '../ingest/types';
import type { SignalSchema, SignalSpec, DerivationMethod } from '../profile/types';
import type { BindingResult, EvidenceRef, SignalValue } from './types';
import { ARTIFACT_SCHEMA, TEXT_SCHEMA } from './llm-schemas';
import { emptyQualContext, type QualContext, type QualContextItem, type QualContextCategory } from './qual-context';
import { assignRoles, type RoleToken } from './role-assign';

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

const ROLE_TO_UTIL: Record<RoleToken, string> = { primary: 'util.primary', secondary: 'util.hoSec', dr: 'util.dr' };
const QUAL_CATEGORIES: readonly string[] = ['concern', 'objection', 'timeline', 'positioning'];

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

interface RawTyped {
  numericValue?: unknown;
  strValue?: unknown;
  avgPct?: unknown;
  peakPct?: unknown;
  confidence?: unknown;
}

/** Validate a raw typed reading against the bound signal's valueKind. Returns null if it doesn't pass.
 *  avgPeak must be two [0,1] fractions with avg<=peak (rejects garbled/inverted reads); scalar must be a
 *  finite non-negative number; enum must be a non-empty string. The LLM-declared kind is ignored — the
 *  SCHEMA's valueKind is authoritative. */
function toBinding(sig: SignalSpec, raw: RawTyped, method: DerivationMethod, evidence: EvidenceRef[], note?: string): BindingResult | null {
  const c = Number(raw.confidence);
  const confidence = Number.isFinite(c) ? clamp01(c) : 0.6;
  let value: SignalValue;
  if (sig.valueKind === 'avgPeak') {
    // Reject null/absent before Number() — Number(null) is 0, which would pass the range guard as {0,0}.
    if (raw.avgPct == null || raw.peakPct == null) return null;
    const avg = Number(raw.avgPct);
    const peak = Number(raw.peakPct);
    if (!Number.isFinite(avg) || !Number.isFinite(peak) || avg < 0 || avg > 1 || peak < 0 || peak > 1 || avg > peak) return null;
    value = { avgPct: avg, peakPct: peak };
  } else if (sig.valueKind === 'scalar') {
    if (raw.numericValue == null) return null; // Number(null) === 0 would bind a bogus 0
    const n = Number(raw.numericValue);
    if (!Number.isFinite(n) || n < 0) return null;
    value = n;
  } else {
    const s = typeof raw.strValue === 'string' ? raw.strValue.trim() : '';
    if (!s) return null;
    value = s;
  }
  return { signalId: sig.id, value, confidence, method, evidence, ...(note ? { note } : {}) };
}

/** Parse the LLM qualContext array → validated items with the local `source` injected (never the LLM's). */
function parseQualContext(rawCtx: unknown, source: string, slug: (s: string) => string): QualContext {
  const arr = Array.isArray(rawCtx) ? (rawCtx as Array<Record<string, unknown>>) : [];
  const items: QualContextItem[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const text = typeof it.text === 'string' ? it.text.trim() : '';
    const category = it.category as QualContextCategory;
    if (!text || !QUAL_CATEGORIES.includes(category)) continue;
    items.push({ text: slug(text), source, category });
  }
  return { items };
}

const signalLines = (schema: SignalSchema, method: DerivationMethod): string =>
  schema.signals.filter((s) => s.derivableBy.includes(method)).map((s) => `${s.id} (${s.label}) — ${s.valueKind}`).join('\n');

/** Vision: read EVERY panel/field of an artifact image into typed bindings + qual context. Per-node util
 *  panels are role-mapped (assignRoles); image-derived context is re-anonymized via `slugger` (F1). */
export async function readArtifactImage(
  llm: LLM,
  img: ImagePrimitive,
  schema: SignalSchema,
  model: string,
  slugger?: (s: string) => string,
): Promise<{ bindings: BindingResult[]; qualContext: QualContext; usage: Usage }> {
  const res = await llm.complete({
    model,
    system:
      `You are reading a customer artifact image (monitoring dashboard, intake form, topology table, or ` +
      `configuration screenshot). Read EVERYTHING — values live in plotted charts AND in table cells and ` +
      `sentences. Emit ONE entry in "panels" for EVERY data point you can read, using the exact panelLabel.\n` +
      `- avgPeak panels (CPU/util/IOPS/ops/concurrency time-series): kind="avgPeak", avgPct and peakPct as 0-1 fractions. ` +
      `For a multi-panel dashboard return ONE entry per panel — never average across panels.\n` +
      `- numeric COUNTS stated anywhere — a label, a table cell, or a sentence: kind="scalar", set numericValue. ` +
      `ALWAYS look for the cluster's shard / data-bearing replica-set count, e.g. "3 shards, each a primary" or ` +
      `"Number of shards: 3" → signalId "cluster.shardCount", numericValue 3. Also node counts and data size.\n` +
      `- categorical labels (cluster tier like M80, edition): kind="enum", set strValue. Emit a tier code under ` +
      `signalId "node.atlasTier" (just the code, e.g. "M80") and do NOT convert it to a vCPU number.\n` +
      `Use ONLY these signalIds (never invent one):\n${signalLines(schema, 'vision')}\n` +
      `In "qualContext", capture any customer concern, objection, deadline, or positioning statement visible as text. ` +
      `You only READ what is shown — never compute or guess. Set unused value fields to null.`,
    messages: [
      {
        role: 'user',
        content: 'Read every panel and data field in this artifact.',
        images: [{ mediaType: img.mime, dataBase64: toBase64(img.bytes) }],
      },
    ],
    jsonSchema: ARTIFACT_SCHEMA,
  });
  const evidence: EvidenceRef[] = [{ source: img.source, primitiveKind: 'image' }];
  const slug = slugger ?? ((s: string) => s);
  let parsed: { panels?: unknown; qualContext?: unknown };
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { bindings: [], qualContext: emptyQualContext(), usage: res.usage };
  }
  const panels = Array.isArray(parsed.panels) ? (parsed.panels as Array<Record<string, unknown>>) : [];
  const byId = new Map(schema.signals.map((s) => [s.id, s]));
  const bindings: BindingResult[] = [];
  const utilPanels: { panelLabel: string; avgPct: number; peakPct: number; confidence: number }[] = [];
  for (const p of panels) {
    const sig = byId.get(String(p.signalId));
    if (!sig) continue; // unknown signalId — drop silently
    // Per-node util panels are role-mapped after the loop; collect the validated avg/peak first.
    if (sig.valueKind === 'avgPeak' && sig.id.startsWith('util.')) {
      if (p.avgPct == null || p.peakPct == null) continue; // Number(null) === 0 would slip a {0,0} util binding through
      const avg = Number(p.avgPct);
      const peak = Number(p.peakPct);
      if (!Number.isFinite(avg) || !Number.isFinite(peak) || avg < 0 || avg > 1 || peak < 0 || peak > 1 || avg > peak) continue;
      const c = Number(p.confidence);
      utilPanels.push({ panelLabel: String(p.panelLabel ?? ''), avgPct: avg, peakPct: peak, confidence: Number.isFinite(c) ? clamp01(c) : 0.6 });
      continue;
    }
    const b = toBinding(sig, p, 'vision', evidence);
    if (b) bindings.push(b);
  }
  if (utilPanels.length) {
    const { roles, heuristicIndices } = assignRoles(utilPanels.map((u) => ({ panelLabel: u.panelLabel, peakPct: u.peakPct })));
    const heuristic = new Set(heuristicIndices);
    utilPanels.forEach((u, i) => {
      const role = roles[i];
      if (!role) return;
      const note = heuristic.has(i) ? 'role assigned by load/positional heuristic — verify the node topology at the gate' : undefined;
      bindings.push({ signalId: ROLE_TO_UTIL[role], value: { avgPct: u.avgPct, peakPct: u.peakPct }, confidence: u.confidence, method: 'vision', evidence, ...(note ? { note } : {}) });
    });
  }
  return { bindings, qualContext: parseQualContext(parsed.qualContext, img.source, slug), usage: res.usage };
}

/** Text/table: extract any clearly-stated signals (scalar/enum/avgPeak) + qual context. Input is already
 *  slugged (anonBundle text), so no re-anonymization is applied here. */
export async function classifyText(
  llm: LLM,
  p: TextPrimitive | TablePrimitive,
  schema: SignalSchema,
  model: string,
): Promise<{ bindings: BindingResult[]; qualContext: QualContext; usage: Usage }> {
  const text = p.kind === 'text' ? p.text : p.rows.map((r) => r.join(' ')).join('\n');
  const res = await llm.complete({
    model,
    system:
      `Extract sizing signals AND qualitative context from the text.\n` +
      `For signals, use ONLY these signalIds and set valueKind to match:\n${signalLines(schema, 'llm-text')}\n` +
      `- scalar: set numericValue. Always look for a stated shard / data-bearing replica-set count ` +
      `(e.g. "3 shards" → cluster.shardCount=3) and node counts. enum: set strValue. avgPeak: set avgPct and ` +
      `peakPct as 0-1 fractions (midpoint of a stated range for avg, the upper bound for peak). Emit an Atlas ` +
      `tier code (just the code, e.g. "M80") under signalId "node.atlasTier" as an enum; do NOT convert it to vCPU.\n` +
      `Only extract values the text CLEARLY states — never infer or compute. Set unused value fields to null.\n` +
      `In "qualContext", extract customer concerns, objections, deadlines (timeline), and positioning statements ` +
      `a solutions engineer would use to frame a business case.`,
    messages: [{ role: 'user', content: text }],
    jsonSchema: TEXT_SCHEMA,
  });
  const evidence: EvidenceRef[] = [{ source: p.source, primitiveKind: p.kind }];
  let parsed: { bindings?: unknown; qualContext?: unknown };
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { bindings: [], qualContext: emptyQualContext(), usage: res.usage };
  }
  const raw = Array.isArray(parsed.bindings) ? (parsed.bindings as Array<Record<string, unknown>>) : [];
  const byId = new Map(schema.signals.map((s) => [s.id, s]));
  const bindings: BindingResult[] = [];
  for (const b of raw) {
    const sig = byId.get(String(b.signalId));
    if (!sig) continue; // unknown signalId — drop
    const bound = toBinding(sig, b, 'llm-text', evidence);
    if (bound) bindings.push(bound);
  }
  // Text primitives are already slugged by the launcher before triage — no re-anonymization here.
  return { bindings, qualContext: parseQualContext(parsed.qualContext, p.source, (s) => s), usage: res.usage };
}
