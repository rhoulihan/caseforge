import type { ErrorCategory } from './types';

/** Rep-facing labels for each error category (used in the dialog, the report, and the email). */
export const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  unsupported_format: 'unsupported file format',
  malformed_file: 'unreadable or corrupt file',
  file_too_large: 'file too large to parse',
  extractor_error: 'file parsing error',
  provider_error: 'AI provider error',
  launcher_error: 'local launcher error',
  validation_error: 'validation error',
  unexpected: 'unexpected error',
};
