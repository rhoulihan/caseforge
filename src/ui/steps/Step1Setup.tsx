// Step 1 · Setup — provider + BYO API key + company name + token budget. The key goes to session
// memory only (setApiKey), never into the serialized WizardState. Advance-validity (config + key +
// company) is enforced by stepValidity; this component just collects the fields.

import { useWizard } from '../WizardContext';
import type { Provider } from '../state';

export function Step1Setup() {
  const { state, patch, setApiKey, getApiKey } = useWizard();
  const cfg = state.config ?? { provider: 'claude' as Provider, companyName: '', tokenBudget: 100_000, discountPct: 0 };
  const update = (p: Partial<typeof cfg>): void => patch({ config: { ...cfg, ...p } });
  const incomplete = !state.hasApiKey || cfg.companyName.trim().length === 0;

  return (
    <section class="cf-card">
      <h2>1 · Setup</h2>
      <p class="cf-sub">Bring your own API key — it stays in this browser session and is never written to disk.</p>

      <div class="cf-field">
        <span class="cf-label">Provider</span>
        <div class="cf-radios">
          <label>
            <input type="radio" name="provider" checked={cfg.provider === 'claude'} onChange={() => update({ provider: 'claude' })} /> Claude
          </label>
          <label>
            <input type="radio" name="provider" checked={cfg.provider === 'openai'} onChange={() => update({ provider: 'openai' })} /> OpenAI
          </label>
        </div>
      </div>

      <label class="cf-field">
        <span class="cf-label">API key</span>
        <input type="password" aria-label="API key" value={getApiKey()} placeholder="sk-…" onInput={(e) => setApiKey(e.currentTarget.value)} />
      </label>

      <label class="cf-field">
        <span class="cf-label">Company name</span>
        <input type="text" aria-label="Company name" value={cfg.companyName} placeholder="Acme Mutual Insurance" onInput={(e) => update({ companyName: e.currentTarget.value })} />
      </label>

      <label class="cf-field">
        <span class="cf-label">Token budget</span>
        <input type="number" aria-label="Token budget" value={cfg.tokenBudget} min={20_000} step={10_000} onInput={(e) => update({ tokenBudget: Number(e.currentTarget.value) || 0 })} />
      </label>

      <label class="cf-field">
        <span class="cf-label">Customer discount (%)</span>
        <input
          type="number"
          aria-label="Customer discount percent"
          value={cfg.discountPct}
          min={0}
          max={100}
          step={1}
          onInput={(e) => update({ discountPct: Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)) })}
        />
        <span class="cf-hint">Applied to the proposed Oracle solution (ADB + migration + DR); your current spend stays at list. Adjustable later in Refine.</span>
      </label>

      {incomplete ? <p class="cf-hint">Enter an API key and a company name to continue.</p> : <p class="cf-ok">Ready — click Next.</p>}
    </section>
  );
}
