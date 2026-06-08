import { describe, it, expect } from 'vitest';
import { serializeCase, deserializeCase, newCaseId } from './serialize';
import type { WizardState } from '../ui/state';
import type { EvidenceBundle, ImagePrimitive } from '../ingest/types';
import type { DocModel } from '../render/types';
import type { PipelineOutput } from '../orchestrate';

const img = (source: string, bytes: number[]): ImagePrimitive => ({ kind: 'image', source, mime: 'image/png', bytes: new Uint8Array(bytes) });

const bundle: EvidenceBundle = {
  files: [{ name: 'sizing.xlsx', type: 'xlsx', ok: true }],
  primitives: [
    { kind: 'text', source: 'brief.txt', text: 'We engaged Acme Mutual.' },
    img('deck.pdf#p1-img1', [1, 2, 3, 4, 250]),
  ],
};
const anonBundle: EvidenceBundle = {
  files: bundle.files,
  primitives: [
    { kind: 'text', source: 'brief.txt', text: 'We engaged CF_ORG_01.' },
    img('deck.pdf#p1-img1', [9, 8, 7, 6]), // redacted bytes — different from the original
  ],
};
const docModel = { companyName: 'Acme Mutual', discountPct: 15, profileId: 'mongodb' } as unknown as DocModel;
const pipeline: PipelineOutput = {
  docModel,
  rendered: [
    { filename: 'business-case-acme-mutual.html', html: '<h1>BC</h1>' },
    { filename: 'sizing-brief-acme-mutual.html', html: '<h1>SB</h1>' },
    { filename: 'technical-review-acme-mutual.html', html: '<h1>TR</h1>' },
  ],
  usage: { inputTokens: 0, outputTokens: 0 },
  budgetLog: [],
  gate: { items: [], blocked: false, reasons: [] },
};

const state = {
  config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 15 },
  detected: [{ phrase: 'Acme Mutual', type: 'org', occurrences: 1, confidence: 1 }],
  map: [{ phrase: 'Acme Mutual', slug: 'CF_ORG_01' }],
  imagesScanned: true,
  imagesReviewed: true,
  imageReviewKeys: ['1:deck.pdf#p1-img1'],
  imageAcknowledgedIds: ['1:deck.pdf#p1-img1'],
  triage: { bindings: [] },
  gateAnswers: [],
  confirmed: true,
  tcoInputs: null,
  bundle,
  anonBundle,
  pipeline,
  caseId: null,
  rawFiles: [
    { name: 'sizing.xlsx', bytes: new Uint8Array([80, 75, 3, 4, 42]) }, // pretend xlsx bytes
    { name: 'deck.pdf', bytes: new Uint8Array([37, 80, 68, 70]) },
  ],
} as unknown as WizardState;

const meta = { caseId: 'acme-mutual-k9f2a1', createdAt: '2026-06-07T18:00:00Z', updatedAt: '2026-06-07T18:05:00Z' };

