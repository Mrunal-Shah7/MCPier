import type { ServerSummary } from '@mcpier/shared';

/** A plain-text table with a header row; columns padded to their widest cell. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** First line of a text, cut to `max` characters with an ellipsis. */
export function shorten(text: string | undefined, max = 60): string {
  if (!text) return '';
  const first = text.split('\n')[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export function statusLine(server: ServerSummary): string {
  const detail = server.status.detail ? `: ${server.status.detail}` : '';
  return `${server.name} is ${server.status.state}${detail}`;
}

/** Prints a JSON value for `--json`. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
