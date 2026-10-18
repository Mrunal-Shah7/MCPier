/** Shown to a browser without the admin cookie. Says nothing about the gateway beyond this. */
export function NotSignedIn() {
  return (
    <main className="grid min-h-svh place-items-center px-4">
      <div className="bg-card shadow-card flex w-full max-w-[380px] flex-col items-center gap-3 rounded-[10px] border px-7 py-8 text-center">
        <span
          aria-hidden="true"
          className="from-brand grid size-11 place-items-center rounded-[11px] bg-linear-to-br to-sky-500 text-lg font-extrabold text-[#04140e]"
        >
          M
        </span>
        <h1 className="text-base font-semibold">Not signed in</h1>
        <p className="text-muted-foreground m-0 text-sm">
          To open the dashboard in this browser, run in a terminal:
        </p>
        <pre className="bg-panel-2 m-0 w-full rounded-lg border px-3.5 py-2.5 font-mono text-sm">
          mcpier open
        </pre>
      </div>
    </main>
  );
}
