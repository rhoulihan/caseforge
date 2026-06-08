# CaseForge — Sales Rep Guide

**Turn a folder of whatever the customer sent you into a sizing, a customer proposal, and a TCO business case — in a few minutes, on your own laptop.**

You don't need to be technical to use CaseForge. This guide walks you through it start to finish. If you can drag files into a window and click "Next," you can do this.

> *Updated 2026-06-07 — reflects the current design through v0.4.0: the home screen of saved cases, the broadened set of file types, a customer discount, regenerating with up-to-date numbers, adding files to a saved case, the in-app Help/About/error-report dialog, and the image policy — images are sent to the AI as-is and you review each one (CaseForge does not scrub images).*

---

## In one minute

1. Get an API key from **Claude** or **OpenAI** (one-time — see [Get an API key](#1-get-an-api-key-one-time)).
2. Download CaseForge for your computer, unzip it, and **double-click the start file**. Your browser opens.
3. Walk the in-app wizard: **Setup → Drop files → Anonymize → Confirm → Generate → Refine → Export.**
4. Download three polished documents to share.

**Your customer's files never leave your laptop, and real names in text are scrambled before anything is sent to the AI.** Images are different — they're sent to the AI's vision model as-is, so you review and approve each one (or exclude it). More on that in [Is this safe?](#is-this-safe).

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

CaseForge also pulls images *out of* your documents — charts pasted into a `.docx`/`.pptx`/`.xlsx`, image attachments on a `.msg` email, and pictures embedded in a PDF — so the AI can read the data in them. You review every image before it's sent (see Step 3).

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

This is the heart of CaseForge: for **text**, the AI only ever sees a coded version, and the real names come back automatically in your final documents.

**The detected-phrases list.** CaseForge scans the files **locally (no AI)** for sensitive things — company names, people, hosts/servers, and other terms — and lists each with a placeholder code (a "slug" like `CF_ORG_01`). Everything in this list will be hidden from the AI.
- A false alarm (not actually sensitive)? Click the **✕** to remove it.
- Something it missed? Type it in **"Add a phrase the detector missed…"**, choose a **type** (org, person, host, term) from the dropdown, and click **Add**.

**Anonymize & continue.** Click **Anonymize & continue →**. CaseForge swaps the real text for the codes in every text item and confirms *"… phrase(s) replaced — real text will never reach the AI."*

**Images are sent to the AI as-is — you're responsible for them.** Unlike text, **CaseForge does not scrub or black out anything inside an image.** The AI's vision model needs to *read* your charts, dashboards, and screenshots to size the workload, so each image is sent **exactly as it appears**. After you anonymize, an **Images** panel shows a preview of every image that will be sent. For each one:
- Look at the preview. If it contains a name, email, hostname, or anything else you don't want shared, **untick "send this image to the AI"** to exclude it (and, if a number on it matters, type that number into a `.txt`/`.csv` instead).
- For each image you *are* sending, tick **"I have reviewed this image — it's safe to send."**

CaseForge **won't let you move past this step until every image you're sending has been reviewed**, so an image can't slip through unseen. (Any name the AI happens to *read out of* an image still gets coded in the final documents — but the picture itself goes as-is, which is why you review it.)

When the list and the images look right, click **Next →**.

> Tip: the cleanest way to share an image safely is to crop or black it out yourself before you drop it in — or just exclude it and type the key numbers into a `.txt`.

## Step 4 · Confirm — *what we know, and what's missing*
CaseForge classifies the (anonymized) evidence and shows a **verdict**:
- **ENGINEERING-GRADE** — strong evidence; the sizing will be solid.
- **DIRECTIONAL ESTIMATE** — enough for a credible ballpark; a few details are assumed (estimated).
- **BLOCKED** — a must-have detail is missing; you'll need to supply it before continuing (it's listed for you).

Below the verdict is what it found for each required input, and — if anything's missing or low-confidence — a short list to confirm. **Just type the real value** where you have it — entering a number *is* the confirmation (no extra checkbox), and it's treated as a measured value. Anything CaseForge already read (e.g. from a chart) is kept if you leave it blank; a *missing* required value must be supplied to continue. Click **Confirm & continue →**, then **Next →**.

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
- **Images are different — you're in control.** CaseForge does **not** scrub text inside images; the AI's vision model needs to read your charts/screenshots to size the workload, so each image is sent **as-is**. You review a preview of every image before it's sent, acknowledge each one, and can exclude any image you don't want shared. (Any name the AI reads *out of* an image is still coded in the final documents — only the picture itself is unmodified.)
- **Zero-retention.** CaseForge uses the providers' no-training, no-retention settings.
- **Your API key never touches a disk.** It lives only in the browser for the current session.
- **Saved cases stay on your laptop.** When CaseForge saves a case so you can reopen it, it writes a file to a `CaseForge/archives` folder in your home directory. That file **does** contain the real customer material (the original files and the real-name documents) — it's how reopening works — but it's never uploaded anywhere. Only the *coded* version is ever sent to the AI, even when you regenerate or add files. Treat that folder like any confidential customer data, and delete cases you no longer need from the home screen.

*One honest caveat — images.* CaseForge sends images **exactly as they are** — it does not black anything out. Whatever is visible in an image (names, emails, servers) goes to the AI. That's why Step 3 shows you a preview of every image and makes you acknowledge each one: if you spot something sensitive, **untick "send this image to the AI"** to exclude it (and, if a detail on it matters, type that into a `.txt`/`.csv` instead). The safest habit is to crop or redact an image yourself before adding it.

---

## What will it cost?

CaseForge itself is free; it uses **your** Claude/OpenAI account, so you pay the provider directly. A typical run is a small number of AI calls — usually a few cents to a couple of dollars, depending on the provider and how much you refine. The **cost ticker** in Step 5 shows the running total live, and the **Token budget** in Step 1 caps it.

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

**The "Anonymize & continue" button is greyed out in Step 3.** There's nothing to anonymize yet — the detected-phrases list is empty. Add at least the company name (or any phrase) and it enables.

**Next is greyed out in Step 3 even though I anonymized.** If you dropped images, you must review each one you're sending: tick **"I have reviewed this image — it's safe to send"** on every image (or untick **"send this image to the AI"** to exclude it). The "N of M acknowledged" line tells you how many are left.

**The verdict is BLOCKED (Step 4).** A required detail wasn't found. The screen lists exactly what to ask the customer for — add it there, or drop in a file that has it, then continue.

**An AI error, or "research failed."** Check your API key is correct and the account has credit. You can still **Generate** with default cost estimates if research fails.

---

## Frequently asked

**Do I need to install anything?** No — download, unzip, double-click the start file.

**Which key — Claude or OpenAI?** Either works. Use whichever account has credit.

**Which file formats can I drop in?** Spreadsheets (`.xlsx`), Word (`.docx`), PowerPoint (`.pptx`), PDFs (`.pdf`), email (`.msg`, `.eml`), web/markup (`.html`, `.xml`, `.rtf`), text data (`.csv`, `.tsv`, `.json`, `.txt`, `.md`), and chart images (`.png`, `.jpg`, `.gif`, `.webp`). Legacy `.xls`/`.doc` aren't read — re-save as `.xlsx`/`.docx` or export to PDF.

**What happens to images?** They're sent to the AI's vision model **as-is** so it can read the data in them — CaseForge does not scrub or black out anything inside an image. In Step 3 you review a preview of every image, acknowledge each one you're sending, and can exclude any image you don't want shared. You're responsible for making sure an image is safe to send (crop/redact it yourself, or exclude it and type the key numbers into a `.txt`).

**Can I come back to a case later?** Yes. Every case you generate is saved automatically and appears on the **home screen** when you open CaseForge. Click it to reopen at Refine, where you can tweak wording, change the discount, or **add more files** the customer sent later — then regenerate. Saved cases live on your laptop (see [Is this safe?](#is-this-safe)).

**If I reopen an old case, are the prices current?** They show as last generated, but click **Regenerate** and CaseForge re-prices everything at today's rates (and your current discount). That's the safe habit for an older case.

**Can I give the customer a discount?** Yes — enter it in **Step 1 · Setup** (or adjust it in **Refine**). It applies to the proposed Oracle solution; the customer's current spend stays at list, so the savings shown are your real offer.

**Can I try it without a real customer?** Yes — your download includes a **`samples/northwind-demo`** folder of fictional artifacts. Drop those files into Step 2 to see the whole flow.

**Does it work offline?** The app — including file parsing and text anonymization — runs offline. Only the AI steps (Step 4 classify, Step 5 research/generate), which include reading any images you send, need internet to reach your provider.

**What databases does it support today?** Sizing **MongoDB → Oracle Autonomous Database**. (It can also analyze a MongoDB Atlas source profile — see `docs/ATLAS-SOURCE-PROFILE.md`.) More source databases are planned.

---

*Need help? Use the **?** Help button in the app, email `rick.houlihan@oracle.com`, or file an issue on the project's GitHub page.*