describe('archive serialize/deserialize', () => {
  it('round-trips a generated case, image bytes intact, landing on Step 6 with no API key', async () => {
    const zipBytes = await serializeCase(state, meta);
    expect(zipBytes.length).toBeGreaterThan(0);
    const { manifest, state: loaded } = await deserializeCase(zipBytes);

    // Manifest (what the launcher lists)
    expect(manifest.caseId).toBe('acme-mutual-k9f2a1');
    expect(manifest.companyName).toBe('Acme Mutual');
    expect(manifest.discountPct).toBe(15);
    expect(manifest.status).toBe('generated');
    expect(manifest.currentVersion).toBe('001');
    expect(manifest.versions).toHaveLength(1);

    // Hydration lands on Refine, key not carried, caseId bound to this archive
    expect(loaded.step).toBe(6);
    expect(loaded.hasApiKey).toBe(false);
    expect(loaded.caseId).toBe('acme-mutual-k9f2a1');
    expect(loaded.caseCreatedAt).toBe('2026-06-07T18:00:00Z'); // preserved from the manifest for re-saves
    expect(loaded.config!.discountPct).toBe(15);
    expect(loaded.map).toEqual(state.map);
    expect(loaded.confirmed).toBe(true);
    // The per-image acknowledge state round-trips (so a reopened case stays advance-valid)
    expect(loaded.imageReviewKeys).toEqual(['1:deck.pdf#p1-img1']);
    expect(loaded.imageAcknowledgedIds).toEqual(['1:deck.pdf#p1-img1']);

    // Original uploaded files round-trip (the archive's sources/), names + bytes intact
    expect(loaded.rawFiles!.map((f) => f.name)).toEqual(['sizing.xlsx', 'deck.pdf']);
    expect([...loaded.rawFiles![0]!.bytes]).toEqual([80, 75, 3, 4, 42]);

    // Image bytes survive the zip exactly — original AND redacted, kept distinct
    const origImg = loaded.bundle!.primitives.find((p) => p.kind === 'image') as ImagePrimitive;
    const anonImg = loaded.anonBundle!.primitives.find((p) => p.kind === 'image') as ImagePrimitive;
    expect([...origImg.bytes]).toEqual([1, 2, 3, 4, 250]);
    expect([...anonImg.bytes]).toEqual([9, 8, 7, 6]);
    expect(origImg.source).toBe('deck.pdf#p1-img1');

    // Text primitives + the generated deliverables (in order) come back
    const txt = loaded.anonBundle!.primitives.find((p) => p.kind === 'text');
    expect(txt && txt.kind === 'text' ? txt.text : '').toBe('We engaged CF_ORG_01.');
    expect(loaded.pipeline!.docModel!.companyName).toBe('Acme Mutual');
    expect(loaded.pipeline!.rendered.map((r) => r.filename)).toEqual(pipeline.rendered.map((r) => r.filename)); // order preserved
    expect(loaded.pipeline!.rendered[0]!.html).toBe('<h1>BC</h1>');
  });

  it('round-trips a multi-version history (append-on-regen) + the refinement log', async () => {
    const v1 = { id: '001', createdAt: 't1', trigger: 'initial' as const, discountPct: 0, docModel: { companyName: 'Acme Mutual' } as unknown as DocModel, rendered: [{ filename: 'bc.html', html: '<h1>v1</h1>' }] };
    const v2 = { id: '002', createdAt: 't2', trigger: 'refine' as const, discountPct: 15, docModel: { companyName: 'Acme Mutual' } as unknown as DocModel, rendered: [{ filename: 'bc.html', html: '<h1>v2</h1>' }] };
    const s = {
      ...state,
      versions: [v1, v2],
      refinementHistory: [{ ts: 't2', instruction: 'make it concise', slugged: 'make it concise', versionId: '002' }],
      pipeline: { ...pipeline, docModel: v2.docModel, rendered: v2.rendered },
    } as unknown as WizardState;
    const { manifest, state: loaded, refinementHistory } = await deserializeCase(await serializeCase(s, meta));
    expect(manifest.currentVersion).toBe('002');
    expect(manifest.status).toBe('refined'); // >1 version
    expect(manifest.versions.map((v) => v.id)).toEqual(['001', '002']);
    expect(loaded.versions!.map((v) => v.id)).toEqual(['001', '002']); // full history restored
    expect(loaded.versions![1]!.rendered[0]!.html).toBe('<h1>v2</h1>');
    expect(loaded.pipeline!.rendered[0]!.html).toBe('<h1>v2</h1>'); // preview = current (v2)
    expect(refinementHistory[0]!.instruction).toBe('make it concise');
    expect(loaded.refinementHistory![0]!.versionId).toBe('002');
  });

  it('refuses to archive a case that has not been generated', async () => {
    const ungenerated = { ...state, pipeline: null } as unknown as WizardState;
    await expect(serializeCase(ungenerated, meta)).rejects.toThrow(/before it is generated/);
  });

  it('newCaseId is a filesystem-safe slug + timestamp', () => {
    const id = newCaseId('Northwind Mutual, Inc.', new Date('2026-06-07T00:00:00Z'));
    expect(id).toMatch(/^northwind-mutual-inc-[a-z0-9]+$/);
    expect(newCaseId('', new Date('2026-06-07T00:00:00Z'))).toMatch(/^case-[a-z0-9]+$/);
  });
});
