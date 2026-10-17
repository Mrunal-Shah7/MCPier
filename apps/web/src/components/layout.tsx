import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { AUTH_PATHS, type StatusResponse } from '@mcpier/shared';
import {
  CableIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  ScrollTextIcon,
  LogOutIcon,
  ServerIcon,
  SettingsIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react';
import { useStreamState } from '@/lib/live';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

const NAV = [
  { to: '/servers', label: 'Servers', icon: ServerIcon },
  { to: '/tools', label: 'Tools', icon: WrenchIcon },
  { to: '/calls', label: 'Call log', icon: ScrollTextIcon },
  { to: '/tester', label: 'Tester', icon: FlaskConicalIcon },
  { to: '/secrets', label: 'Secrets', icon: KeyRoundIcon },
  { to: '/connect', label: 'Connect', icon: CableIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

function ConnectionIndicator() {
  const state = useStreamState();
  const live = state === 'open';
  const label = live ? 'Live' : state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
      role="status"
      aria-label={`Live updates: ${label}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          live ? 'bg-emerald-500' : state === 'reconnecting' ? 'bg-amber-500 animate-pulse' : 'bg-zinc-400',
        )}
      />
      {label}
    </span>
  );
}

/**
 * Clears the HTTP-only cookie through the sign-out route, then reloads into the
 * not-signed-in page. A fetch, not a form: with `Referrer-Policy: no-referrer` the browser
 * sends `Origin: null` on a form POST, which the gateway's Origin check rightly refuses.
 */
async function signOut(): Promise<void> {
  await fetch(AUTH_PATHS.signout, { method: 'POST', credentials: 'same-origin', redirect: 'manual' }).catch(
    () => {},
  );
  window.location.assign('/');
}

/** Shown on every page while config.json on disk is invalid (D-027). */
export function ConfigProblemBanner({ problem }: { problem: StatusResponse['configProblem'] }) {
  if (!problem) return null;
  return (
    <Alert variant="destructive" className="mb-6" role="alert" aria-label="Config problem">
      <TriangleAlertIcon />
      <AlertTitle>config.json has problems</AlertTitle>
      <AlertDescription>
        <p>
          MCPier keeps running on the last good config. Changes through the dashboard and the CLI are paused
          until <code className="font-mono">{problem.file}</code> is fixed.
        </p>
        <ul className="mt-1 list-disc pl-5">
          {problem.problems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function Layout({ status, children }: { status: StatusResponse; children: ReactNode }) {
  const counts = status.servers.byStatus;
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border shrink-0 border-b md:min-h-svh md:w-52 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3 md:py-4">
          <span className="font-semibold tracking-tight">MCPier</span>
          <span className="text-muted-foreground text-xs">{status.version}</span>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-4">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'hover:bg-sidebar-accent/60',
                )
              }
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 md:px-6">
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span>
              {status.servers.enabled} of {status.servers.configured} servers enabled
              {counts.ready ? ` · ${counts.ready} ready` : ''}
            </span>
            <span>Port {status.port}</span>
            <ConnectionIndicator />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
            <LogOutIcon aria-hidden="true" />
            Sign out
          </Button>
        </header>
        <main className="w-full max-w-6xl flex-1 px-4 py-6 md:px-6">
          <ConfigProblemBanner problem={status.configProblem} />
          {children}
        </main>
      </div>
    </div>
  );
}
