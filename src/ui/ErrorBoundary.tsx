// Catches otherwise-unhandled errors: render crashes (Preact componentDidCatch) and global
// window 'error' / 'unhandledrejection' events. All route to the error reporter and surface the
// "send a report" dialog. A render crash also shows a recover-by-reload fallback.

import { Component, type ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { useErrors } from './ErrorContext';

class CrashBoundary extends Component<{ onError: (e: unknown) => void; children: ComponentChildren }, { crashed: boolean }> {
  state = { crashed: false };

  componentDidCatch(error: unknown): void {
    this.setState({ crashed: true });
    this.props.onError(error);
  }

  render() {
    if (this.state.crashed) {
      return (
        <section class="cf-card">
          <h2>Something went wrong</h2>
          <p class="cf-sub">CaseForge hit an unexpected error. A report has been prepared — please send it so we can fix it, then reload.</p>
          <button type="button" class="cf-btn" onClick={() => window.location.reload()}>
            Reload CaseForge
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

export function ErrorBoundary({ children }: { children: ComponentChildren }) {
  const { capture } = useErrors();
  useEffect(() => {
    const onError = (e: ErrorEvent): void => capture(e.error ?? e.message, { category: 'unexpected', title: 'Unexpected error' });
    const onRejection = (e: PromiseRejectionEvent): void => capture(e.reason, { category: 'unexpected', title: 'Unhandled promise rejection' });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [capture]);

  return <CrashBoundary onError={(e) => capture(e, { category: 'unexpected', title: 'Unexpected error' })}>{children}</CrashBoundary>;
}
