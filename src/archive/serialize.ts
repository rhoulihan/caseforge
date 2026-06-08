// Business-case archive (de)serialization — the SPA owns the zip format; the Go launcher only stores
// the bytes and peeks at manifest.json (see launcher/archive.go). A case is one .zip:
//
//   manifest.json        metadata the launcher lists (caseId, company, status, updatedAt, currentVersion, versions[])
//   state.json           hydratable WizardState (no API key; image bytes externalized to blobs/*.bin)
//   memory-state.json    { currentVersion, refinementHistory } — the resume log
//   versions/NNN/        a content package per generation: docmodel.json + deliverables/*.html + meta.json
//   blobs/*.bin          raw image-primitive bytes referenced from state.json
//
// Image-primitive bytes can't live in JSON, so they're written as blob entries and referenced by path;
// deserialize reads them back. Every generate/refine appends a versions/NNN content package (never
// overwritten); manifest.currentVersion names the latest and memory-state holds the refinement log.

import JSZip from 'jszip';
import type { WizardState, ArchiveVersion, RefinementEntry } from '../ui/state';
import type { EvidenceBundle, Primitive } from '../ingest/types';
import type { PipelineOutput } from '../orchestrate';
import type { DocModel } from '../render/types';

export type { RefinementEntry }; // re-exported for callers that import it alongside the archive API

const SCHEMA_VERSION = 1;

