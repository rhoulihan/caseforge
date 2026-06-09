// A small, decorative loading spinner shown while an LLM call is in flight. The accompanying visible
// text (e.g. "Generating...") conveys status to assistive tech, so the spinner itself is aria-hidden.
// It inherits `currentColor`, so it reads correctly on the red button and in muted hint text.
export function Spinner() {
  return <span class="cf-spinner" aria-hidden="true" />;
}
