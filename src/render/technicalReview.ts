// Internal technical review. Pure DocModel -> {filename, html}. Embeds the SufficiencyReport
// (inventory + coverage + verdict + what-to-collect) verbatim.

import type { DocModel, RenderedDoc } from './types';
import { page, buildHeader, buildFooter, escapeProse, escapeHtml, slug, table } from './shared';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function renderTechnicalReview(m: DocModel): RenderedDoc {
  const p = m.prose.technicalReview;
  const s = m.sufficiency;
  const v = s.verdict;

  const invRows = s.inventory.map((i) => [escapeHtml(i.name), escapeHtml(i.role), escapeHtml(i.boundSignals.join(', ') || '—')]);
  const covRows = s.coverage.map((c) => [
    escapeHtml(c.signalId),
    escapeHtml(c.criticality),
    escapeHtml(c.status),
    c.effectiveConfidence.toFixed(2),
    escapeHtml(c.method ?? '—'),
  ]);
  const wtcRows = s.whatToCollect.map((w) => [escapeHtml(w.signalId), escapeHtml(w.severity), escapeProse(w.request)]);
  const sensRows = m.sizing.scenarios.map((sc) => [cap(sc.posture), String(sc.base), `${sc.ceiling2x} / ${sc.ceiling3x}`]);

  const body = `
${buildHeader({ companyName: m.companyName, preparedDate: m.preparedDate, documentStatus: m.documentStatus, title: `${m.companyName} — Internal Technical Review` })}
<h2>Sizing rationale</h2>
<p>${escapeProse(p.technicalNotes)}</p>
<h2>Data Intake &amp; Sufficiency</h2>
<p><strong>Verdict:</strong> ${escapeHtml(v.tier)} — ${escapeProse(v.headline)} (${v.requiredSatisfied}/${v.requiredTotal} required satisfied, mean confidence ${v.meanRequiredConfidence.toFixed(2)}).</p>
<h3>Inventory</h3>
${table(['File', 'Role', 'Bound signals'], invRows)}
<h3>Signal coverage</h3>
${table(['Signal', 'Criticality', 'Status', 'Eff. confidence', 'Method'], covRows)}
${s.whatToCollect.length ? `<h3>What to collect</h3>${table(['Signal', 'Severity', 'Request'], wtcRows)}` : ''}
<h2>Sizing sensitivity</h2>
${table(['Posture', 'Base ECPU', 'Autoscale 2&times;/3&times;'], sensRows)}
<h2>Risk &amp; mitigation</h2>
<p>${escapeProse(p.riskAndMitigation)}</p>
<h2>Data model</h2>
<p>${escapeProse(p.dataModelDecision)}</p>
<h2>Performance validation</h2>
<p>${escapeProse(p.performanceValidation)}</p>
${buildFooter('Internal technical review — confidential.')}
`;
  return { filename: `technical-review-${slug(m.companyName)}.html`, html: page(`${m.companyName} — Technical Review`, body) };
}
