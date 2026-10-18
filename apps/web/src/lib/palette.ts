// Colours by meaning and per server (Sprint 7). Every class name is written out in full: Tailwind
// only generates classes it finds literally in the source, and the CSP rules out inline styles.
import type { CallOutcomeName, ServerStatus } from '@mcpier/shared';

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'input' | 'invalid' | 'off';

/** Badge colours: readable text on a soft tint. */
export const TONE_BADGE: Record<Tone, string> = {
  ok: 'bg-tone-ok-soft text-tone-ok-text',
  info: 'bg-tone-info-soft text-tone-info-text',
  warn: 'bg-tone-warn-soft text-tone-warn-text',
  bad: 'bg-tone-bad-soft text-tone-bad-text',
  input: 'bg-tone-input-soft text-tone-input-text',
  invalid: 'bg-tone-invalid-soft text-tone-invalid-text',
  off: 'bg-tone-off-soft text-tone-off-text',
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-tone-ok-text',
  info: 'text-tone-info-text',
  warn: 'text-tone-warn-text',
  bad: 'text-tone-bad-text',
  input: 'text-tone-input-text',
  invalid: 'text-tone-invalid-text',
  off: 'text-tone-off-text',
};

/** SVG strokes and fills (sparklines, bars) in a tone's base colour. */
export const TONE_STROKE: Record<Tone, string> = {
  ok: 'stroke-tone-ok',
  info: 'stroke-tone-info',
  warn: 'stroke-tone-warn',
  bad: 'stroke-tone-bad',
  input: 'stroke-tone-input',
  invalid: 'stroke-tone-invalid',
  off: 'stroke-tone-off',
};

export const TONE_FILL: Record<Tone, string> = {
  ok: 'fill-tone-ok',
  info: 'fill-tone-info',
  warn: 'fill-tone-warn',
  bad: 'fill-tone-bad',
  input: 'fill-tone-input',
  invalid: 'fill-tone-invalid',
  off: 'fill-tone-off',
};

/** A table row's status edge (`index.css`). */
export const TONE_EDGE: Record<Tone, string> = {
  ok: 'edge-ok',
  info: 'edge-info',
  warn: 'edge-warn',
  bad: 'edge-bad',
  input: 'edge-info',
  invalid: 'edge-warn',
  off: 'edge-off',
};

/** Confirmed decision 2: one tone per server status and call outcome, everywhere. */
export const STATUS_TONE: Record<ServerStatus, Tone> = {
  ready: 'ok',
  starting: 'info',
  needs_auth: 'warn',
  error: 'bad',
  crashed: 'bad',
  stopped: 'off',
};

export const OUTCOME_TONE: Record<CallOutcomeName, Tone> = {
  ok: 'ok',
  tool_error: 'bad',
  validation_error: 'invalid',
  not_found: 'off',
  disabled: 'off',
  not_ready: 'off',
  timeout: 'warn',
  cancelled: 'off',
  input_required: 'input',
  failed: 'bad',
};

export const PALETTE_BG = [
  'bg-pal-0',
  'bg-pal-1',
  'bg-pal-2',
  'bg-pal-3',
  'bg-pal-4',
  'bg-pal-5',
  'bg-pal-6',
  'bg-pal-7',
  'bg-pal-8',
  'bg-pal-9',
  'bg-pal-10',
  'bg-pal-11',
] as const;

export const PALETTE_FILL = [
  'fill-pal-0',
  'fill-pal-1',
  'fill-pal-2',
  'fill-pal-3',
  'fill-pal-4',
  'fill-pal-5',
  'fill-pal-6',
  'fill-pal-7',
  'fill-pal-8',
  'fill-pal-9',
  'fill-pal-10',
  'fill-pal-11',
] as const;

export const PALETTE_STROKE = [
  'stroke-pal-0',
  'stroke-pal-1',
  'stroke-pal-2',
  'stroke-pal-3',
  'stroke-pal-4',
  'stroke-pal-5',
  'stroke-pal-6',
  'stroke-pal-7',
  'stroke-pal-8',
  'stroke-pal-9',
  'stroke-pal-10',
  'stroke-pal-11',
] as const;

/** A stable index 0–11 for a name (FNV-1a): the same server always gets the same colour. */
export function paletteIndex(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PALETTE_BG.length;
}

export const paletteBg = (name: string) => PALETTE_BG[paletteIndex(name)]!;
export const paletteFill = (name: string) => PALETTE_FILL[paletteIndex(name)]!;
export const paletteStroke = (name: string) => PALETTE_STROKE[paletteIndex(name)]!;

/**
 * Colours for names drawn together (one chart's series): each keeps its own colour unless an
 * earlier name took it, then takes the next free one, so no two series share a colour while
 * there are at most 12.
 */
export function distinctPalette(names: readonly string[]): (name: string) => number {
  const taken = new Set<number>();
  const chosen = new Map<string, number>();
  for (const name of names) {
    if (chosen.has(name)) continue;
    let index = paletteIndex(name);
    for (let step = 0; step < PALETTE_BG.length && taken.has(index); step++) {
      index = (index + 1) % PALETTE_BG.length;
    }
    taken.add(index);
    chosen.set(name, index);
  }
  return (name) => chosen.get(name) ?? paletteIndex(name);
}
