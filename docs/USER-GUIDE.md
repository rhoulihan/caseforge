# CaseForge — Sales Rep Guide

**Turn a folder of whatever the customer sent you into a sizing, a customer proposal, and a TCO business case — in a few minutes, on your own laptop.**

You don't need to be technical to use CaseForge. This guide walks you through it start to finish. If you can drag files into a window and click "Next," you can do this.

---

## In one minute

1. Get an API key from **Claude** or **OpenAI** (one-time — see [Get an API key](#1-get-an-api-key-one-time)).
2. Download CaseForge for your computer, unzip it, and **double-click the start file**. Your browser opens.
3. Walk the in-app wizard: **Setup → Drop files → Anonymize → Confirm → Generate → Refine → Export.**
4. Download three polished documents to share.

**Your customer's files never leave your laptop, and real names are scrambled before anything is sent to the AI.** More on that in [Is this safe?](#is-this-safe).

---

## What you need

- **A Windows, Mac, or Linux laptop.** Nothing to install — CaseForge is a single download.
- **An API key** from Claude (Anthropic) or OpenAI. This is how CaseForge uses the AI, billed to *your* account. Getting one takes a few minutes the first time.
- **The customer's files** — whatever they sent: spreadsheets (`.xlsx`), Word (`.docx`), PowerPoint (`.pptx`), PDFs, emails (`.msg`/`.eml`), web/markup (`.html`/`.xml`/`.rtf`), CSVs, and screenshots (`.png`/`.jpg`/`.webp`). CaseForge figures out what's useful and ignores the rest. (Legacy `.xls`/`.doc` aren't read — re-save as `.xlsx`/`.docx` or PDF.)

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

---

# The wizard, step by step

The seven steps run down the left side. Move forward with **Next →** (it lights up once a step is ready) and back with **← Back**. You can also click any earlier step in the sidebar to revisit it.

## Step 1 · Setup
- Choose **Claude** or **OpenAI** (match the key you created).
- Paste your **API key**.
- Type the **Company name** (the customer, e.g. *Acme Mutual Insurance*).
- Leave **Token budget** at the default unless you want a tighter spending cap.
- When both the key and company name are filled, the page shows **"Ready — click Next."** Click **Next →**.

## Step 2 · Drop files
- **Drag the customer's files** into the drop area (or click **Choose files**). Drop several at once.
- CaseForge reads them **right on your laptop** — nothing is sent anywhere yet. You'll see a count like *"3 files · 7 evidence items extracted"* and a list, each marked ✓ (read successfully) or ⚠ (couldn't read — skipped, that's fine). An "evidence item" is one useful piece of data CaseForge pulled out.
- If it shows *0 evidence items*, your files couldn't be read — try a different format (e.g. `.xlsx` instead of `.xls`, or paste details into a `.txt`/`.csv`).
- Click **Next →**.

## Step 3 · Anonymize — *the privacy step*
- CaseForge scans the files **locally (no AI)** for sensitive things — company names, people, emails, server names, IP addresses — and lists each with a placeholder code (a "slug" like `CF_ORG_01`).
- **Everything in this list will be hidden from the AI.** Review it:
  - A false alarm (not actually sensitive)? Click the **✕** to remove it.
  - Something it missed? Type it in **"Add a phrase the detector missed…"**, choose a **type** (person, company, host…) from the dropdown, and click **Add**.
- Click **Anonymize & continue →**. CaseForge swaps the real text for the codes and confirms *"… phrase(s) replaced — real text will never reach the AI."* Click **Next →**.

> This is the heart of CaseForge: the AI only ever sees the coded version. Real names come back automatically in your final documents.

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
- **The important part:** all the *numbers* (sizing, savings, 5-year TCO) are computed by CaseForge itself — the AI only researches prices, reads charts, and writes the words. The numbers are final and locked; only wording can change next. When it says the deliverables are generated, click **Next →**.

## Step 6 · Refine
- Preview the documents with the tabs:
  - **Business Case** — the executive/decision-maker summary.
  - **Sizing Brief** — the customer-facing sizing + proposal.
  - **Technical Review** — the internal technical deep-dive.
  - **Claims Checklist** — every claim with its evidence, for your talking points.
  Real names are shown here (restored on your laptop).
- Want different wording? Click a quick chip — **More concise**, **Executive tone**, **Emphasize DR resilience**, **Add risk framing** — or type your own request, then **Regenerate prose**. **The numbers never change** — only the wording.
- Click **Next →** when you're happy.

## Step 7 · Export
- Download what you need: **each document on its own** (e.g. `business-case.html`, `sizing-brief.html`, `technical-review.html`, `claims-checklist.html`), **All deliverables (one HTML)** for a single shareable file, or the underlying **Data (JSON)**.
- The documents already contain the real names. You're done. 🎉

---

## Is this safe?

Yes — privacy is the whole point of the design.

- **Customer files stay on your laptop.** They're read inside your own browser; the files themselves are never uploaded.
- **Real names are scrambled before any AI call.** The detection in Step 3 runs locally (no AI). Only the *coded* version of the text is ever sent to Claude/OpenAI.
- **The AI sees codes, not identities.** It writes prose and looks up prices using stand-ins like `CF_ORG_01`; your final documents put the real names back automatically, on your laptop.
- **Zero-retention.** CaseForge uses the providers' no-training, no-retention settings.
- **Your API key never touches a disk.** It lives only in the browser for the current session.

*One honest caveat — images.* If a **screenshot or chart** has a visible name in it (e.g. in a title), the AI's vision can read it — pictures can't be auto-scrambled the way text is. If an image contains a customer name/email/server, either blur it out first, or type those details into a `.txt`/`.csv` instead of dropping the picture in.

---

## What will it cost?

CaseForge itself is free; it uses **your** Claude/OpenAI account, so you pay the provider directly. A typical run is a small number of AI calls — usually a few cents to a couple of dollars, depending on the provider and how much you refine. The **cost ticker** in Step 5 shows the running total live, and the **Token budget** in Step 1 caps it.

---

## Troubleshooting

**The browser didn't open.** Look at the small black window — it prints a line like `serving on http://127.0.0.1:8080`. Type that address (`127.0.0.1:8080`) into your browser's address bar. (To copy from the black window: select the text, right-click, Copy.)

**"Windows protected your PC" / Mac "unidentified developer."** Expected on first run — see [allow the app to run](#first-time-only-allow-the-app-to-run). You only do it once.

**Step 3 says "Launcher not reachable."** The small black window must stay open the whole time you use CaseForge. If you closed it, double-click the start file again.

**A message about the port being in use (`cannot bind 127.0.0.1:8080`).** CaseForge is probably already running in another window, or another app is using that address. Close the other window and start again.

**A file shows ⚠ in Step 2.** CaseForge couldn't read that one. It's skipped; the rest still work. Paste the key details into a `.txt` or `.csv` instead.

**The verdict is BLOCKED (Step 4).** A required detail wasn't found. The screen lists exactly what to ask the customer for — add it there, or drop in a file that has it, then continue.

**An AI error, or "research failed."** Check your API key is correct and the account has credit. You can still **Generate** with default cost estimates if research fails.

---

## Frequently asked

**Do I need to install anything?** No — download, unzip, double-click the start file.

**Which key — Claude or OpenAI?** Either works. Use whichever account has credit.

**Can I try it without a real customer?** Yes — your download includes a **`samples/northwind-demo`** folder of fictional artifacts. Drop those three files into Step 2 to see the whole flow.

**Does it work offline?** The app runs offline, but the AI steps (Step 4 classify, Step 5 research/generate) need internet to reach your provider.

**What databases does it support today?** Sizing **MongoDB → Oracle Autonomous Database**. More source databases are planned.

---

*Need help? Contact your CaseForge champion, or file an issue on the project's GitHub page.*
