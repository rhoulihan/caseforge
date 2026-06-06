// Customer-facing business-case one-pager. Pure DocModel -> {filename, html}. All numbers are read
// verbatim from the DocModel (computed by the engine); the renderer performs no arithmetic.

import type { DocModel, RenderedDoc } from './types';
import { page, buildHeader, buildFooter, escapeProse, fmtUsd, fmtPct, slug } from './shared';
import { renderCostChart } from '../charts/costChart';
import { renderFiveYearChart } from '../charts/fiveYearChart';

export function renderBusinessCase(m: DocModel): RenderedDoc {
  const p = m.prose.businessCase;
  const t = m.tco;
  const warm = t.dr.find((d) => d.posture === 'warm')!;
  const cold = t.dr.find((d) => d.posture === 'cold')!;

  const body = `
${buildHeader({ companyName: m.companyName, preparedDate: m.preparedDate, documentStatus: m.documentStatus, title: `Halve ${m.companyName}'s Database TCO` })}
<p class="lead">${escapeProse(p.execSummary)}</p>
<div class="stats">
  <div class="stat"><div class="n">${fmtUsd(t.onprem.total.central)}</div><div class="l">On-prem MongoDB<br>fully-loaded / yr</div></div>
  <div class="stat g"><div class="n">${fmtUsd(t.adbWarmAnnual.central)}</div><div class="l">Oracle ADB + warm DR / yr</div></div>
  <div class="stat g"><div class="n">${fmtPct(t.savingWarm.pct)}</div><div class="l">Lower annual cost<br>(~${fmtUsd(t.savingWarm.amount)}/yr)</div></div>
  <div class="stat g"><div class="n">~Yr ${t.fiveYear.paybackYearWarm ?? '—'}</div><div class="l">Payback after<br>cutover</div></div>
</div>
<h2>The Fully-Loaded Comparison</h2>
<div class="fig">${renderCostChart(m.charts.cost)}<div class="cap">Fully-loaded annual cost — on-prem MongoDB vs Oracle ADB (warm / cold DR).</div></div>
<p>${escapeProse(p.fullyLoadedComparison)}</p>
<h2>A Low-Risk Path: Renew Once, Prove Out, Cut Over by Jan 2027</h2>
<p>${escapeProse(p.migrationPath)}</p>
<div class="fig">${renderFiveYearChart(m.charts.fiveYear)}<div class="cap">Cumulative cost over five years — the status-quo and migrate lines cross at payback.</div></div>
<h2>Disaster Recovery: Choose Your Recovery Posture</h2>
<p>${escapeProse(p.drContext)}</p>
<div class="two-col">
  <div class="card warm"><h3>Warm — Autonomous Data Guard (recommended)</h3>
    <div class="row"><span>Added / yr</span><span>+${fmtUsd(warm.addedAnnual.central)} → ${fmtUsd(warm.totalAnnual.central)}</span></div>
    <div class="row"><span>RTO</span><span>${escapeProse(warm.rtoText)}</span></div>
    <div class="row"><span>RPO</span><span>${escapeProse(warm.rpoText)}</span></div>
    <div class="row"><span>Failover</span><span>${escapeProse(warm.failover)}</span></div>
  </div>
  <div class="card cold"><h3>Cold — Backup-Based DR (lowest cost)</h3>
    <div class="row"><span>Added / yr</span><span>+${fmtUsd(cold.addedAnnual.central)} → ${fmtUsd(cold.totalAnnual.central)}</span></div>
    <div class="row"><span>RTO</span><span>${escapeProse(cold.rtoText)}</span></div>
    <div class="row"><span>RPO</span><span>${escapeProse(cold.rpoText)}</span></div>
    <div class="row"><span>Failover</span><span>${escapeProse(cold.failover)}</span></div>
  </div>
</div>
<h2>Key Assumptions</h2>
<p>${escapeProse(p.keyAssumptions)}</p>
<div class="pull">${escapeProse(p.pullQuote)}</div>
<h2>Recommendation &amp; Next Steps</h2>
<p>${escapeProse(p.nextSteps)}</p>
${buildFooter('Preliminary for discussion. Figures USD list / pre-discount, sourced from verified multi-source research and prior ADB sizing.')}
`;
  return { filename: `business-case-${slug(m.companyName)}.html`, html: page(`${m.companyName} — Business Case`, body) };
}
