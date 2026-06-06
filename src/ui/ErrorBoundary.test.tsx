// @vitest-environment jsdom
import { render, screen } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { ErrorProvider } from './ErrorContext';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorReportDialog } from './modals/ErrorReportDialog';

function Boom(): never {
  throw new Error('render crash');
}

describe('ErrorBoundary', () => {
  it('catches a render crash, shows the fallback, and auto-opens the report dialog', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); // expected: Preact logs the caught error
    render(
      <ErrorProvider>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
        <ErrorReportDialog />
      </ErrorProvider>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();
    await screen.findByRole('dialog'); // the report dialog opened from componentDidCatch → capture
    expect(screen.getByText(/Send an error report/i)).toBeTruthy();
    spy.mockRestore();
  });
});
