// The doc renderer public API: the three deliverables + the claims->evidence checklist, each a
// pure DocModel -> {filename, html}.

export type * from './types';
export { renderBusinessCase } from './businessCase';
export { renderSizingBrief } from './sizingBrief';
export { renderTechnicalReview } from './technicalReview';
export { renderClaimsChecklist } from './claimsChecklist';
export { buildChecklist } from './claims';
export type { ClaimRow, ClaimsChecklist } from './claims';
