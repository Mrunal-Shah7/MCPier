import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createLiveEvents, type LiveEvents, type StreamState } from './events';
import { applyEvent } from './queries';

const LiveContext = createContext<LiveEvents | undefined>(undefined);

/** Provides the app's one event-stream connection (tests pass a fake). */
export function LiveEventsProvider({ events, children }: { events?: LiveEvents; children: ReactNode }) {
  const value = events ?? defaultEvents();
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

let shared: LiveEvents | undefined;
function defaultEvents(): LiveEvents {
  shared ??= createLiveEvents();
  return shared;
}

export function useLiveEvents(): LiveEvents {
  const events = useContext(LiveContext);
  if (!events) throw new Error('useLiveEvents needs a LiveEventsProvider');
  return events;
}

/**
 * While mounted (signed in): keeps the stream open, writes each event into the query cache,
 * re-fetches everything after a reconnect, and reports a 401 as signed out.
 */
export function useLiveUpdates(onSignedOut: () => void): void {
  const events = useLiveEvents();
  const client = useQueryClient();
  useEffect(() => {
    const offs = [
      events.subscribe((event) => applyEvent(client, event)),
      events.onReconnect(() => void client.invalidateQueries()),
      events.onUnauthorized(onSignedOut),
    ];
    events.start();
    return () => {
      for (const off of offs) off();
      events.stop();
    };
  }, [events, client, onSignedOut]);
}

export function useStreamState(): StreamState {
  const events = useLiveEvents();
  return useSyncExternalStore(
    (notify) => events.onState(notify),
    () => events.state,
    () => events.state,
  );
}
