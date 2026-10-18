// Sprint 7, Phase 4: the shared pieces of the refresh: the destructive button, the error block,
// the server tile and the charts (empty, one point, normal, and their text alternatives).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { API_PATHS } from '@mcpier/shared';
import { BarList, Ring, Sparkline, StackedBars, type BarSeries } from '@/components/charts';
import { ErrorBlock } from '@/components/error-block';
import { ServerTile } from '@/components/server-tile';
import { Button } from '@/components/ui/button';
import { PALETTE_BG, paletteBg, paletteFill } from '@/lib/palette';
import { setTheme } from '@/lib/theme';

// The tests run from the repository root or from apps/web.
const css = readFileSync(
  [join('apps', 'web', 'src', 'index.css'), join('src', 'index.css')].find((path) => existsSync(path))!,
  'utf8',
);

afterEach(() => act(() => setTheme('system')));

describe('destructive button', () => {
  it.each(['light', 'dark'] as const)('%s theme: solid rose, darker rose on hover, never light', (theme) => {
    act(() => setTheme(theme));
    expect(document.documentElement.dataset.theme).toBe(theme);
    render(<Button variant="destructive">Delete files</Button>);
    const button = screen.getByRole('button', { name: 'Delete files' });
    const classes = button.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(['bg-tone-bad', 'text-white', 'hover:bg-tone-bad-strong']),
    );
    expect(classes).toEqual(expect.arrayContaining(['focus-visible:ring-tone-bad/40']));
    // Nothing turns it white or light on hover, and no theme-specific override exists.
    expect(classes.filter((name) => name.startsWith('hover:'))).toEqual(['hover:bg-tone-bad-strong']);
    expect(classes.some((name) => name.startsWith('dark:') && !name.includes('aria-invalid'))).toBe(false);
  });

  it('the rose tokens are the same in both themes', () => {
    expect(css).toMatch(/--tone-bad:\s*#f43f5e;/);
    expect(css).toMatch(/--color-tone-bad-strong:\s*#e11d48;/);
    // Dark blocks may lighten the rose *text* colour, never the solid fill.
    expect(css.match(/--tone-bad:/g)).toHaveLength(1);
  });

  it('the ghost variant for rows and menus: rose text, soft rose hover', () => {
    render(<Button variant="destructive-ghost">Delete</Button>);
    const classes = screen.getByRole('button', { name: 'Delete' }).className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['text-tone-bad-text', 'hover:bg-tone-bad-soft']));
  });
});

