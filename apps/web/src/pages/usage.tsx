import { Link, useSearchParams } from 'react-router';
import { splitFullToolName, USAGE_RANGES, type UsageRangeName, type UsageResponse } from '@mcpier/shared';
import { formatRate } from '@/lib/call-log';
import { distinctPalette, PALETTE_BG, PALETTE_FILL } from '@/lib/palette';
import { useServers, useSettings } from '@/lib/queries';
import { bucketLabel, formatTokens, useUsage } from '@/lib/usage';
import { ErrorMessage, LoadingRows } from '@/components/common';
import { BarList, Sparkline, StackedBars, type BarSeries } from '@/components/charts';
import {
  Delta,
  EmptyLine,
  KpiCard,
  PageTitle,
  Panel,
  PanelBody,
  PanelHeader,
  RailGrid,
  Segmented,
} from '@/components/kit';
import { ServerTile } from '@/components/server-tile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const RANGE_OPTIONS: { value: UsageRangeName; label: string; days: number }[] = [
  { value: '24h', label: '24 h', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
];

/** Most series a stacked chart draws; the rest are summed as "Other". */
const MAX_SERIES = 8;

function seriesBy(report: UsageResponse, by: 'server' | 'client'): BarSeries[] {
  const totals = new Map<string, number>();
  for (const point of report.series) {
    for (const [key, count] of Object.entries(by === 'server' ? point.byServer : point.byClient)) {
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
  }
  const keys = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const shown = keys.slice(0, MAX_SERIES);
  const rest = keys.slice(MAX_SERIES);
  const colour = distinctPalette(shown);
  const series: BarSeries[] = shown.map((key) => ({
    key,
    label: key,
    values: report.series.map((point) => (by === 'server' ? point.byServer : point.byClient)[key] ?? 0),
    fillClass: PALETTE_FILL[colour(key)]!,
    swatchClass: PALETTE_BG[colour(key)]!,
  }));
  if (rest.length > 0) {
    series.push({
      key: '__other',
      label: 'Other',
      values: report.series.map((point) =>
        rest.reduce((sum, key) => sum + ((by === 'server' ? point.byServer : point.byClient)[key] ?? 0), 0),
      ),
      fillClass: 'fill-tone-off',
      swatchClass: 'bg-tone-off',
    });
  }
  return series;
}

function UsageReport({
  report,
  by,
  onBy,
}: {
  report: UsageResponse;
  by: 'server' | 'client';
  onBy: (by: 'server' | 'client') => void;
}) {
  const servers = useServers();
  const iconOf = (name: string) => servers.data?.servers.find((server) => server.name === name)?.icon;
  const { totals, previous } = report;
  const serverColour = distinctPalette(report.byServer.map((row) => row.server));
  const clientColour = distinctPalette(report.byClient.map((row) => row.client));
  const labels = report.series.map((point) => bucketLabel(point.start, report.bucket));
  const perBucket = report.bucket === 'hour' ? 'per hour' : 'per day';

  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Calls"
          value={totals.calls.toLocaleString()}
          delta={<Delta current={totals.calls} previous={previous.calls} suffix=" vs before" />}
          chart={
            <Sparkline values={report.series.map((point) => point.calls)} label={`Calls ${perBucket}`} />
          }
        />
        <KpiCard
          label="Est. tokens returned"
          value={formatTokens(totals.tokens)}
          delta={<Delta current={totals.tokens} previous={previous.tokens} goodWhen="down" />}
          chart={
            <Sparkline
              values={report.series.map((point) => point.tokens)}
              label={`Estimated tokens ${perBucket}`}
              tone="info"
            />
          }
        />
        <KpiCard
          label="Avg tokens per call"
          value={totals.avgTokensPerCall === null ? '—' : totals.avgTokensPerCall.toLocaleString()}
          delta={<span className="text-muted-foreground">p95 {formatTokens(totals.p95TokensPerCall)}</span>}
        />
        <KpiCard
          label="Error rate"
          value={formatRate(totals.errorRate)}
          delta={<Delta current={totals.errorRate} previous={previous.errorRate} goodWhen="down" points />}
          chart={
            <Sparkline
              values={report.series.map((point) => point.errors)}
              label={`Errors ${perBucket}`}
              tone="bad"
            />
          }
        />
      </div>

      <RailGrid className="mb-4">
        <Panel aria-label="Calls per bucket">
          <PanelHeader
            title={report.bucket === 'hour' ? 'Calls per hour' : 'Calls per day'}
            actions={
              <Segmented<'server' | 'client'>
                label="Group by"
                value={by}
                options={[
                  { value: 'server', label: 'By server' },
                  { value: 'client', label: 'By client' },
                ]}
                onChange={onBy}
              />
            }
          />
          <PanelBody>
            <StackedBars
              labels={labels}
              series={seriesBy(report, by)}
              title={`Calls ${perBucket} by ${by}`}
            />
          </PanelBody>
        </Panel>
        <Panel aria-label="Tokens by server">
          <PanelHeader title="Tokens by server" />
          <PanelBody>
            {report.byServer.length === 0 ? (
              <p className="text-muted-foreground m-0 text-sm">No calls in this range.</p>
            ) : (
              <BarList
                title="Estimated tokens by server"
                rows={report.byServer.map((row) => ({
                  key: row.server,
                  label: (
                    <span className="flex items-center gap-2">
                      <ServerTile name={row.server} icon={iconOf(row.server)} size="sm" />
                      {row.server}
                    </span>
                  ),
                  text: row.server,
                  value: row.tokens,
                  display: formatTokens(row.tokens),
                  fillClass: PALETTE_FILL[serverColour(row.server)]!,
                }))}
              />
            )}
          </PanelBody>
        </Panel>
      </RailGrid>

      <RailGrid>
        <Panel aria-label="Heaviest tools" className="overflow-hidden">
          <PanelHeader
            title="Heaviest tools"
            actions={<span className="text-faint text-xs">by tokens returned</span>}
          />
          {report.heaviestTools.length === 0 ? (
            <EmptyLine>No calls in this range.</EmptyLine>
          ) : (
            <Table aria-label="Heaviest tools">
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Avg tokens</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="hidden md:table-cell">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.heaviestTools.map((row) => {
                  const parts = splitFullToolName(row.tool);
                  const href =
                    row.server && parts
                      ? `/servers/${encodeURIComponent(row.server)}?tab=tools&tool=${encodeURIComponent(parts.tool)}`
                      : undefined;
                  const name = parts?.tool ?? row.tool;
                  return (
                    <TableRow key={row.tool} data-tool={row.tool}>
                      <TableCell className="max-w-72">
                        <span className="flex min-w-0 items-center gap-2">
                          {row.server ? (
                            <ServerTile name={row.server} icon={iconOf(row.server)} size="sm" />
                          ) : null}
                          {href ? (
                            <Link
                              to={href}
                              className="truncate font-mono text-xs hover:underline"
                              title={row.tool}
                            >
                              {name}
                            </Link>
                          ) : (
                            <span className="truncate font-mono text-xs">{name}</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.calls.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.avgTokens === null ? '—' : row.avgTokens.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatTokens(row.tokens)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Sparkline
                          values={row.series}
                          label={`${row.tool} tokens ${perBucket}`}
                          tone="info"
                          width={70}
                          height={20}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
        <Panel aria-label="By client">
          <PanelHeader title="By client" />
          <PanelBody>
            {report.byClient.length === 0 ? (
              <p className="text-muted-foreground m-0 text-sm">No calls in this range.</p>
            ) : (
              <BarList
                title="Share of calls by client"
                max={1}
                rows={report.byClient.map((row) => ({
                  key: row.client,
                  label: row.client,
                  text: row.client,
                  value: row.share,
                  display: `${Math.round(row.share * 100)}%`,
                  fillClass: PALETTE_FILL[clientColour(row.client)]!,
                }))}
              />
            )}
          </PanelBody>
        </Panel>
      </RailGrid>
    </>
  );
}

export function UsagePage() {
  const [params, setParams] = useSearchParams();
  const settings = useSettings();
  const retention = settings.data?.settings.logRetentionDays;
  const requested = params.get('range');
  const range: UsageRangeName = requested && requested in USAGE_RANGES ? (requested as UsageRangeName) : '7d';
  const by = params.get('by') === 'client' ? 'client' : 'server';
  const usage = useUsage({ range });
  const update = (change: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };
  const without = usage.data?.totals.callsWithoutSize ?? 0;

  return (
    <>
      <PageTitle
        title="Usage"
        info="Tokens are estimates: about 4 bytes of each result, as the client received it, per token. Image blocks count by their encoded size. Usage covers the call log's retention period."
        actions={
          <Segmented<UsageRangeName>
            label="Range"
            value={range}
            options={RANGE_OPTIONS.map((option) => {
              const tooLong = retention !== undefined && option.days > retention;
              return {
                value: option.value,
                label: option.label,
                disabled: tooLong,
                ...(tooLong ? { title: `Longer than the call log keeps (${retention} days)` } : {}),
              };
            })}
            onChange={(value) => update({ range: value === '7d' ? undefined : value })}
          />
        }
      />
      {usage.isPending ? (
        <LoadingRows label="Loading usage" />
      ) : usage.error ? (
        <ErrorMessage error={usage.error} title="Cannot load usage" />
      ) : (
        <>
          {without > 0 || usage.data.clipped ? (
            <p className="text-faint mb-3 text-xs" role="note">
              {without > 0
                ? `${without.toLocaleString()} ${without === 1 ? 'call has' : 'calls have'} no size (recorded before 1.1.0): counted, not estimated.`
                : null}
              {usage.data.clipped
                ? ` Limited to the last ${usage.data.retentionDays} days the call log keeps.`
                : null}
            </p>
          ) : null}
          <UsageReport
            report={usage.data}
            by={by}
            onBy={(value) => update({ by: value === 'server' ? undefined : value })}
          />
        </>
      )}
    </>
  );
}
