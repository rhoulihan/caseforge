// Claims -> evidence checklist. Pure DocModel -> {filename, html}. Renders the deterministic
// buildChecklist() output grouped by section, with confidence badges + a sign-off summary.

import type { DocModel, RenderedDoc, ClaimSection } from './types';
import { page, buildHeader, buildFooter, escapeHtml, escapeProse, slug, table } from './shared';
import { buildChecklist } from './claims';

const SECTION_TITLES: Record<ClaimSection, string> = {
  A: 'Headline & stats',
  B: 'On-prem cost components',
  C: 'Sizing',
  D: 'Disaster recovery',
  E: 'Transition plan',
  F: 'Workload facts',
};

const badge = (c: string): string => `<span class="badge ${escapeHtml(c)}">${escapeHtml(c)}</span>`;

export function renderClaimsChecklist(m: DocModel): RenderedDoc {
  const cl = buildChecklist(m);
  const sections: ClaimSection[] = ['A', 'B', 'C', 'D', 'E', 'F'];

  const blocks = sections
    .map((sec) => {
      const rows = cl.rows.filter((r) => r.section === sec);
      if (rows.length === 0) return '';
      const trs = rows.map((r) => [
        escapeHtml(r.id),
        escapeHtml(r.claim),
        `${escapeHtml(r.value)} ${escapeHtml(r.unit)}`,
        escapeHtml(r.source),
        badge(r.confidence),
        escapeProse(r.derivation),
      ]);
      return `<h2>${sec}. ${escapeHtml(SECTION_TITLES[sec])}</h2>${table(['ID', 'Claim', 'Value', 'Source', 'Confidence', 'Derivation'], trs)}`;
    })
    .join('');

  const bc = cl.summary.byConfidence;
  const summary = `<p>${cl.summary.total} claims — <span class="badge high">${bc.high} high</span> <span class="badge medium">${bc.medium} medium</span> <span class="badge low">${bc.low} low</span>. Verdict tier: <strong>${escapeHtml(cl.verdictTier)}</strong>. Address the medium / low items before sign-off.</p>`;

  const body = `
${buildHeader({ companyName: m.companyName, preparedDate: m.preparedDate, documentStatus: m.documentStatus, title: `${m.companyName} — Claims &rarr; Evidence Checklist` })}
${summary}
${blocks}
${buildFooter('Every quantified claim mapped to its source and confidence.')}
`;
  return { filename: `claims-checklist-${slug(m.companyName)}.html`, html: page(`${m.companyName} — Claims Checklist`, body) };
}