export interface ArchiveMeta {
  caseId: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface ArchiveManifest {
  schemaVersion: number;
  caseId: string;
  companyName: string;
  provider: string;
  discountPct: number;
  status: 'generated' | 'refined';
  createdAt: string;
  updatedAt: string;
  currentVersion: string;
  versions: { id: string; createdAt: string; trigger: 'initial' | 'refine' | 'add-files'; discountPct: number }[];
}

export interface LoadedCase {
  manifest: ArchiveManifest;
  state: Partial<WizardState>; // hydration: lands on step 6, no API key
  refinementHistory: RefinementEntry[];
}

/** A JSON-safe bundle: image primitives carry a `bytesRef` (blob path) instead of raw bytes. */
interface JsonBundle {
  files: EvidenceBundle['files'];
  primitives: (Exclude<Primitive, { kind: 'image' }> | { kind: 'image'; source: string; mime: string; bytesRef: string })[];
}

/** Slugify a company name into the stable part of a caseId. */
function slugCompany(company: string): string {
  const s = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'case';
}

/** A new caseId = slug(company) + '-' + a short base36 timestamp (collision-resistant, filesystem-safe). */
export function newCaseId(company: string, now: Date): string {
  return `${slugCompany(company)}-${now.getTime().toString(36)}`;
}

function bundleToJson(zip: JSZip, bundle: EvidenceBundle, blobPrefix: string): JsonBundle {
  let i = 0;
  const primitives = bundle.primitives.map((p) => {
    if (p.kind === 'image') {
      const bytesRef = `blobs/${blobPrefix}-${i++}.bin`;
      zip.file(bytesRef, p.bytes);
      return { kind: 'image' as const, source: p.source, mime: p.mime, bytesRef };
    }
    return p;
  });
  return { files: bundle.files, primitives };
}

async function bundleFromJson(zip: JSZip, jb: JsonBundle | null): Promise<EvidenceBundle | null> {
  if (!jb) return null;
  const primitives: Primitive[] = await Promise.all(
    jb.primitives.map(async (p) => {
      if (p.kind === 'image') {
        const entry = zip.file(p.bytesRef);
        if (!entry) throw new Error(`archive missing image blob: ${p.bytesRef}`);
        return { kind: 'image', source: p.source, mime: p.mime, bytes: await entry.async('uint8array') };
      }
      return p as Primitive;
    }),
  );
  return { files: jb.files, primitives };
}

/** Serialize a generated case (state.pipeline must have a docModel) into a portable .zip. */
export async function serializeCase(state: WizardState, meta: ArchiveMeta): Promise<Uint8Array> {
  const pipeline = state.pipeline;
  if (!pipeline?.docModel) throw new Error('cannot archive a case before it is generated');
  const config = state.config;
  const discountPct = config?.discountPct ?? 0;
  const zip = new JSZip();

  // Original uploaded files → sources/ (browsable in the zip; restored on open for add-files).
  const sources = (state.rawFiles ?? []).map((f, i) => {
    const path = `sources/${i}-${f.name.replace(/[/\\]/g, '_')}`;
    zip.file(path, f.bytes);
    return { name: f.name, path };
  });

  const stateJson = {
    config,
    detected: state.detected,
    map: state.map,
    imagesScanned: state.imagesScanned,
    imagesReviewed: state.imagesReviewed,
    imageReviewKeys: state.imageReviewKeys,
    imageAcknowledgedIds: state.imageAcknowledgedIds,
    triage: state.triage,
    gateAnswers: state.gateAnswers,
    confirmed: state.confirmed,
    tcoInputs: state.tcoInputs,
    sources,
    bundle: state.bundle ? bundleToJson(zip, state.bundle, 'source') : null,
    anonBundle: state.anonBundle ? bundleToJson(zip, state.anonBundle, 'anon') : null,
  };
  zip.file('state.json', JSON.stringify(stateJson));

  // Content packages — one per generation, never overwritten. Use the state's accumulated versions;
  // fall back to a single 'initial' version derived from the current pipeline (a case saved before any
  // refine, or via an older code path).
  const versions: ArchiveVersion[] =
    state.versions && state.versions.length > 0
      ? state.versions
      : [{ id: '001', createdAt: meta.createdAt, trigger: 'initial', discountPct, docModel: pipeline.docModel, rendered: pipeline.rendered }];
  for (const v of versions) {
    const vdir = `versions/${v.id}`;
    zip.file(`${vdir}/docmodel.json`, JSON.stringify(v.docModel));
    for (const r of v.rendered) zip.file(`${vdir}/deliverables/${r.filename}`, r.html);
    zip.file(`${vdir}/meta.json`, JSON.stringify({ id: v.id, createdAt: v.createdAt, trigger: v.trigger, discountPct: v.discountPct, deliverables: v.rendered.map((r) => r.filename) }));
  }
  const currentVersion = versions[versions.length - 1]!.id;

  zip.file('memory-state.json', JSON.stringify({ currentVersion, refinementHistory: state.refinementHistory ?? [] }));

  const manifest: ArchiveManifest = {
    schemaVersion: SCHEMA_VERSION,
    caseId: meta.caseId,
    companyName: config?.companyName ?? '',
    provider: config?.provider ?? 'claude',
    discountPct,
    status: versions.some((v) => v.trigger === 'refine' || v.trigger === 'add-files') ? 'refined' : 'generated',
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    currentVersion,
    versions: versions.map((v) => ({ id: v.id, createdAt: v.createdAt, trigger: v.trigger, discountPct: v.discountPct })),
  };
  zip.file('manifest.json', JSON.stringify(manifest));

  return zip.generateAsync({ type: 'uint8array' });
}

/** Parse a case .zip back into a hydratable WizardState (lands on Step 6 Refine; no API key). */
export async function deserializeCase(zipBytes: Uint8Array): Promise<LoadedCase> {
  const zip = await JSZip.loadAsync(zipBytes);
  const read = async (path: string): Promise<string> => {
    const f = zip.file(path);
    if (!f) throw new Error(`archive missing ${path}`);
    return f.async('string');
  };
  const manifest = JSON.parse(await read('manifest.json')) as ArchiveManifest;
  const stateJson = JSON.parse(await read('state.json')) as Record<string, unknown> & {
    bundle: JsonBundle | null;
    anonBundle: JsonBundle | null;
    sources?: { name: string; path: string }[];
  };
  const memory = JSON.parse(await read('memory-state.json')) as { currentVersion: string; refinementHistory: RefinementEntry[] };

  // Restore EVERY content package (so the history survives a round trip) — the current one drives the preview.
  const versions: ArchiveVersion[] = await Promise.all(
    manifest.versions.map(async (mv) => {
      const vdir = `versions/${mv.id}`;
      const docModel = JSON.parse(await read(`${vdir}/docmodel.json`)) as DocModel;
      const vmeta = JSON.parse(await read(`${vdir}/meta.json`)) as { deliverables?: string[] };
      const names = Array.isArray(vmeta.deliverables) ? vmeta.deliverables : []; // tolerate a corrupt/old meta
      const rendered = await Promise.all(names.map(async (filename) => ({ filename, html: await read(`${vdir}/deliverables/${filename}`) })));
      return { id: mv.id, createdAt: mv.createdAt, trigger: mv.trigger, discountPct: mv.discountPct, docModel, rendered };
    }),
  );
  const current = versions.find((v) => v.id === manifest.currentVersion) ?? versions[versions.length - 1]!;

  const pipeline: PipelineOutput = {
    docModel: current.docModel,
    rendered: current.rendered,
    usage: { inputTokens: 0, outputTokens: 0 },
    budgetLog: [],
    gate: { items: [], blocked: false, reasons: [] },
  };

  const rawFiles = await Promise.all(
    (stateJson.sources ?? []).map(async (s) => {
      const f = zip.file(s.path);
      return { name: s.name, bytes: f ? await f.async('uint8array') : new Uint8Array() };
    }),
  );

  const state: Partial<WizardState> = {
    step: 6, // open straight into Refine
    caseId: manifest.caseId, // so a refine save updates THIS archive
    caseCreatedAt: manifest.createdAt, // preserve the original creation time across re-saves
    config: stateJson.config as WizardState['config'],
    hasApiKey: false, // session-only; the rep re-enters it to refine
    bundle: await bundleFromJson(zip, stateJson.bundle),
    rawFiles,
    detected: stateJson.detected as WizardState['detected'],
    map: stateJson.map as WizardState['map'],
    anonBundle: await bundleFromJson(zip, stateJson.anonBundle),
    imagesScanned: stateJson.imagesScanned as boolean,
    imagesReviewed: stateJson.imagesReviewed as boolean,
    imageReviewKeys: (stateJson.imageReviewKeys as string[] | undefined) ?? [], // tolerate pre-PR-E archives
    imageAcknowledgedIds: (stateJson.imageAcknowledgedIds as string[] | undefined) ?? [],
    triage: stateJson.triage as WizardState['triage'],
    gateAnswers: stateJson.gateAnswers as WizardState['gateAnswers'],
    confirmed: stateJson.confirmed as boolean,
    tcoInputs: stateJson.tcoInputs as WizardState['tcoInputs'],
    pipeline,
    versions,
    refinementHistory: memory.refinementHistory ?? [],
  };
  return { manifest, state, refinementHistory: memory.refinementHistory ?? [] };
}
