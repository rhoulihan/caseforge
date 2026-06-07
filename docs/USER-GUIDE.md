# CaseForge — Sales Rep Guide

**Turn a folder of whatever the customer sent you into a sizing, a customer proposal, and a TCO business case — in a few minutes, on your own laptop.**

You don't need to be technical to use CaseForge. This guide walks you through it start to finish. If you can drag files into a window and click "Next," you can do this.

> *Updated 2026-06-07 — reflects the current design through v0.4.0: the home screen of saved cases, the two-step Scan-images-then-Anonymize flow in Step 3, the broadened set of file types, a customer discount, regenerating with up-to-date numbers, adding files to a saved case, and the in-app Help, About, and error-report dialog.*

---

## In one minute

1. Get an API key from **Claude** or **OpenAI** (one-time — see [Get an API key](#1-get-an-api-key-one-time)).
2. Download CaseForge for your computer, unzip it, and **double-click the start file**. Your browser opens.
3. Walk the in-app wizard: **Setup → Drop files → Anonymize → Confirm → Generate → Refine → Export.**
4. Download three polished documents to share.

**Your customer's files never leave your laptop, and real names are scrambled before anything is sent to the AI** — including text found inside chart and screenshot images. More on that in [Is this safe?](#is-this-safe).

---

## What you need

- **A Windows, Mac, or Linux laptop.** Nothing to install — CaseForge is a single download.
- **An API key** from Claude (Anthropic) or OpenAI. This is how CaseForge uses the AI, billed to *your* account. Getting one takes a few minutes the first time.
- **The customer's files** — whatever they sent. CaseForge reads a broad set of formats (full list below), figures out what's useful, and ignores the rest.

### Files CaseForge can read

| Kind | Formats |
| --- | --- |
| Spreadsheets | `.xlsx` |
| Word documents | `.docx` |
| PowerPoint | `.pptx` |
| PDFs | `.pdf` |
| Email | `.msg`, `.eml` |
| Web / markup | `.html`, `.xml`, `.rtf` |
| Text data | `.csv`, `.tsv`, `.json`, `.txt`, `.md` |
| Chart / screenshot images | `.png`, `.jpg`, `.gif`, `.webp` |

CaseForge also pulls images *out of* your documents — charts pasted into a `.docx`/`.pptx`/`.xlsx`, image attachments on a `.msg` email, and pictures embedded in a PDF — so anything hidden in them gets reviewed too (see Step 3).

> Legacy `.xls` and `.doc` aren't read. Re-save them as `.xlsx` / `.docx`, or export to PDF, and drop those in instead.

---

# Before you begin (one-time setup)

## 1. Get an API key (one time)

An "API key" is a long password that lets CaseForge use the AI on your behalf. You do this once, then paste the same key each time.

**Claude (Anthropic):**
1. Go to **console.anthropic.com** and sign in (or sign up).
2. Open **API Keys** → **Create Key**. Name it something like "CaseForge."
3. Copy the key (it starts with `sk-ant-…`). **You can only view it once**, so paste it somewhere you'll find again (a password manager or a note to yourself) before you leave the page.
4. The account needs a little credit — a few dollars covers many runs.

**OpenAI:**
1. Go to **platform.openai.com** and sign in.
2. Open **API keys** → **Create new secret key**. Copy the key (starts with `sk-…`). **You can only view it once** — save it before leaving the page.
3. Make sure the account has a little credit.

> Keep your key private — treat it like a password. CaseForge keeps it **only in your browser for the current session** and never saves it to disk.

## 2. Download and launch CaseForge

1. **Download** the file for your computer from the CaseForge releases page:
   - Windows → `caseforge-windows-amd64.zip`
   - Mac (Apple Silicon — M1/M2/M3/M4) → `caseforge-darwin-arm64.zip`
   - Mac (Intel) → `caseforge-darwin-amd64.zip`
   - Linux → `caseforge-linux-amd64.zip`
   - Linux on ARM (Raspberry Pi, AWS Graviton) → `caseforge-linux-arm64.zip`

   *Not sure which Mac you have?* Click the Apple menu (top-left) → **About This Mac**. "Chip: Apple M…" = Apple Silicon; "Processor: Intel" = Intel.
2. **Unzip it** (double-click the `.zip`). You get a folder with a few files, including a **start** file and a `Guide.md` (this guide).
3. **Double-click the start file** for your computer:
   - Windows → **`start-windows.bat`**
   - Mac → **`start-mac.command`**
   - Linux → **`start-linux.sh`**
4. A small black window appears (that's normal — leave it open), and **your web browser opens to CaseForge.** If the browser doesn't open on its own, see [Troubleshooting](#troubleshooting).

### First time only: allow the app to run

Because CaseForge isn't from an app store, your computer warns you the first time. This is expected:

- **Windows:** a box says *"Windows protected your PC."* Click **More info**, then **Run anyway**.
- **Mac:** if you see *"…cannot be opened because it is from an unidentified developer,"* click **Cancel**, then **right-click** (or Control-click) the **`start-mac.command`** file → **Open** → **Open**. You only do this once. (If it still won't run, open **System Settings → Privacy & Security**, scroll down, click **Open Anyway**, and double-click the start file again.)
- **Linux:** double-click `start-linux.sh` and choose **Run** if prompted. If your system won't run it that way, it needs a terminal command your IT team can help with — share the message you see.

> Everything runs **on your laptop only** (at `127.0.0.1`, which means "this computer"). Nothing is exposed to the internet or your network.

**To stop CaseForge:** close the browser tab, then close the small black window (click its **✕**).

### The header: About and Help (any time)

Two buttons sit in the top-right of every screen:

- **About** — a short account of where CaseForge came from and how the numbers are computed, with a link to the full **Sizing methodology & sources** doc. It also shows the version you're running.
- **?** (Help and FAQ) — a quick-answer panel covering the questions reps ask most (which file types, which key, trying the demo, offline behavior, what to do when a file is skipped or a verdict is BLOCKED). It ends with the support email.

You can open either at any step without losing your place.

---

# Your saved cases (the home screen)

When CaseForge opens, you land on a **home screen** that lists every case you've generated before:

- **+ New business case** → start fresh at Step 1 (the walkthrough below).
- **A saved case** → click it to **Open**. CaseForge reopens it straight at **Refine (Step 6)** with the documents already loaded — no API key needed just to read them. To regenerate or add files you'll re-enter your key (it's never saved). A small **✕ / Delete** removes a case you no longer want.

Cases save themselves: the first time you generate, and again after every refine or after you add files. You don't click "save." Each save keeps the **previous versions too** — refining or regenerating never throws away what you had before.

> **Where they live:** saved cases are kept on *your* laptop, in a `CaseForge/archives` folder in your home directory, one `.zip` per case. **They contain the real customer files and the real-name documents**, so treat that folder like any other confidential customer material (it's never uploaded anywhere). To get rid of a case for good, delete it from the home screen.

---

# The wizard, step by step

The seven steps run down the left side. Move forward with **Next →** (it lights up once a step is ready) and back with **← Back**. You can also click any earlier step in the sidebar to revisit it.

## Step 1 · Setup
- Choose **Claude** or **OpenAI** (match the key you created).
- Paste your **API key**.
- Type the **Company name** (the customer, e.g. *Acme Mutual Insurance*).
- Leave **Token budget** at the default unless you want a tighter spending cap.
- *(Optional)* **Customer discount (%)** — if you're proposing a discount, enter it here. It comes off the **proposed Oracle solution** (Autonomous Database + migration + disaster recovery); the customer's *current* spend stays at list, so the savings and business case reflect your real offer. Leave it at **0** for list pricing. You can change it later in Refine.
- When both the key and company name are filled, the page shows **"Ready — click Next."** Click **Next →**.

## Step 2 · Drop files
- **Drag the customer's files** into the drop area (or click **Choose files**). Drop several at once.
- CaseForge reads them **right on your laptop** — nothing is sent anywhere yet. You'll see a count like *"3 file(s) · 7 evidence item(s) extracted"* and a list, each marked ✓ (read successfully) or ⚠ (couldn't read — skipped, that's fine). An "evidence item" is one useful piece of data CaseForge pulled out — a spreadsheet, a chunk of text, an email's fields, or an image lifted from inside a document.
- If a file couldn't be read, CaseForge classifies *why* (unsupported format, a malformed file, an extractor problem, or too large) and offers to send a short report so support can add or fix it — see [Reporting a problem](#reporting-a-problem). The good files still flow through.
- If it shows *0 evidence items*, none of your files could be read — try a different format (e.g. `.xlsx` instead of `.xls`, or paste details into a `.txt`/`.csv`).
- Click **Next →**.

## Step 3 · Anonymize — *the privacy step*

This is the heart of CaseForge: the AI only ever sees a coded version of the content, and the real names come back automatically in your final documents. When you have images, this step runs in **two parts** — scan the images, then anonymize everything.

**The detected-phrases list.** CaseForge scans the files **locally (no AI)** for sensitive things — company names, people, hosts/servers, and other terms — and lists each with a placeholder code (a "slug" like `CF_ORG_01`). Everything in this list will be hidden from the AI.
- A false alarm (not actually sensitive)? Click the **✕** to remove it.
- Something it missed? Type it in **"Add a phrase the detector missed…"**, choose a **type** (org, person, host, term) from the dropdown, and click **Add**.

**Part 1 — Scan images for hidden text (only when you dropped or extracted images).** If any of your evidence is an image — a dropped screenshot, or a chart pulled out of a document/email/PDF — an **Images** panel appears with a **"Scan N image(s) for hidden text"** button. Click it. CaseForge runs **OCR locally (no AI, fully offline)** on every image and folds any text it finds *into the list above* for your approval. Phrases that came from an image are badged **"from &lt;image&gt;"** so you can see where each one originated. This scan is **required before you can anonymize** — the **Anonymize** button stays disabled, with a hint pointing you to the images, until you've run it. (If an image can't be read, CaseForge tells you honestly and continues with the rest; that image is re-checked and flagged when you anonymize.)

**Part 2 — Anonymize & continue.** Click **Anonymize & continue →**. CaseForge:
- swaps the real text for the codes in every text item, and
- **blacks out** the matching text inside each image (reusing what the scan already read — no second scan), then re-encodes the picture.

It confirms *"… phrase(s) replaced — real text + matched image text will never reach the AI."*

**Review the redacted images.** Each image now shows as a preview with black boxes over the matched text and a note like *"✓ 2 region(s) blacked out"* (or *"no matching text found"*). Look at each one. A checkbox — **"send this image to the AI"** — lets you **drop any image** from the AI step if the redaction doesn't look right or you'd rather not send it at all. CaseForge **won't let you move past this step until you've reviewed the images**, so a picture with un-redacted text can't slip through.

When the list and the image previews look right, click **Next →**.

> The OCR/redaction is best-effort. If CaseForge isn't fully confident on an image, it stays usable but is flagged for you — which is exactly why every redacted preview is shown for your eyes before anything leaves the laptop.

## Step 4 · Confirm — *what we know, and what's missing*
CaseForge classifies the (anonymized) evidence and shows a **verdict**:
- **ENGINEERING-GRADE** — strong evidence; the sizing will be solid.
- **DIRECTIONAL ESTIMATE** — enough for a credible ballpark; a few details are assumed (estimated).
- **BLOCKED** — a must-have detail is missing; you'll need to supply it before continuing (it's listed for you).

Below the verdict is what it found for each required input, and — if anything's missing or assumed — a short list to confirm. For each, tick **"confirm a real measurement"** and type the real value if you have it (this improves accuracy); otherwise leave it and CaseForge uses a sensible estimate. Click **Confirm & continue →**, then **Next →**.

You can generate from a *Directional* estimate — the documents will say so clearly.

## Step 5 · Generate
- *(Optional, recommended)* Click **Research costs (web search)** to have the AI look up current market pricing for the comparison. It takes a minute and costs a few cents. Skip it to use built-in default estimates.
- Click **Generate deliverables →**. A **cost ticker** shows your spend as it works.
- **The important part:** all the *numbers* (sizing, savings, 5-year TCO) are computed by CaseForge itself — the AI only researches prices, reads charts, and writes the words. The AI never makes up a size or a cost. (In the next step you can still change the numbers by adjusting the discount or adding files — but it's always CaseForge's math doing the calculating, never the AI.) When it says the deliverables are generated, click **Next →**.

## Step 6 · Refine
- Preview the documents with the tabs:
  - **Business Case** — the executive/decision-maker summary.
  - **Sizing Brief** — the customer-facing sizing + proposal.
  - **Technical Review** — the internal technical deep-dive.
  - **Claims Checklist** — every claim with its evidence, for your talking points.
  Real names are shown here (restored on your laptop).
- Want different wording? Click a quick chip — **More concise**, **Executive tone**, **Emphasize DR resilience**, **Add risk framing** — or type your own request, then **Regenerate**.
- **Change the discount** here too: edit **Customer discount (%)** and click **Regenerate** to re-price the proposal.
- **What "Regenerate" does:** CaseForge re-runs its own sizing and cost math with the **current** pricing and your current discount, then the AI rewrites the wording around the fresh figures. So the numbers *can* change when you regenerate — for example after you change the discount, add files, or reopen an older case (which re-prices it at today's rates). As always, CaseForge computes every number; the AI only writes the words.
- **Add more files** to this case with **+ Add more files**: CaseForge keeps everything you have, takes you back to Drop files to add the new ones (only the *new* files get scanned and anonymized — the rest are already done), then regenerates with your latest request applied. Use this when the customer sends something after the fact.
- A note you type before clicking **+ Add more files** is carried along and applied when the case regenerates.
- Click **Next →** when you're happy.

> If you typed a real name (a person, company, or server) into the refine box that CaseForge hasn't seen before, it **stops and asks you to add it in Step 3 first** — so a real name can never slip to the AI through the refine box. Add it to the list (or reword), then regenerate.

## Step 7 · Export
- Download what you need: **each document on its own** (the filename carries the customer's name — e.g. `business-case-northwind.html`, `sizing-brief-northwind.html`, `technical-review-northwind.html`, `claims-checklist-northwind.html`), **All deliverables (one HTML)** (`caseforge-deliverables.html`) for a single shareable file, or the underlying **Data (JSON)** (`caseforge-docmodel.json`).
- The documents already contain the real names. You're done. 🎉

---

## Is this safe?

Yes — privacy is the whole point of the design.

- **Customer files stay on your laptop.** They're read inside your own browser; the files themselves are never uploaded.
- **Real names are scrambled before any AI call.** The detection in Step 3 runs locally (no AI). Only the *coded* version of the text is ever sent to Claude/OpenAI.
- **The AI sees codes, not identities.** It writes prose and looks up prices using stand-ins like `CF_ORG_01`; your final documents put the real names back automatically, on your laptop.
- **Images are handled too.** CaseForge OCRs every chart/screenshot **locally (offline, no AI)**, folds any text it finds into the same review list, and **blacks it out of the picture** before the image is sent to the AI's vision model. You review every redacted image, and can drop any one you don't want sent.
- **Zero-retention.** CaseForge uses the providers' no-training, no-retention settings.
- **Your API key never touches a disk.** It lives only in the browser for the current session.
- **Saved cases stay on your laptop.** When CaseForge saves a case so you can reopen it, it writes a file to a `CaseForge/archives` folder in your home directory. That file **does** contain the real customer material (the original files and the real-name documents) — it's how reopening works — but it's never uploaded anywhere. Only the *coded* version is ever sent to the AI, even when you regenerate or add files. Treat that folder like any confidential customer data, and delete cases you no longer need from the home screen.

*One honest caveat — images.* The image OCR/redaction is **best-effort**. Most baked-in text gets caught and blacked out, but unusual fonts, low-resolution charts, or rotated text can defeat OCR — that's why CaseForge shows you every redacted preview and lets you exclude an image from the AI step. If you spot a name, email, or server still visible in a preview, **untick "send this image to the AI"** for it (and, if the detail matters, type it into a `.txt`/`.csv` instead).

---

## What will it cost?

CaseForge itself is free; it uses **your** Claude/OpenAI account, so you pay the provider directly. A typical run is a small number of AI calls — usually a few cents to a couple of dollars, depending on the provider and how much you refine. The **cost ticker** in Step 5 shows the running total live, and the **Token budget** in Step 1 caps it. (Image scanning and redaction run on your laptop and cost nothing.)

---

## Reporting a problem

When a file can't be read, or CaseForge hits an unexpected error, a **"Send an error report"** dialog opens on its own. It lists what went wrong (each issue with a plain-language category), and you can expand **"Review the full report before sending"** to read the exact text first — nothing leaves your machine until you choose to send it. Your API key is scrubbed from the report.

- **Send report to Rick** opens a pre-filled email (to `rick.houlihan@oracle.com`) in Outlook on the web and **downloads the report as a file** — just **attach the downloaded file** to the email and send. (Browsers can't attach it for you.)
- **use my default mail app instead** does the same but via your computer's default mail program (a `mailto:` link), as a fallback.
- **Download report only** saves the file without opening any email.
- **Continue without reporting** dismisses it — the working files still flow through.

You can also reach support any time at `rick.houlihan@oracle.com`.

---

## Troubleshooting

**The browser didn't open.** Look at the small black window — it prints a line like `serving on http://127.0.0.1:8080`. Type that address (`127.0.0.1:8080`) into your browser's address bar. (To copy from the black window: select the text, right-click, Copy.)

**"Windows protected your PC" / Mac "unidentified developer."** Expected on first run — see [allow the app to run](#first-time-only-allow-the-app-to-run). You only do it once.

**Step 3 says "Launcher not reachable."** The small black window must stay open the whole time you use CaseForge. If you closed it, double-click the start file again.

**A message about the port being in use (`cannot bind 127.0.0.1:8080`).** CaseForge is probably already running in another window, or another app is using that address. Close the other window and start again.

**A file shows ⚠ in Step 2.** CaseForge couldn't read that one. It's skipped; the rest still work, and you'll be offered an error report so it can be fixed. Paste the key details into a `.txt` or `.csv` instead.

**The "Anonymize & continue" button is greyed out in Step 3.** If you have images, you must run **"Scan N image(s) for hidden text"** first — the button enables once the scan is done. (If you have no images and the button is still off, there's nothing to anonymize yet.)

**A few images couldn't be scanned.** CaseForge says so plainly and continues with the rest. Those images are re-checked and flagged when you anonymize; review their previews, and untick "send this image to the AI" for any whose text isn't fully blacked out.

**The verdict is BLOCKED (Step 4).** A required detail wasn't found. The screen lists exactly what to ask the customer for — add it there, or drop in a file that has it, then continue.

**An AI error, or "research failed."** Check your API key is correct and the account has credit. You can still **Generate** with default cost estimates if research fails.

---

## Frequently asked

**Do I need to install anything?** No — download, unzip, double-click the start file.

**Which key — Claude or OpenAI?** Either works. Use whichever account has credit.

**Which file formats can I drop in?** Spreadsheets (`.xlsx`), Word (`.docx`), PowerPoint (`.pptx`), PDFs (`.pdf`), email (`.msg`, `.eml`), web/markup (`.html`, `.xml`, `.rtf`), text data (`.csv`, `.tsv`, `.json`, `.txt`, `.md`), and chart images (`.png`, `.jpg`, `.gif`, `.webp`). Legacy `.xls`/`.doc` aren't read — re-save as `.xlsx`/`.docx` or export to PDF.

**What happens to images?** They're OCR'd on your laptop, any text is folded into the Step 3 review list, and matched text is blacked out before the image is sent to the AI. You review every redacted image and can exclude any one.

**Can I come back to a case later?** Yes. Every case you generate is saved automatically and appears on the **home screen** when you open CaseForge. Click it to reopen at Refine, where you can tweak wording, change the discount, or **add more files** the customer sent later — then regenerate. Saved cases live on your laptop (see [Is this safe?](#is-this-safe)).

**If I reopen an old case, are the prices current?** They show as last generated, but click **Regenerate** and CaseForge re-prices everything at today's rates (and your current discount). That's the safe habit for an older case.

**Can I give the customer a discount?** Yes — enter it in **Step 1 · Setup** (or adjust it in **Refine**). It applies to the proposed Oracle solution; the customer's current spend stays at list, so the savings shown are your real offer.

**Can I try it without a real customer?** Yes — your download includes a **`samples/northwind-demo`** folder of fictional artifacts. Drop those files into Step 2 to see the whole flow.

**Does it work offline?** The app — including file parsing, anonymization, and image scanning/redaction — runs offline. Only the AI steps (Step 4 classify, Step 5 research/generate) need internet to reach your provider.

**What databases does it support today?** Sizing **MongoDB → Oracle Autonomous Database**. (It can also analyze a MongoDB Atlas source profile — see `docs/ATLAS-SOURCE-PROFILE.md`.) More source databases are planned.

---

*Need help? Use the **?** Help button in the app, email `rick.houlihan@oracle.com`, or file an issue on the project's GitHub page.*
