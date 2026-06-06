# Plan 10c — Binary ingest parsers (.xlsx / .pdf / .msg)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Supply the missing `Extractor`s for the three binary `DetectedType`s the Plan 04 ingest core already *detects* but cannot parse (`ooxml`→xlsx, `pdf`, `ole`→msg), turning real customer artifacts into ingest `Primitive`s.

**Architecture:** The ingest core already exposes the seam — `ingest(files, extra: Partial<Record<DetectedType, Extractor>>)`. The only wrinkle: a fidelity PDF parser is **async**, but `Extractor` is sync. So 10c adds an **additive async seam** — `AsyncExtractor` + `ingestAsync` — leaving the sync `ingest` (Plan 04) untouched. Parsing uses **vendored npm libraries** (user decision: fidelity over the lean posture) behind defensive wrappers.

**Libraries (verified working in the vitest/node env via a spike):**
- `exceljs` 4.4 (runtime) — xlsx → rows. Chosen over SheetJS `xlsx` (npm 0.18.5 carries a prototype-pollution CVE for untrusted files; exceljs is npm-native + unaffected).
- `unpdf` 1.6 (runtime) — pdf → text. Wraps a serverless pdfjs build; works in node + browser with **no separate worker file** (matters for the packaged SPA).
- `@kenjiuno/msgreader` 1.28 (runtime) — .msg → subject/body/sender/recipients.
- `pdf-lib` + `cfb` (**dev only**) — generate .pdf and .msg fixtures at test time, so **no binary fixtures are committed**.

**Tech Stack:** TypeScript strict, Vitest (node env). New deps already added via `pnpm add` (lockfile updated; CI uses `pnpm install --frozen-lockfile`).

---

## Locked decisions
- **Additive async seam.** `AsyncExtractor = (name, bytes) => Promise<Primitive[]>`; `ingestAsync(files, extra = BINARY_EXTRACTORS)` mirrors `ingest` but `await`s extractors. Sync `ingest` and its tests are unchanged. The UI (Plan 10e) will call `ingestAsync`.
- **Scope v1 = xlsx + pdf + msg happy paths.** `ooxml` that is docx/pptx, and `ole` that is legacy .xls/.doc, parse-fail → `[]` → reported `recognized but no extractor available yet` (the Sufficiency Report surfaces the gap, D7). Embedded images inside binaries are **not** extracted in v1 (standalone png/jpeg/gif remain the image path).
- **Never crash the batch.** Every extractor is wrapped so it returns `[]` on ANY error (malformed/encrypted/wrong-subtype file), and `ingestAsync` also try/catches each extractor call. One bad file → `ok:false` report, never a thrown ingest.
- **Resource caps (untrusted input):** skip a file > **25 MiB** (`note: 'file too large to parse safely'`); truncate extracted text to **2,000,000 chars** and table rows to **50,000** per sheet (note when truncated). Bounds memory against zip-bombs / pathological files.
- **Determinism/anonymization unchanged:** extractors emit `Primitive`s only; the extracted text is anonymized downstream (via the launcher `/anonymize`) before any LLM sees it. No LLM in this layer.

## Files
- Modify: `src/ingest/types.ts` — add `AsyncExtractor`.
- Modify: `src/ingest/ingest.ts` — add `ingestAsync`.
- Create: `src/ingest/binary.ts` — `xlsxExtractor`, `pdfExtractor`, `msgExtractor`, `BINARY_EXTRACTORS`, caps + `cellToString` helper.
- Create: `src/ingest/binary.test.ts` — fixture-generated tests (exceljs/pdf-lib/cfb).

---

### Task 1 — `AsyncExtractor` + `ingestAsync`
- Files: `src/ingest/types.ts`, `src/ingest/ingest.ts`, `src/ingest/ingest.test.ts`
- [ ] Test: `ingestAsync` with a CSV (builtin, sync) and a stubbed async extractor for `pdf` both land in the bundle; an extractor that throws → that file `ok:false`, others unaffected; a file > 25 MiB is skipped with a note.
- [ ] Implement `AsyncExtractor` and `ingestAsync(files, extra = BINARY_EXTRACTORS)` (reuse `builtinExtract`; `await` async extras inside try/catch; enforce the size cap before dispatch).

### Task 2 — `xlsxExtractor` (ooxml → tables)
- Files: `src/ingest/binary.ts`, `src/ingest/binary.test.ts`
- [ ] Test: a workbook (built with exceljs) with 2 sheets → one `TablePrimitive` per sheet, `headers` = row 1, `rows` = the rest, numbers stringified; a non-xlsx ooxml (zip of garbage) → `[]`; row cap truncates + notes.
- [ ] Implement `xlsxExtractor` via `new ExcelJS.Workbook().xlsx.load(bytes.buffer)`, `wb.eachSheet`, `sheet.eachRow` → `cellToString` each cell (handles null/number/date/formula `{result}`/richText `{richText}`). Defensive try/catch → `[]`.

### Task 3 — `pdfExtractor` (pdf → text)
- Files: `src/ingest/binary.ts`, `src/ingest/binary.test.ts`
- [ ] Test: a pdf (built with pdf-lib) containing known text → one `TextPrimitive` whose `text` contains that string; corrupt bytes after `%PDF` → `[]` (no throw); text cap truncates.
- [ ] Implement `pdfExtractor` via `unpdf` `getDocumentProxy(bytes)` + `extractText(pdf, { mergePages: true })`. Defensive try/catch → `[]`.

### Task 4 — `msgExtractor` (ole → text + keyvalue) + `BINARY_EXTRACTORS`
- Files: `src/ingest/binary.ts`, `src/ingest/binary.test.ts`
- [ ] Test: a .msg (built with cfb: `__substg1.0_0037001F` subject, `_1000001F` body, `_0C1A001F` sender) → a `TextPrimitive` (body) + a `KeyValuePrimitive` (`subject`/`from`); a non-msg ole → `[]`. `BINARY_EXTRACTORS` maps `{ ooxml: xlsxExtractor, pdf: pdfExtractor, ole: msgExtractor }`.
- [ ] Implement `msgExtractor` via `new MsgReader(arrayBuffer).getFileData()` → body Text + subject/from/to KeyValue (omit empty fields). Defensive try/catch → `[]`. Export `BINARY_EXTRACTORS`.

### Task 5 — End-to-end ingest integration
- Files: `src/ingest/binary.test.ts`
- [ ] Test: `ingestAsync([xlsxFile, pdfFile, msgFile, csvFile])` (all fixture-generated) → an `EvidenceBundle` whose `files` reports are all `ok:true` with the right `DetectedType`, and `primitives` include the expected table/text/keyvalue. Proves detection → dispatch → extraction wires end-to-end.

## Self-Review
- Reuses the Plan 04 seam; sync `ingest` + its tests untouched (additive async path).
- Libraries empirically verified in vitest/node before commit; fixtures generated at test time (no committed binaries; dev-only `pdf-lib`/`cfb`).
- Untrusted-input hardening: size cap, output truncation, total crash-isolation (extractor → `[]`, never throws).
- Security-focused adversarial review before merge (zip-bomb / malformed-file / crash-isolation / memory).
