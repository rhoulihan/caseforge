# Design Spec — CaseForge Anonymization

**Date:** 2026-06-04 · **Updated:** 2026-06-07 (current through v0.4.0) · **Status:** Implemented · **Author:** Rick Houlihan + Claude<br>
**One-line:** Before any customer evidence reaches an LLM, CaseForge detects sensitive phrases **locally** (no AI), the rep approves a **fail-closed** phrase→slug map, and the **Go launcher** substitutes slugs for real text. Embedded images are OCR'd and matched text is blacked out the same way. The anonymized content is the only thing that ever leaves the machine.

---

## 1. Why anonymization exists

CaseForge is local-first and BYO-key: customer documents are parsed in the browser, and only the specific evidence sent for analysis goes to the rep's chosen LLM provider (Claude or OpenAI), over a zero-retention endpoint. That "only selected evidence leaves" promise is meaningless if the evidence still carries the customer's name, its people's names, hostnames, and email addresses. Anonymization is the layer that makes the promise real.

Two invariants from the top-level design (`2026-06-04-adb-sizing-app-design.md`) govern this subsystem:

- **The LLM never sees real identifiers.** Detection is local and deterministic — sending raw text to an AI to "find the names" would leak the very names we protect. The engine and the launcher do the work; the LLM only ever sees slugs.
- **Fail closed.** Every step biases toward over-redaction and toward *blocking* rather than *leaking*. When detection is unsure it surfaces a candidate; when an image can't be scanned it's flagged, not silently sent; when an image hasn't been reviewed the wizard won't advance.

## 2. Where it sits in the pipeline

```
Step 2  Drop files ──► ingest/extract ──► EvidenceBundle (text · table · keyvalue · IMAGE primitives)
                                                  │
Step 3  Anonymize  ──► (A) detect phrases LOCALLY (no LLM)         detect.ts
                       (A) scan IMAGES for hidden text (OCR, no LLM, GATE)
                       (B) rep approves the fail-closed map         mapping.ts / Step3Anonymize.tsx
                       (B) launcher replaces text → slugs           launcher/anon + serve.go
                       (B) matched text blacked out of images       src/redaction/*
                                                  │
                                            anonBundle  ── the ONLY thing that reaches the LLM ──►
Step 4  Confirm ──► triage / vision / generate (slugs in, slugs out)
                                                  │
                       launcher /deanonymize restores real phrases in the FINAL prose, locally
```

The determinism boundary still holds: the engine computes every authoritative number, the LLM only researches prices, reads (already-redacted) charts, and writes prose. Anonymization is the gate between "local" and "leaves the machine."

## 3. Local detection — `src/anon/detect.ts`

Detection runs over the whole `EvidenceBundle` with **no LLM**. `corpusOf` flattens every text-bearing primitive into one corpus: text primitives directly, table headers/rows joined with ` | `, and keyvalue values joined with ` | `. The ` | ` delimiter is deliberate — a non-word, non-space separator means a Title-Case proper-noun match cannot run across two unrelated cells (e.g. `Jane Okafor | Northwind …` never matches as one phrase).

`detectCandidates(bundle, companyName)` emits `DetectedPhrase[]` — `{ phrase, type, occurrences, confidence }`, plus an optional `source: 'image'` / `imageSource` tag (see §4). Detection methods, in dedup priority order (first writer wins the type):

| Signal | Regex / rule | Type | Confidence |
|---|---|---|---|
| Company name (always included, even at 0 occurrences) | the rep's `companyName`, plus its salient leading token | `org` | 1.0 / 0.9 |
| Email address | `EMAIL` | `person` | 0.9 |
| IPv4 literal | `IPV4` (added before FQDN so dedup keeps the IP type) | `host` | 0.9 |
| FQDN (3+ dotted labels, e.g. `db.prod.local`) | `FQDN` | `host` | 0.8 |
| Proper noun (2–4 Title-Case words, Unicode-aware `\p{Lu}\p{L}+`) | `PROPER` | `person` (≤2 words) / `term` | 0.6 |
| Standalone surname of each detected person | derived | `person` | 0.5 |

