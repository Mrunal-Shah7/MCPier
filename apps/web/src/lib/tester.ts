// The Tester's requests and its run history. The history lives in this module's memory only:
// it lasts while the page is open and is never written to browser storage.
import { useSyncExternalStore } from 'react';
import {
  CALL_LOG_PATHS,
  type TesterCallRequest,
  type TesterCallResponse,
  type TesterMode,
  type ValidateArgumentsResponse,
} from '@mcpier/shared';
import { api } from './api';

export const runTester = (tool: string, request: TesterCallRequest) =>
  api.post<TesterCallResponse>(CALL_LOG_PATHS.test(tool), request);

export const validateArguments = (tool: string, args: Record<string, unknown>) =>
  api.post<ValidateArgumentsResponse>(CALL_LOG_PATHS.validate(tool), { arguments: args });

export interface TesterRun {
  id: number;
  at: string;
  tool: string;
  mode: TesterMode;
  arguments: Record<string, unknown>;
  response: TesterCallResponse;
}

export const HISTORY_SIZE = 20;

let runs: readonly TesterRun[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export function recordRun(run: Omit<TesterRun, 'id' | 'at'>): TesterRun {
  const entry: TesterRun = { ...run, id: nextId++, at: new Date().toISOString() };
  runs = [entry, ...runs].slice(0, HISTORY_SIZE);
  for (const listener of listeners) listener();
  return entry;
}

export function findRun(id: number): TesterRun | undefined {
  return runs.find((run) => run.id === id);
}

/** Tests start from an empty history. */
export function resetTesterHistory(): void {
  runs = [];
  for (const listener of listeners) listener();
}

export function useTesterHistory(): readonly TesterRun[] {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => runs,
    () => runs,
  );
}

/** One `inputRequests` entry, as the gateway passes it on from the upstream server. */
export interface InputRequest {
  method?: string;
  params?: {
    mode?: string;
    message?: string;
    requestedSchema?: unknown;
    [key: string]: unknown;
  };
}

/** MCPier's own input_required answer (model mode): the requests and the signed state. */
export function inputRequiredOf(
  response: TesterCallResponse | undefined,
): { requestState: string; inputRequests: Record<string, InputRequest> } | undefined {
  const result = response?.result as
    { resultType?: unknown; requestState?: unknown; inputRequests?: unknown } | undefined;
  if (response?.mode !== 'model' || result?.resultType !== 'input_required') return undefined;
  if (
    typeof result.requestState !== 'string' ||
    typeof result.inputRequests !== 'object' ||
    !result.inputRequests
  ) {
    return undefined;
  }
  return {
    requestState: result.requestState,
    inputRequests: result.inputRequests as Record<string, InputRequest>,
  };
}

/** An elicitation answer, as the retry sends it in `inputResponses`. */
export type ElicitationAnswer =
  { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };
