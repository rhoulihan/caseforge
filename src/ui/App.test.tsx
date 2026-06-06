// @vitest-environment jsdom
import { render, screen } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders the CaseForge header, the wizard (Step 1), and the footer', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('CaseForge');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('1 · Setup'); // wizard mounted on step 1
    expect(screen.getByText(/BYO API key/i)).toBeTruthy(); // footer (unique)
  });
});
