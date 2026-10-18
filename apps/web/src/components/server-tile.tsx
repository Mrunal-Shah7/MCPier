// A server's logo (Sprint 7): the icon the gateway cached and serves, or a coloured letter tile.
// The image comes from the icon route (img-src 'self'), with `?v=<etag>` to bust the cache. A
// broken image falls back to the tile once, so there is no error loop.
import { useState } from 'react';
import { API_PATHS, type ServerIconInfo } from '@mcpier/shared';
import { paletteBg } from '@/lib/palette';
import { useResolvedTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const SIZES = {
  sm: 'size-[22px] rounded-md text-[11px]',
  md: 'size-[30px] rounded-lg text-[13px]',
  lg: 'size-11 rounded-[11px] text-lg',
} as const;

export function iconUrl(name: string, icon: ServerIconInfo, theme: 'light' | 'dark'): string {
  const params = new URLSearchParams();
  if (icon.themes?.includes(theme)) params.set('theme', theme);
  if (icon.etag) params.set('v', icon.etag);
  const query = params.toString();
  return `${API_PATHS.serverIcon(name)}${query ? `?${query}` : ''}`;
}

export function ServerTile({
  name,
  icon,
  size = 'md',
  className,
}: {
  name: string;
  icon?: ServerIconInfo | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const theme = useResolvedTheme();
  const src = icon?.available ? iconUrl(name, icon, theme) : undefined;
  // Remember which URL failed, so a new etag (a new icon) is tried again.
  const [failed, setFailed] = useState<string | undefined>();
  if (src && failed !== src) {
    return (
      <img
        src={src}
        alt=""
        data-tile="icon"
        className={cn('shrink-0 bg-white object-contain p-0.5', SIZES[size], className)}
        onError={() => setFailed(src)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-tile="letter"
      className={cn(
        'grid shrink-0 place-items-center font-bold text-white uppercase select-none',
        SIZES[size],
        paletteBg(name),
        className,
      )}
    >
      {name.charAt(0)}
    </span>
  );
}
