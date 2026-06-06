// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorProvider, useErrors } from '../ErrorContext';
import { ErrorReportDialog } from './ErrorReportDialog';

function Trigger() {
  const { capture } = useErrors();
  return (
    <button type="button" onClick={() => capture(new Error('boom sk-ant-LEAKLEAK'), { category: 'unexpected', title: 'Boom' })}>
      go
    </button>
  );
}

function setup() {
  return render(
    <ErrorProvider>
      <Trigger />
      <ErrorReportDialog />
    </ErrorProvider>,
  );
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('ErrorReportDialog', () => {
  it('opens on capture, lists the issue, and downloads + opens Outlook web compose on Send', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    setup();
    fireEvent.click(screen.getByText('go'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.body.textContent).toContain('Boom'); // the captured event title is shown

    fireEvent.click(screen.getByText('Send report to Rick'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1); // the report file was downloaded for the rep to attach
    expect(open).toHaveBeenCalledTimes(1);
    const url = open.mock.calls[0]![0] as string;
    expect(url).toContain('outlook.office.com/mail/deeplink/compose');
    expect(url).toContain('rick.houlihan%40oracle.com');
    open.mockRestore();
  });

  it('never shows a leaked API key in the report preview', () => {
    setup();
    fireEvent.click(screen.getByText('go'));
    expect(document.body.textContent).not.toContain('sk-ant-LEAKLEAK');
  });

  it('offers a mailto: fallback to the default mail app', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    setup();
    fireEvent.click(screen.getByText('go'));
    fireEvent.click(screen.getByText(/use my default mail app/i));
    expect((open.mock.calls[0]![0] as string).startsWith('mailto:rick.houlihan@oracle.com')).toBe(true);
    open.mockRestore();
  });

  it('closes on "Continue without reporting"', () => {
    setup();
    fireEvent.click(screen.getByText('go'));
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('Continue without reporting'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