Design choices that make detection trustworthy:

- **Fail-closed bias: over-detect rather than miss.** The rep reviews and removes false positives; the cost of a wrong slug is a slightly awkward prompt, the cost of a missed name is a leak.
- **Unicode-aware names.** `PROPER` uses `\p{Lu}\p{L}+` so accented / non-Latin names (José, Björn) are not silently missed.
- **Surname backstop.** For each detected `person`, the bare surname is also surfaced (lower confidence) so a lone `Okafor` in a table cell doesn't survive un-redacted.
- **Stop-word guard.** A `STOP` set (`The`, `This`, `Table`, `Figure`, `Summary`, …) keeps sentence/heading starts from being mistaken for names; `isStoppy` drops phrases that are *all* stop words.
- **The company name is never dropped.** It's kept in the output even at zero occurrences (so the rep always sees and confirms it); every other phantom with zero occurrences is dropped.
- **Deterministic ordering.** Output is sorted by occurrences desc, then phrase length desc, then alphabetical — stable across runs.

**Known gaps (documented in-code, all caught by the rep's review + manual-add):** all-caps acronyms (IBM/AWS) are *not* auto-detected (would over-redact technical terms like CPU/SQL/ADB); hyphenated/apostrophe names (Jean-Luc, O'Brien) match only their sub-tokens; IDN (accented) emails/domains aren't matched. Third-party org names are added manually.

## 4. The image pipeline

Text baked into a chart or screenshot is exactly the kind of PII the text path can't see — and the LLM's vision model *will* read it. As of v0.4.0 the image path is a first-class part of anonymization, end to end: extract → scan (gate) → redact → review.

### 4.1 Embedded-image extraction — `src/ingest/binary.ts`

Ingest now pulls raster images out of containers and emits them as `image` primitives (`{ kind: 'image', source, mime, bytes }`) so PII inside them becomes reviewable:

- **`.msg` image attachments** (`msgExtractor`) — each attached/embedded image; `innerMsgContent` (embedded emails) is skipped. The attachment index is prefixed into the `source` (`name#att1-chart.png`) so two attachments sharing a filename get distinct labels.
- **OOXML media** (`ooxmlMediaImages`, used by `xlsxExtractor` / `docxExtractor` / `pptxExtractor`) — anything matching `^(word|ppt|xl)/media/[^/]+\.(png|jpe?g|gif|webp)$`.
- **PDF image XObjects** (`pdfEmbeddedImages`) — pdf.js decodes each image to raw pixels, which a dependency-free PNG encoder re-wraps into a real PNG.

Every extractor is crash-isolated (a parse error yields `[]`, reported as not-extracted) and bounded: `MAX_EMBEDDED_IMAGES` (50) per container, `MAX_IMAGE_BYTES` (25 MiB) per image, `MAX_PDF_PAGES_SCANNED` (500). Known PDF gaps: inline images, image masks, and JPXDecode-only images aren't surfaced (pdf.js paints them via ops we don't collect / channel counts it doesn't expose).

### 4.2 Dependency-free PNG encoder — `src/ingest/png.ts`

