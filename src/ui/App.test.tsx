// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('opens on the home screen and mounts the wizard at Step 1 when starting a new case', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('CaseForge');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Business cases'); // home screen first
    expect(screen.getByText(/BYO API key/i)).toBeTruthy(); // footer (unique)
    fireEvent.click(screen.getByRole('button', { name: /New business case/i }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('1 · Setup'); // wizard mounted on step 1
  });

  it('opens the Help & FAQ modal from the header', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getByRole('heading', { name: /Help & FAQ/i })).toBeTruthy();
    expect(screen.getByText(/which file formats/i)).toBeTruthy();
    expect(screen.getAllByText(/rick\.houlihan@oracle\.com/i).length).toBeGreaterThan(0);
  });

  it('opens the About modal with the sizing-methodology link', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'About' }));
    expect(screen.getByRole('heading', { name: /About CaseForge/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Sizing methodology/i })).toBeTruthy();
  });
});
