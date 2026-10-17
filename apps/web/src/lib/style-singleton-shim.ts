// MCPier's stand-in for `react-style-singleton`, swapped in by a Vite alias (Sprint 5 BUGS B-4).
//
// Radix's modal overlays (Select, DropdownMenu, Dialog, AlertDialog) lock page scrolling with
// `react-remove-scroll`, whose helpers inject a <style> element at run time. The dashboard's
// Content Security Policy (`style-src 'self'`, D-047) blocks it and the browser reports a
// violation. This stand-in injects nothing; the scroll lock lives in static CSS instead
// (`body[data-scroll-locked]` in index.css, which the same libraries still set).
//
// `react-remove-scroll` and `react-remove-scroll-bar` import only `styleSingleton`; the other two
// exports keep the module's shape.

/** A component that would have rendered a <style>: here it renders nothing. */
export function styleSingleton(): (props: { styles: string; dynamic?: boolean }) => null {
  return () => null;
}

export function styleHookSingleton(): (styles: string, isDynamic?: boolean) => void {
  return () => {};
}

export function stylesheetSingleton(): { add(style: string): void; remove(): void } {
  return { add: () => {}, remove: () => {} };
}
