// Internal/customer sizing brief. Pure DocModel -> {filename, html}. Tables read the engine-computed
// scenario numbers verbatim.

import type { DocModel, RenderedDoc } from './types';
import { page, buildHeader, buildFooter, escapeProse, fmtUsd, slug, table, ul } from './shared';

const pct = (f: number): string => `${Math.round(f * 100)}%`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function renderSizingBrief(m: DocModel): RenderedDoc {
  const p = m.prose.sizingBrief;
  const b = m.sizing.basis;
  const c = m.sizing.consumed;

  const envRows = [
    ['Shards (data-bearing replica sets)', String(b.shards)],
    ['vCPU per home-region node', String(b.hoVcpu)],
    ['vCPU per DR-region node', String(b.drVcpu)],
    ['On-disk (compressed) data', `${(m.sizing.dataCompressedGb / 1000).toFixed(1)} TB`],
  ];
  const workloadRows = [
    ['Primary', pct(b.util.primary.avgPct), pct(b.util.primary.peakPct)],
    ['HA secondary', pct(b.util.hoSec.avgPct), pct(b.util.hoSec.peakPct)],
    ['DR', pct(b.util.dr.avgPct), pct(b.util.dr.peakPct)],
  ];
  const scenRows = m.sizing.scenarios.map((s) => [
    cap(s.posture),
    String(s.base),
    `${s.ceiling2x} / ${s.ceiling3x}`,
    fmtUsd(s.annualEcpuCost),
    fmtUsd(s.annualStorageCost),
    fmtUsd(s.totalAnnual),
  ]);
  const followUps = m.sufficiency.whatToCollect.map((w) => w.request);

  const body = `
${buildHeader({ companyName: m.companyName, preparedDate: m.preparedDate, documentStatus: m.documentStatus, title: `${m.companyName} — Oracle ADB Sizing Brief` })}
<p>${escapeProse(p.workloadContext)}</p>
<h2>Environment we sized</h2>
${table(['Attribute', 'Value'], envRows)}
<h2>What the telemetry indicates</h2>
${table(['Role', 'Avg System-CPU', 'Peak System-CPU'], workloadRows)}
<p>Average-to-peak ratio: <strong>${c.ratio}&times;</strong> (avg ${c.avg.toFixed(1)} ECPU, peak ${c.peak.toFixed(1)} ECPU).</p>
<h2>Sizing approach</h2>
<p>${escapeProse(p.provisioningApproach)}</p>
<h2>Indicative sizing &amp; cost</h2>
${table(['Scenario', 'Base ECPU', 'Autoscale 2&times;/3&times;', 'ECPU / yr', 'Storage / yr', 'Total / yr'], scenRows)}
<h2>Sufficiency</h2>
<p>${escapeProse(p.sufficiencyStatement)}</p>
<h2>Follow-up questions</h2>
${followUps.length ? ul(followUps) : `<p>${escapeProse(p.followUps)}</p>`}
${buildFooter('Internal sizing memo — Phase-1 notional.')}
`;
  return { filename: `sizing-brief-${slug(m.companyName)}.html`, html: page(`${m.companyName} — Sizing Brief`, body) };
}
