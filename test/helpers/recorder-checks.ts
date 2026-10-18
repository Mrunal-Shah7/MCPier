import { expect } from 'vitest';
import type { MemoryRecorder } from '@mcpier/core';

// Sprint 6: call events may carry the arguments and result (already redacted) and an error
// text; the forbidden-values check below is what proves the redaction.
const CALL_KEYS = [
  'at',
  'client',
  'era',
  'tool',
  'server',
  'durationMs',
  'outcome',
  'traceId',
  'arguments',
  'result',
  'resultBytes',
  'errorText',
];
const SEARCH_KEYS = [
  'at',
  'client',
  'era',
  'query',
  'server',
  'limit',
  'resultCount',
  'results',
  'durationMs',
  'resultBytes',
];

/**
 * Every recorded event has only the allowed fields (never answers or request state), one event
 * was recorded per call and per search, and none of the `forbidden` strings (secret values,
 * answers) appears anywhere in them.
 */
export function expectCleanRecorder(
  recorder: MemoryRecorder,
  expected: { calls: number; searches: number },
  forbidden: readonly string[] = [],
): void {
  expect(recorder.calls).toHaveLength(expected.calls);
  expect(recorder.searches).toHaveLength(expected.searches);
  for (const event of recorder.calls) {
    for (const key of Object.keys(event)) expect(CALL_KEYS).toContain(key);
    expect(typeof event.outcome).toBe('string');
    expect(typeof event.durationMs).toBe('number');
  }
  for (const event of recorder.searches) {
    for (const key of Object.keys(event)) expect(SEARCH_KEYS).toContain(key);
  }
  const serialized = JSON.stringify({ calls: recorder.calls, searches: recorder.searches });
  for (const value of forbidden) expect(serialized).not.toContain(value);
  expect(serialized).not.toMatch(/mcpier1\./);
}
