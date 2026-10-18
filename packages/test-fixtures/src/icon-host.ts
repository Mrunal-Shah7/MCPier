// A small web host for icon tests (Sprint 7), on 127.0.0.1: a page with icon links, favicons,
// themed logos, and the hostile cases (an oversized image, HTML named .png, an SVG with a script,
// redirect chains). It records the headers of every request, so a test can prove that no
// credential was ever sent.
import { crc32, deflateSync } from 'node:zlib';
import { listenFixture, notFound, type RunningFixture } from './http-common.js';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG of one colour (so a browser can draw it). */
export function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A real ICO holding one PNG image. */
export function pngIco(png: Buffer, size: number): Buffer {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

export const ICON_HOST_FILES = {
  apple: solidPng(96, [16, 185, 129]),
  small: solidPng(32, [56, 189, 248]),
  favicon: pngIco(solidPng(32, [245, 158, 11]), 32),
  light: solidPng(64, [240, 240, 240]),
  dark: solidPng(64, [20, 20, 20]),
  plain: solidPng(64, [167, 139, 250]),
  svg: Buffer.from(
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#10b981"/></svg>',
  ),
  scriptSvg: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script><rect width="1" height="1"/></svg>',
  ),
  /** Over 256 KB: a PNG signature followed by padding. */
  big: Buffer.concat([solidPng(8, [0, 0, 0]), Buffer.alloc(300 * 1024, 7)]),
  fakePng: Buffer.from('<!doctype html><html><body>Not an image</body></html>'),
} as const;

const PAGE = `<!doctype html>
<html><head>
<title>Fixture site</title>
<link rel="icon" href="/small.png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple.png">
<link rel="stylesheet" href="/style.css">
</head><body>Fixture</body></html>`;

const PLAIN_PAGE = '<!doctype html><html><head><title>No icons</title></head><body></body></html>';

export interface IconHost extends RunningFixture {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** Request paths, oldest first. */
  paths(): string[];
}

/**
 * Routes:
 * - `/` a page with an icon and an apple-touch-icon link; `/plain/` a page without links.
 * - `/apple.png`, `/small.png`, `/light.png`, `/dark.png`, `/plain.png`, `/logo.svg`, `/favicon.ico`.
 * - `/big.png` (over 256 KB), `/fake.png` (HTML), `/script.svg` (an SVG with a script).
 * - `/redirect/<n>`: n redirects, then `/apple.png`; `/headers.png`: an image (headers recorded).
 * - `/no-favicon/…`: everything 404 (a site without any icon).
 */
export async function startIconHost(): Promise<IconHost> {
  const seen: string[] = [];
  const image = (bytes: Buffer, type: string) =>
    new Response(new Uint8Array(bytes), { headers: { 'content-type': type } });
  const fixture = await listenFixture((request) => {
    const path = new URL(request.url).pathname;
    seen.push(path);
    if (path === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    if (path === '/plain/') return new Response(PLAIN_PAGE, { headers: { 'content-type': 'text/html' } });
    if (path.startsWith('/no-favicon/')) return notFound();
    const redirect = /^\/redirect\/(\d+)$/.exec(path);
    if (redirect) {
      const left = Number(redirect[1]);
      return new Response(null, {
        status: 302,
        headers: { location: left > 1 ? `/redirect/${left - 1}` : '/apple.png' },
      });
    }
    switch (path) {
      case '/apple.png':
        return image(ICON_HOST_FILES.apple, 'image/png');
      case '/small.png':
        return image(ICON_HOST_FILES.small, 'image/png');
      case '/light.png':
        return image(ICON_HOST_FILES.light, 'image/png');
      case '/dark.png':
        return image(ICON_HOST_FILES.dark, 'image/png');
      case '/plain.png':
      case '/headers.png':
        return image(ICON_HOST_FILES.plain, 'image/png');
      case '/logo.svg':
        return image(ICON_HOST_FILES.svg, 'image/svg+xml');
      case '/favicon.ico':
        return image(ICON_HOST_FILES.favicon, 'image/x-icon');
      case '/big.png':
        return image(ICON_HOST_FILES.big, 'image/png');
      case '/fake.png':
        return image(ICON_HOST_FILES.fakePng, 'image/png');
      case '/script.svg':
        return image(ICON_HOST_FILES.scriptSvg, 'image/svg+xml');
      default:
        return notFound();
    }
  });
  return { ...fixture, origin: `http://127.0.0.1:${fixture.port}`, paths: () => [...seen] };
}
