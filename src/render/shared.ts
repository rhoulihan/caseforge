// Pure HTML building blocks shared by the four renderers. Note: table()/row() cell content is
// inserted as raw HTML (so callers can embed badges) — callers MUST escapeProse() any prose cell.

import { LAYOUT_CSS } from './layout.css';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape an optional prose field — the single chokepoint for LLM/user text in the HTML. */
export function escapeProse(s: string | undefined): string {
  return escapeHtml(s ?? '');
}

/** "$450K" / "$1.14M" — whole thousands below 1M, two-decimal millions at/above 1M. */
export function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(n / 1000)}K`;
}

export function fmtPct(n: number): string {
  return `${n}%`;
}

/** Filename-safe slug. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Wrap body HTML into a self-contained document with the embedded stylesheet. */
export function page(title: string, body: string): string {
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><style>${LAYOUT_CSS}</style></head><body>\n${body}\n</body></html>\n`;
}

export interface HeaderInfo {
  companyName: string;
  preparedDate: string;
  documentStatus: string;
  title: string;
}
export function buildHeader(h: HeaderInfo): string {
  return `<div class="hdr"><h1>${escapeHtml(h.title)}</h1><div class="meta">${escapeHtml(
    h.companyName,
  )} &middot; ${escapeHtml(h.preparedDate)} &middot; <span class="status">${escapeHtml(h.documentStatus)}</span></div></div>`;
}

export function buildFooter(note: string): string {
  return `<div class="ftr">${escapeProse(note)}</div>`;
}

/** Bullet list of prose items (each escaped). */
export function ul(items: string[]): string {
  return `<ul>${items.map((i) => `<li>${escapeProse(i)}</li>`).join('')}</ul>`;
}

/** Table from a header row + rows of pre-built (already-escaped where needed) cell HTML. */
export function table(headers: string[], rows: string[][]): string {
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table>${head}${body}</table>`;
}
