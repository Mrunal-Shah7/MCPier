// What an icon file really is, decided by its bytes (Sprint 7): PNG, JPEG, GIF, WebP and ICO by
// their first bytes, SVG only when the text has an <svg> root. A declared type (Content-Type,
// mimeType, a file extension) is never trusted on its own. Nothing is parsed further or run.

export const ICON_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/svg+xml',
] as const;
export type IconContentType = (typeof ICON_TYPES)[number];

/** The file extension stored for each type. */
export const ICON_EXTENSIONS: Record<IconContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** A UTF-8 byte-order mark at the start of a text. */
const BOM = new RegExp('^﻿');

/** Script and markup an icon has no business carrying; such an SVG is refused. */
const SVG_FORBIDDEN = /<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:|<!ENTITY\b/i;

/**
 * Whether the text is an SVG document: after an optional byte-order mark, whitespace, an XML
 * declaration, comments and a doctype without an internal subset, the first element is `<svg`.
 */
export function isSvgText(text: string): boolean {
  let rest = text.replace(BOM, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<?xml')) {
      const end = rest.indexOf('?>');
      if (end < 0) return false;
      rest = rest.slice(end + 2);
    } else if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) return false;
      rest = rest.slice(end + 3);
    } else if (/^<!DOCTYPE/i.test(rest)) {
      const end = rest.indexOf('>');
      // An internal subset ([…]) can declare entities: not for an icon.
      if (end < 0 || rest.slice(0, end).includes('[')) return false;
      rest = rest.slice(end + 1);
    } else break;
  }
  return /^<svg[\s>/]/.test(rest);
}

/** The type the bytes prove, or undefined when they are not an accepted image. */
export function sniffImage(bytes: Uint8Array): IconContentType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  // ICO: reserved 0, type 1, and at least one image.
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) > 0)
    return 'image/x-icon';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (isSvgText(text) && !SVG_FORBIDDEN.test(text)) return 'image/svg+xml';
  return undefined;
}