pdf.js hands back raw pixel buffers, not files. `encodePng(width, height, channels, data)` wraps them into a valid PNG using **stored (uncompressed) zlib blocks** — no canvas, no compression dependency — so it runs identically in Node and the browser. It builds the PNG signature, IHDR, a hand-rolled zlib stream (CMF/FLG `0x7801`, BFINAL/BTYPE=00 stored blocks up to 65535 bytes, Adler-32 trailer), IDAT, and IEND, with CRC-32 per chunk. Grayscale (1ch) → color type 0; RGB (3ch) and RGBA (4ch) → truecolour, with RGBA composited onto a white background so a transparent chart backdrop reads as white for OCR rather than collapsing to black. Output is larger than a compressed PNG, but these images are transient (OCR'd, optionally redacted, then discarded) and size-bounded by the caller.

### 4.3 Step 3 is a two-step flow — `src/ui/steps/Step3Anonymize.tsx`

When the bundle contains images, Step 3 splits into two gated actions:

- **Step A — "Scan {n} image(s) for hidden text."** `scanImagesForText()` dynamically imports the redaction browser entry (code-split — tesseract loads only now), OCRs every image with `recognizeWords`, runs `detectCandidatesInImage(ocrText, source, company)` over the recognized text, and folds the results into the rep's candidate list with `mergeDetected`. Each image-derived phrase is badged in the UI ("from chart.png"). The recognized words are cached in `OcrCache`, **keyed by primitive index** (`Record<number, …>`), so the redaction pass below never OCRs twice.
- **Step B — "Anonymize & continue."** `anonymizeAll()` sends every text primitive through the launcher `/anonymize` and runs `redactImageInBrowser` on every image (reusing that image's cached OCR words), then surfaces each redacted image as a preview the rep checks before continuing.

The **scan is a hard gate**: `needsScan = imageCount > 0 && !state.imagesScanned`, and the Anonymize button is `disabled` while `needsScan`. Images cannot be redacted (or skipped) until they've been scanned and any hidden text folded into the approved map.

`detectCandidatesInImage` and `mergeDetected` (both in `detect.ts`) do the source-tagged detection and the dedup-merge: merge keeps the first occurrence's source tag (text-derived candidates are passed first, so a phrase seen in both stays "text"), accumulates occurrences, and keeps the higher confidence.

### 4.4 OCR redaction — `src/redaction/`

The redaction module is split so its logic is unit-testable under Node (jsdom has no WASM/Worker/canvas) and tesseract stays out of the main bundle:

- **`match.ts` (pure, tested).** `flattenOcrBlocks` flattens a tesseract v6/v7 `Page.blocks` tree to flat `OcrWord[]` (text + pixel bbox + confidence + line index). `phrasesToRedact(map, ocrText, companyName)` = the rep's map (expanded to every case/whitespace/NFC variant via `expandEntries`) **plus** whatever `detectCandidates` finds in the OCR'd text — so an identifier that appears *only* inside a screenshot is still boxed even if the rep never typed it. `computeRedactions(words, phrases, pad=4)` boxes single-token phrases by substring and stitches consecutive same-line words for multi-token phrases, unions their boxes, pads them (fail-closed), and dedupes.
- **`ocr.ts` (browser shim).** `recognizeWords` over tesseract.js v7 (LSTM); WASM + language data **self-hosted under `/tesseract`** (assembled by `scripts/setup-tesseract-assets.mjs`) so it runs fully offline — no third-party network path. `terminateOcr` tears the worker down to free WASM memory.
- **`paint.ts` (browser shim).** Draws the image on an `OffscreenCanvas`, fills opaque `#000000` rectangles over the redaction rects, and re-encodes. JPEG stays JPEG; everything else is re-encoded as PNG (lossless boxes), and the *actual* output MIME is returned so the caller declares the correct `mediaType` to the vision API.
- **`index.ts` (pure orchestrator).** `redactImage(img, map, companyName, deps, precomputed?)` wires OCR + paint + matcher. It accepts `precomputed` OCR words so the redaction reuses the scan-pass OCR instead of running it twice.
- **`browser.ts` (entry).** Injects the real shims (`redactImageInBrowser`) and re-exports `recognizeWords` (the detection-time OCR pass, reused at redaction) and `terminateOcr`.

**Policy = SEND-WITH-WARNING.** OCR is best-effort. If OCR throws, the image is returned un-redacted with a loud warning ("Could not scan this image … it will be sent un-redacted. Review it, or exclude it, before continuing."). If OCR ran but mean confidence is below `LOW_CONFIDENCE` (60), the image carries a low-confidence warning ("a name in this image may not have been caught"). A purely graphical image with no recognized text gets no warning — the rep is the backstop and we don't cry wolf. The rep reviews every redacted preview and can **exclude** any image from the vision pass with a per-image checkbox.

### 4.5 Index-keyed identity (the same-source bug class)

Two images can legitimately share a `source` string (e.g. two identically-named `.msg` attachments, two media files). If OCR cache / preview / exclude state were keyed by source, one image's word boxes could redact the other. Every per-image map — `OcrCache`, the `ImgReview.id`, the `excluded` set, `toggleExclude` — is therefore keyed by the **primitive index within the bundle**, the stable identity. `source` is a display label only.

### 4.6 Hardening (OOM + hang + leak)

- **OOM guards on PDF image decode.** `getDocumentProxy` is given `maxImageSize` so pdf.js refuses an oversized image *before* decoding (a crafted PDF can't OOM the tab); a second pixel-cap (`MAX_PDF_IMAGE_PIXELS`, ~40 MP) re-checks after decode as a backstop.
- **Per-page timeout race.** `withTimeout(extractImages(pdf, p), PDF_IMAGE_EXTRACT_MS=20s)` so a stuck pdf.js object-resolve callback can't wedge ingest — the losing promise keeps running but can no longer block the pipeline.
- **Honest scan-failure messaging.** Images whose OCR throws during the scan are counted (`scanFailures`); the UI says exactly how many couldn't be read and that they'll be re-scanned + flagged at redaction.
- **No leaked object URLs.** Preview object URLs are revoked when replaced (re-scan) or the step unmounts, and on the error path inside `anonymizeAll` (a throw mid-scan doesn't leave previews allocated or a misleading "scanned" state).
- **Back-nav recovery.** If the step remounts with `imagesReviewed` set but no local previews to show, the flag is cleared so the review panel can't be empty-and-unusable.

## 5. The fail-closed map — `src/anon/mapping.ts`

The map is a list of `{ phrase, slug }` entries. The SPA builds and validates it; the **replace runs in the launcher**, never here.

- **Opaque, LLM-stable slugs.** `suggestSlug(category, index)` → `CF_ORG_01`, `CF_PERSON_02`, `CF_HOST_03`, `CF_TERM_04` — zero-padded, category-tagged, and stable so the LLM treats them as consistent tokens. `Step3Anonymize`'s `mapFor` assigns a running per-type index.
- **Case / whitespace / NFC variant expansion (the leak fix, single source of truth).** `expandEntries` expands each entry into all case forms (lower/upper/title), whitespace-collapsed forms, and NFC + NFD Unicode normalizations — all sharing one slug. The launcher is a dumb literal matcher, so a decomposed-Unicode or differently-cased occurrence would otherwise slip through; expansion closes that here, once.
- **Byte-identical TSV with the launcher.** `serializeMap` / `parseMap` use `escapedPhrase \t escapedSlug` per line, escaping `\ \t \n \r`. The format MUST stay byte-identical to `launcher/anon/mapio.go` (it does — both implement the same escape table).
- **`validateMap` (errors + warnings).** Errors: empty phrase, empty slug, slug == phrase (no-op), duplicate slug. Warnings: a phrase that's a substring of another (handled by longest-first ordering, surfaced so the rep understands the behavior).
- **Why fail-closed.** A missing slug would delete a phrase irreversibly (caught); a duplicate slug would make deanonymize ambiguous (caught); an un-expanded variant would leak (expanded away). Each failure mode is a hard error or an automatic fix, never a silent pass-through.

## 6. The launcher substitution — `launcher/anon/anon.go`, `launcher/serve.go`

The replace is a compiled system utility on `127.0.0.1`, never the LLM — real phrases are never rendered into an AI prompt.

- **`/anonymize` (POST).** Parses the pre-expanded TSV map, then **fails closed on a pre-existing slug**: `ScanForSlugs` rejects the request (`400 slug_conflict`) if any slug literal already sits in the *raw* source text — anonymizing would introduce a second, indistinguishable occurrence and corrupt the original on the later deanonymize. `AnonymizeN` then replaces longest-phrase-first in a single left-to-right pass (`replaceSinglePass`), so `Northwind Mutual Insurance` wins over `Northwind` and an emitted slug is never re-scanned.
- **`/deanonymize` (POST).** Reverses slug→phrase (first-wins, longest-first) on the LLM-returned prose. No slug-conflict check (the input is *supposed* to be full of slugs). The response carries real phrases, so it's sent `Cache-Control: no-store, …` and must never be logged.
- **`/health` (GET/HEAD).** Liveness; Step 3 polls it and warns if the launcher isn't reachable.
- **Stateless + security-first.** Each request parses its own map (no server-held secrets). The server binds `127.0.0.1` only (never `0.0.0.0`, no `--bind-addr`), caps bodies at 10 MiB (`MaxBytesReader`), rejects trailing JSON, serves static files through an explicit symlink-resolved path-traversal guard, and caps slow-header clients (`ReadHeaderTimeout`). Stdlib only.

Note the deliberate split: the endpoint is a **dumb literal matcher** and does *not* call `anon.Validate` (which rejects duplicate slugs to guard invertibility of an *un-expanded* table) — the SPA's `validateMap` owns semantic checks, and the map arrives pre-expanded with variants legitimately sharing slugs.

## 7. The fail-closed step gate — `src/ui/state.ts`

`stepValidity(state)` is a pure function (unit-tested without a DOM) that decides whether each wizard step may advance. For Step 3:

```
anonHasImages = anonBundle has any image primitive
anonOk        = !!anonBundle && (!anonHasImages || imagesReviewed)
3: setupOk && filesOk && anonOk
```

So an `anonBundle` that contains an image is **not advance-valid until the images have been reviewed** (`imagesReviewed`). Combined with the in-step scan gate (§4.3), a rep cannot reach Confirm/Generate with an unscanned or unreviewed image. `WizardState` tracks both flags explicitly — `imagesScanned` (OCR'd + folded into the list, or none present) and `imagesReviewed` (redacted + reviewed, or none present) — and both reset to `false` whenever the candidate list changes, forcing a re-anonymize so a stale redaction can never slip through.

## 8. End-to-end guarantee

1. Files are parsed in the browser; nothing has left the machine.
2. Detection is local and deterministic; the LLM is never asked to find names.
3. The rep approves a fail-closed map; variants are auto-expanded; the map is validated.
4. Images are OCR'd locally; hidden text is folded into the same approved map; matched text is blacked out; every preview is reviewed (or the image is excluded).
5. The launcher substitutes slugs for real text *before* the first AI call; a pre-existing slug hard-fails.
6. The **anonymized bundle is the only thing that reaches the LLM** — for triage, vision, and generation alike.
7. The launcher restores real phrases in the final prose locally, on a no-store response.

Each step over-redacts rather than under-redacts and blocks rather than leaks. That is what "fail-closed anonymization" means in CaseForge.

## 9. Status & testing

Implemented and shipping (v0.4.0). The pure cores — `detect.ts`, `mapping.ts`, `ingest/png.ts`, and `state.ts`'s `stepValidity` — are covered by the Vitest suite, and the launcher by Go tests, both gated in CI. **Update (v0.4.0):** the local OCR image-redaction subsystem this section described (`redaction/match.ts`, `ocr.ts`, `paint.ts`) was **removed before release** — it garbled real dashboards and the WASM+canvas path couldn't be CI-verified. Images now go to the AI's vision model **as-is**, gated by a per-image human review/acknowledge in Step 3; text anonymization (detect → rep-approved map → launcher slug-replace) is unchanged and fully tested.