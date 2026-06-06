// Help / FAQ modal — opened from the header "?" icon. Content mirrors docs/USER-GUIDE.md so the
// in-app help and the shipped guide stay consistent. Always ends with the support contact.

import { useErrors } from '../ErrorContext';
import { Modal } from './Modal';
import { SUPPORT_EMAIL } from '../../errors/email';

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Which file formats can I drop in?',
    a: 'Spreadsheets (.xlsx), Word (.docx), PowerPoint (.pptx), PDFs (.pdf), email (.msg, .eml), web/markup (.html, .xml, .rtf), and text data (.csv, .tsv, .json, .txt, .md), plus chart images (.png, .jpg, .gif, .webp). Legacy .xls and .doc aren’t read — please re-save them as .xlsx / .docx, or export to PDF.',
  },
  { q: 'Which API key — Claude or OpenAI?', a: 'Either works. Use whichever account has credit. The key is held in this browser session only and is never written to disk.' },
  { q: 'Can I try it without a real customer?', a: 'Yes — your download includes a samples/northwind-demo folder of fictional artifacts. Drop those files into Step 2 to see the whole flow.' },
  { q: 'Does it work offline?', a: 'The app itself runs offline, but the AI steps (Step 4 classify, Step 5 research/generate) need internet to reach your provider.' },
  { q: 'A file shows ⚠ in Step 2.', a: "CaseForge couldn't read that one; it's skipped and the rest still work. You'll be offered to send an error report so we can add support or fix it." },
  { q: 'The verdict is BLOCKED (Step 4).', a: 'A required detail wasn’t found. The screen lists exactly what to ask the customer for — add it there, or drop in a file that has it, then continue.' },
  { q: 'An AI error, or “research failed.”', a: 'Check your API key is correct and the account has credit. You can still Generate with default cost estimates if research fails.' },
  { q: 'What databases does it support today?', a: 'Sizing MongoDB → Oracle Autonomous Database. More source databases are planned.' },
];

export function HelpModal() {
  const { helpOpen, closeHelp } = useErrors();
  if (!helpOpen) return null;
  return (
    <Modal title="Help & FAQ" onClose={closeHelp}>
      <dl class="cf-faq">
        {FAQ.map((f) => (
          <div key={f.q} class="cf-faq-item">
            <dt>{f.q}</dt>
            <dd>{f.a}</dd>
          </div>
        ))}
      </dl>
      <p class="cf-hint" style="margin-top:8px">
        For additional assistance, email{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </Modal>
  );
}
