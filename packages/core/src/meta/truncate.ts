import type { CallToolResult } from '../upstream/types.js';
import { serializedSize } from './schema.js';

export interface TruncationReport {
  /** Text bytes kept and dropped (UTF-8). */
  text?: { shownBytes: number; droppedBytes: number };
  /** Size of structuredContent that was dropped. */
  structuredDroppedBytes?: number;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function cutToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character start.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Applies the result size limit (`resultSizeLimitKb`):
 * - The combined text of all `text` content blocks is cut at the limit; later text blocks
 *   are dropped, and a note says how much was shown and how much was dropped.
 * - `structuredContent` larger than the limit is dropped, with a note in the text content.
 * - Image, audio, resource links and embedded resources pass through untouched.
 */
export function truncateResult(
  result: CallToolResult,
  limitKb: number,
): { result: CallToolResult; report: TruncationReport } {
  const limit = limitKb * 1024;
  const report: TruncationReport = {};
  const content = Array.isArray(result.content) ? result.content : [];
  const totalText = content.reduce(
    (sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0),
    0,
  );

  let blocks = content;
  if (totalText > limit) {
    let budget = limit;
    blocks = [];
    for (const block of content) {
      if (block.type !== 'text') {
        blocks.push(block);
        continue;
      }
      if (budget <= 0) continue;
      const kept = cutToBytes(block.text, budget);
      budget -= Buffer.byteLength(kept, 'utf8');
      blocks.push({ ...block, text: kept });
    }
    report.text = { shownBytes: limit - budget, droppedBytes: totalText - (limit - budget) };
  }

  const out: CallToolResult = { ...result, content: blocks };
  const notes: string[] = [];
  if (report.text) {
    notes.push(
      `[MCPier: output truncated. Showed ${kb(report.text.shownBytes)} of ${kb(totalText)}; ` +
        `${kb(report.text.droppedBytes)} dropped (limit ${limitKb} KB, the resultSizeLimitKb setting).]`,
    );
  }
  if (result.structuredContent !== undefined) {
    const size = serializedSize(result.structuredContent);
    if (size > limit) {
      delete out.structuredContent;
      report.structuredDroppedBytes = size;
      notes.push(`[MCPier: structured content of ${kb(size)} dropped (over the ${limitKb} KB limit).]`);
    }
  }
  if (notes.length > 0) out.content = [...blocks, { type: 'text', text: notes.join('\n') }];
  return { result: out, report };
}