describe('error block', () => {
  it('shows the clean message, and the raw response behind a disclosure', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBlock
        message="Upstream answered HTTP 502: Bad gateway"
        raw={'<html><body><h1>502 Bad Gateway</h1></body></html>'}
        code={-32603}
      />,
    );
    const block = screen.getByRole('group', { name: 'Error' });
    expect(block).toHaveTextContent('Upstream answered HTTP 502: Bad gateway');
    expect(block).toHaveTextContent('Code -32603');
    const summary = within(block).getByText('Raw response');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByText(/502 Bad Gateway/)).toBeInTheDocument();
  });

  it('has no disclosure when the raw text is the message', () => {
    render(<ErrorBlock message="Tool failed" raw="Tool failed " />);
    expect(screen.queryByText('Raw response')).toBeNull();
  });

  it('a long unbroken string wraps inside the card instead of widening it', () => {
    const long = 'x'.repeat(4000);
    render(<ErrorBlock message={long} raw={`${long}y`} />);
    const block = screen.getByRole('group', { name: 'Error' });
    expect(block.className).toContain('min-w-0');
    expect(screen.getByText(long).className).toContain('wrap-anywhere');
    expect(block.querySelector('pre')!.className).toContain('wrap-anywhere');
    expect(css).toMatch(/\.wrap-anywhere\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

describe('server tile', () => {
  it('shows the cached icon from the icon route, with the etag', () => {
    render(<ServerTile name="notion" icon={{ available: true, source: 'domain', etag: 'abc123' }} />);
    const image = document.querySelector('img[data-tile="icon"]')!;
    expect(image.getAttribute('src')).toBe(`${API_PATHS.serverIcon('notion')}?v=abc123`);
    expect(image.getAttribute('alt')).toBe('');
  });

  it('falls back to the letter tile once when the image fails, with no retry loop', () => {
    render(<ServerTile name="notion" icon={{ available: true, source: 'domain', etag: 'e1' }} />);
    fireEvent.error(document.querySelector('img')!);
    const tile = document.querySelector('[data-tile="letter"]')!;
    expect(tile).toHaveTextContent('n');
    expect(document.querySelector('img')).toBeNull();
  });

  it('a new etag tries the image again', () => {
    const { rerender } = render(
      <ServerTile name="notion" icon={{ available: true, source: 'domain', etag: 'e1' }} />,
    );
    fireEvent.error(document.querySelector('img')!);
    rerender(<ServerTile name="notion" icon={{ available: true, source: 'domain', etag: 'e2' }} />);
    expect(document.querySelector('img')!.getAttribute('src')).toContain('v=e2');
  });

  it('without an icon: the letter tile in the same palette class for the same name', () => {
    render(
      <>
        <ServerTile name="github" />
        <ServerTile name="github" size="sm" />
        <ServerTile name="files" />
      </>,
    );
    const tiles = [...document.querySelectorAll('[data-tile="letter"]')];
    expect(tiles).toHaveLength(3);
    expect(tiles[0]!.className).toContain(paletteBg('github'));
    expect(tiles[1]!.className).toContain(paletteBg('github'));
    expect(PALETTE_BG).toHaveLength(12);
    expect(PALETTE_BG).toContain(paletteBg('files'));
    expect(paletteBg('github')).toBe(paletteBg('github'));
    expect(paletteFill('github').replace('fill-', '')).toBe(paletteBg('github').replace('bg-', ''));
  });
});

describe('charts', () => {
  describe('Sparkline', () => {
    it('empty: a flat baseline and "no data"', () => {
      render(<Sparkline values={[]} label="Calls per day" />);
      const chart = screen.getByRole('img', { name: 'Calls per day: no data' });
      expect(chart.querySelector('polyline')).toBeNull();
      expect(chart.querySelector('line')).not.toBeNull();
    });

    it('one point: a dot', () => {
      render(<Sparkline values={[4]} label="Calls per day" />);
      const chart = screen.getByRole('img', { name: /Calls per day: 1 points, from 4 to 4, highest 4/ });
      expect(chart.querySelectorAll('circle')).toHaveLength(1);
      expect(chart.querySelector('polyline')).toBeNull();
    });

    it('a series: a line with a tooltip per point', () => {
      render(
        <Sparkline
          values={[1, 5, 3]}
          label="Calls per day"
          pointLabel={(value, index) => `Day ${index}: ${value}`}
        />,
      );
      const chart = screen.getByRole('img', { name: 'Calls per day: 3 points, from 1 to 3, highest 5' });
      expect(chart.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3);
      expect([...chart.querySelectorAll('circle title')].map((title) => title.textContent)).toEqual([
        'Day 0: 1',
        'Day 1: 5',
        'Day 2: 3',
      ]);
    });
  });

  describe('StackedBars', () => {
    const series = (values: number[][]): BarSeries[] =>
      values.map((list, index) => ({
        key: `s${index}`,
        label: `server-${index}`,
        values: list,
        fillClass: paletteFill(`s${index}`),
        swatchClass: paletteBg(`s${index}`),
      }));

    it('empty: no bars, a summary, and an empty table', async () => {
      const user = userEvent.setup();
      render(<StackedBars labels={[]} series={[]} title="Calls per day" />);
      expect(screen.getByRole('img', { name: 'Calls per day: 0 calls in 0 buckets' })).toBeInTheDocument();
      expect(document.querySelectorAll('rect')).toHaveLength(0);
      await user.click(screen.getByRole('button', { name: 'Show as table' }));
      expect(screen.getByRole('table', { name: 'Calls per day' }).querySelectorAll('tbody tr')).toHaveLength(
        0,
      );
    });

    it('one bucket: one stack', () => {
      render(<StackedBars labels={['Mon']} series={series([[2], [3]])} title="Calls per day" />);
      expect(
        screen.getByRole('img', { name: 'Calls per day: 5 calls in 1 buckets, most in Mon (5)' }),
      ).toBeInTheDocument();
      expect(document.querySelectorAll('rect')).toHaveLength(2);
    });

    it('a series: stacks with tooltips, a legend, and the same numbers as a table', async () => {
      const user = userEvent.setup();
      render(
        <StackedBars
          labels={['Mon', 'Tue', 'Wed']}
          series={series([
            [1, 0, 4],
            [2, 3, 0],
          ])}
          title="Calls per day"
        />,
      );
      expect(
        screen.getByRole('img', { name: 'Calls per day: 10 calls in 3 buckets, most in Wed (4)' }),
      ).toBeInTheDocument();
      // Zero values draw nothing.
      expect(document.querySelectorAll('rect')).toHaveLength(4);
      expect([...document.querySelectorAll('rect title')].map((title) => title.textContent)).toContain(
        'server-1: 3 calls (Tue)',
      );
      expect(within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem')).toHaveLength(2);
      await user.click(screen.getByRole('button', { name: 'Show as table' }));
      const table = screen.getByRole('table', { name: 'Calls per day' });
      expect(
        [...table.querySelectorAll('tbody tr')].map((row) =>
          [...row.querySelectorAll('td')].map((cell) => cell.textContent),
        ),
      ).toEqual([
        ['Mon', '1', '2', '3'],
        ['Tue', '0', '3', '3'],
        ['Wed', '4', '0', '4'],
      ]);
      await user.click(screen.getByRole('button', { name: 'Show as chart' }));
      expect(screen.getByRole('img')).toBeInTheDocument();
    });
  });

  describe('BarList', () => {
    const row = (key: string, value: number) => ({
      key,
      label: key,
      text: key,
      value,
      display: `${value}k`,
      fillClass: paletteFill(key),
    });

    it('empty: "no data"', () => {
      render(<BarList rows={[]} title="Tokens by server" />);
      expect(screen.getByRole('list', { name: 'Tokens by server: no data' })).toBeInTheDocument();
    });

    it('one row: a full bar', () => {
      render(<BarList rows={[row('files', 3)]} title="Tokens by server" />);
      expect(screen.getByRole('list', { name: 'Tokens by server: files 3k' })).toBeInTheDocument();
      expect(document.querySelectorAll('rect')[1]!.getAttribute('width')).toBe('100');
    });

    it('rows: widths relative to the largest, or to a given maximum', () => {
      const { unmount } = render(
        <BarList rows={[row('files', 4), row('github', 1)]} title="Tokens by server" />,
      );
      expect(screen.getByRole('list', { name: 'Tokens by server: files 4k, github 1k' })).toBeInTheDocument();
      const widths = () =>
        [...document.querySelectorAll('rect')]
          .filter((_, index) => index % 2 === 1)
          .map((rect) => rect.getAttribute('width'));
      expect(widths()).toEqual(['100', '25']);
      unmount();
      render(<BarList rows={[row('a', 0.5), row('b', 0.25)]} title="Share" max={1} />);
      expect(widths()).toEqual(['50', '25']);
    });
  });

  describe('Ring', () => {
    it('no data: an empty ring and a dash', () => {
      render(<Ring value={null} label="Hit rate" />);
      const ring = screen.getByRole('img', { name: 'Hit rate: no data' });
      expect(ring).toHaveTextContent('—');
      expect(ring.querySelectorAll('circle')).toHaveLength(1);
    });

    it('zero and one: an empty and a full ring', () => {
      render(
        <>
          <Ring value={0} label="Zero" />
          <Ring value={1} label="Full" />
        </>,
      );
      expect(screen.getByRole('img', { name: 'Zero: 0%' }).querySelectorAll('circle')).toHaveLength(1);
      const full = screen.getByRole('img', { name: 'Full: 100%' }).querySelectorAll('circle')[1]!;
      const [shown, total] = full.getAttribute('stroke-dasharray')!.split(' ');
      expect(shown).toBe(total);
    });

    it('a share: the percentage, or the given text', () => {
      render(
        <>
          <Ring value={0.72} label="Hit rate" />
          <Ring value={0.5} label="Share" display="1 of 2" />
        </>,
      );
      expect(screen.getByRole('img', { name: 'Hit rate: 72%' })).toHaveTextContent('72%');
      expect(screen.getByRole('img', { name: 'Share: 1 of 2' })).toHaveTextContent('1 of 2');
    });
  });
});
