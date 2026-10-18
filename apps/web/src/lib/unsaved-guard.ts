// Asks before leaving a page with unsaved changes (the JSON editor). React Router's blocker needs
// a data router, which the dashboard does not use (D-045), so this listens for what leaves the
// page: closing or reloading it (`beforeunload`), and clicks on links to another page.
import { useEffect } from 'react';

export const UNSAVED_MESSAGE = 'You have unsaved changes. Leave without saving?';

export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    // Capture phase: runs before the router's own link handler, which skips prevented events.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || event.defaultPrevented) return;
      const next = new URL(link.href, window.location.href);
      if (next.origin !== window.location.origin) return;
      if (next.pathname === window.location.pathname) return;
      if (!window.confirm(UNSAVED_MESSAGE)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}
