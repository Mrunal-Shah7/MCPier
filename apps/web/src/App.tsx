import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError, onUnauthorized } from '@/lib/api';
import type { LiveEvents } from '@/lib/events';
import { LiveEventsProvider, useLiveUpdates } from '@/lib/live';
import { createQueryClient, useStatus } from '@/lib/queries';
import { ErrorMessage, LoadingRows } from '@/components/common';
import { Layout } from '@/components/layout';
import { ToastProvider } from '@/components/toaster';
import { NotSignedIn } from '@/pages/not-signed-in';
import { ServersPage } from '@/pages/servers';
import { ServerDetailPage } from '@/pages/server-detail';
import { AddServerPage, EditServerPage } from '@/pages/add-server';
import { ToolsPage } from '@/pages/tools';
import { SecretsPage } from '@/pages/secrets';
import { ConnectPage } from '@/pages/connect';
import { SettingsPage } from '@/pages/settings';
import { CallLogPage } from '@/pages/call-log';
import { TesterPage } from '@/pages/tester';

/** Everything below the auth check: live updates, the layout and the pages. */
function SignedIn({ onSignedOut }: { onSignedOut: () => void }) {
  useLiveUpdates(onSignedOut);
  const status = useStatus();
  if (!status.data) return null;
  return (
    <Layout status={status.data}>
      <Routes>
        <Route path="/" element={<Navigate to="/servers" replace />} />
        <Route path="/servers" element={<ServersPage />} />
        <Route path="/servers/new" element={<AddServerPage />} />
        <Route path="/servers/:name" element={<ServerDetailPage />} />
        <Route path="/servers/:name/edit" element={<EditServerPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/calls" element={<CallLogPage />} />
        <Route path="/tester" element={<TesterPage />} />
        <Route path="/secrets" element={<SecretsPage />} />
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<p className="text-muted-foreground">There is no page here.</p>} />
      </Routes>
    </Layout>
  );
}

/**
 * Checks /api/status first. Signed out (401) shows only the not-signed-in page and makes no
 * other request; nothing else mounts until the status check succeeds.
 */
export function AuthGate() {
  const status = useStatus();
  const [signedOut, setSignedOut] = useState(false);
  const markSignedOut = useCallback(() => setSignedOut(true), []);
  useEffect(() => onUnauthorized(markSignedOut), [markSignedOut]);

  if (signedOut || (status.error instanceof ApiError && status.error.unauthorized)) return <NotSignedIn />;
  if (status.isPending) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <LoadingRows rows={2} label="Loading MCPier" />
      </div>
    );
  }
  if (status.error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <ErrorMessage error={status.error} title="Cannot load the dashboard" />
      </div>
    );
  }
  return <SignedIn onSignedOut={markSignedOut} />;
}

export function Providers({
  client,
  events,
  children,
}: {
  client: QueryClient;
  events?: LiveEvents;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={client}>
      <LiveEventsProvider events={events}>
        <ToastProvider>{children}</ToastProvider>
      </LiveEventsProvider>
    </QueryClientProvider>
  );
}

const client = createQueryClient();

export function App() {
  return (
    <Providers client={client}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </Providers>
  );
}
