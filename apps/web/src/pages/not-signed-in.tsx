/** Shown to a browser without the admin cookie. Says nothing about the gateway beyond this. */
export function NotSignedIn() {
  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">MCPier</h1>
        <p className="text-muted-foreground">This browser is not signed in to the MCPier dashboard.</p>
        <p>
          Run <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-sm">mcpier open</code> in a
          terminal.
        </p>
      </div>
    </main>
  );
}
