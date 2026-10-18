// The light/dark theme (Sprint 7). It follows the system until the switch in the header picks
// one; the choice lives in memory for this page only (the dashboard never uses browser storage).
// The resolved theme is written on <html data-theme>, which the stylesheet and `dark:` read.
import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

let choice: ThemeChoice = 'system';
const listeners = new Set<() => void>();

function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function resolvedTheme(): ResolvedTheme {
  return choice === 'system' ? systemTheme() : choice;
}

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = resolvedTheme();
  for (const listener of listeners) listener();
}

/** Writes the theme on <html> and follows system changes. Called once before the app renders. */
export function initTheme(): void {
  apply();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (choice === 'system') apply();
  });
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  apply();
}

/** Light ↔ dark: the switch picks the opposite of what is shown now. */
export function toggleTheme(): void {
  setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, resolvedTheme, () => 'light');
}
