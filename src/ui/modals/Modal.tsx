// Minimal accessible modal primitive: backdrop click + Escape close, role="dialog", and focus
// management — moves focus into the dialog on open, traps Tab within it, and restores focus to the
// trigger on close. Styles in styles.css (.cf-overlay / .cf-modal).

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Mount once: capture the trigger, move focus inside, trap Tab, restore focus on unmount.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const initial = node?.querySelector<HTMLElement>(FOCUSABLE);
    (initial ?? node)?.focus();

    function focusables(): HTMLElement[] {
      return node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled')) : [];
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.(); // return focus to the element that opened the modal
    };
  }, []);

  return (
    <div class="cf-overlay" onClick={onClose}>
      <div class="cf-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div class="cf-modal-head">
          <h2>{title}</h2>
          <button type="button" class="cf-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div class="cf-modal-body">{children}</div>
        {footer ? <div class="cf-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
