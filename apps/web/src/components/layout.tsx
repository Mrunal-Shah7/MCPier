import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { AUTH_PATHS, type StatusResponse } from '@mcpier/shared';
import {
  ChartLineIcon,
  CableIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  ScrollTextIcon,
  LogOutIcon,
  MoonIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react';
import { useStreamState } from '@/lib/live';
import { useServers } from '@/lib/queries';
import { toggleTheme, useResolvedTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type NavItem = { to: string; label: string; icon: typeof ServerIcon; count?: 'servers' | 'tools' };

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Manage',
    items: [
      { to: '/servers', label: 'Servers', icon: ServerIcon, count: 'servers' },
      { to: '/tools', label: 'Tools', icon: WrenchIcon, count: 'tools' },
    ],
  },
  {
    group: 'Observe',
    items: [
      { to: '/calls', label: 'Call log', icon: ScrollTextIcon },
      { to: '/usage', label: 'Usage', icon: ChartLineIcon },
      { to: '/tester', label: 'Tester', icon: FlaskConicalIcon },
    ],
  },
  {
    group: 'Configure',
    items: [
      { to: '/secrets', label: 'Secrets', icon: KeyRoundIcon },
      { to: '/connect', label: 'Connect', icon: CableIcon },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

const pill =
  'bg-card text-muted-foreground inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap';

function ConnectionIndicator() {
  const state = useStreamState();
  const live = state === 'open';
  const label = live ? 'Live' : state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <span className={pill} role="status" aria-label={`Live updates: ${label}`}>
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          live ? 'bg-tone-ok' : state === 'reconnecting' ? 'bg-tone-warn animate-pulse' : 'bg-tone-off',
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
    <div
      role="alert"
      aria-label="Config problem"
      className="border-tone-warn/35 bg-tone-warn-soft text-tone-warn-text mb-4 flex flex-wrap items-start gap-x-2.5 gap-y-1 rounded-[10px] border px-3.5 py-2.5 text-[13px]"
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-semibold">config.json has problems</p>
        <ul className="wrap-anywhere mt-1 list-none p-0 font-mono text-xs">
          {problem.problems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <span className="text-xs">Changes paused until {problem.file} is fixed</span>
    </div>
  );
}

function ThemeSwitch() {
  const theme = useResolvedTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Switch to ${next} theme`}
      onClick={toggleTheme}
    >
      {theme === 'dark' ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
    </Button>
  );
}

export function Layout({ status, children }: { status: StatusResponse; children: ReactNode }) {
  const counts = status.servers.byStatus;
  const servers = useServers();
  const toolCount = servers.data?.servers.reduce((sum, server) => sum + server.tools.total, 0);
  const countOf = (kind: NavItem['count']) =>
    kind === 'servers' ? status.servers.configured : kind === 'tools' ? toolCount : undefined;
  const needSignIn = counts.needs_auth ?? 0;

  return (
    <div className="grid min-h-svh grid-cols-1 md:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="bg-sidebar border-sidebar-border min-w-0 border-b md:border-r md:border-b-0">
        <div className="md:sticky md:top-0 md:h-svh md:overflow-y-auto md:px-3 md:py-4">
          <div className="flex items-center gap-2.5 px-4 py-3 md:px-2 md:pt-1 md:pb-4">
            <span
              aria-hidden="true"
              className="from-brand grid size-7 place-items-center rounded-lg bg-linear-to-br to-sky-500 text-[13px] font-extrabold text-[#04140e]"
            >
              M
            </span>
            <span className="font-semibold tracking-tight">MCPier</span>
            <span className="text-faint text-[11px]">{status.version}</span>
          </div>
          <nav
            aria-label="Main"
            className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:p-0"
          >
            {NAV.map(({ group, items }) => (
              <div key={group} className="contents md:block">
                <div className="text-faint hidden px-2.5 pt-3.5 pb-1.5 text-[10.5px] tracking-[0.08em] uppercase md:block">
                  {group}
                </div>
                {items.map(({ to, label, icon: Icon, count }) => {
                  const value = countOf(count);
                  return (
                    <NavLink
                      key={to}
                      to={to}
                      className={({ isActive }) =>
                        cn(
                          'relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm whitespace-nowrap',
                          isActive
                            ? 'bg-sidebar-accent text-foreground md:before:bg-brand md:before:absolute md:before:top-2 md:before:bottom-2 md:before:-left-3 md:before:w-[3px] md:before:rounded-r-[3px] md:before:content-[""] [&>svg]:text-brand'
                            : 'text-muted-foreground hover:bg-panel-2 hover:text-foreground',
                        )
                      }
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {label}
                      {value !== undefined ? (
                        <span className="text-faint ml-auto hidden pl-2 text-[11px] tabular-nums md:inline">
                          {value}
                        </span>
                      ) : null}
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </nav>
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="bg-background/85 sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b px-4 py-2.5 backdrop-blur md:px-7">
          <ConnectionIndicator />
          <span className={pill}>
            {status.servers.configured} {status.servers.configured === 1 ? 'server' : 'servers'} ·{' '}
            {counts.ready ?? 0} ready
          </span>
          {needSignIn > 0 ? (
            <Link
              to="/servers?filter=attention"
              className={cn(pill, 'border-tone-warn/40 text-tone-warn-text hover:bg-tone-warn-soft')}
            >
              {needSignIn} {needSignIn === 1 ? 'needs' : 'need'} sign-in
            </Link>
          ) : null}
          <span className={cn(pill, 'font-mono')} aria-label={`Port ${status.port}`}>
            :{status.port}
          </span>
          <span className="flex-1" />
          <ThemeSwitch />
          <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
            <LogOutIcon aria-hidden="true" />
            Sign out
          </Button>
        </header>
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 pt-6 pb-12 md:px-7">
          <ConfigProblemBanner problem={status.configProblem} />
          {children}
        </main>
      </div>
    </div>
  );
}
