// @vitest-environment jsdom
import { render } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Spinner } from './Spinner';

describe('Spinner', () => {
  it('renders a decorative cf-spinner span (aria-hidden)', () => {
    const { container } = render(<Spinner />);
    const el = container.querySelector('.cf-spinner');
    expect(el).toBeTruthy();
    expect(el!.getAttribute('aria-hidden')).toBe('true');
  });
});
