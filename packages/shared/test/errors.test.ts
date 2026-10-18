import { describe, expect, it } from 'vitest';
import { CLEAN_ERROR_PARSE_LIMIT, cleanErrorMessage } from '../src/errors.js';

describe('cleanErrorMessage', () => {
  it('unwraps a JSON-RPC error behind a prefix, with its code', () => {
    const raw =
      'MCP error -32603: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Request is missing required authentication credential."}}';
    expect(cleanErrorMessage(raw)).toEqual({
      message: 'Request is missing required authentication credential.',
      code: -32603,
    });
  });

  it('keeps a code from the prefix when the JSON has none', () => {
    expect(cleanErrorMessage('MCP error -32001: {"message":"Session not found"}')).toEqual({
      message: 'Session not found',
      code: -32001,
    });
    expect(cleanErrorMessage('HTTP 401: {"error":"invalid_token"}')).toEqual({
      message: 'invalid_token',
      code: 401,
    });
  });

  it('reads an OAuth error body: the description first, then the error', () => {
    expect(
      cleanErrorMessage('{"error":"invalid_token","error_description":"The access token expired"}'),
    ).toEqual({ message: 'The access token expired' });
    expect(cleanErrorMessage('{"error":"invalid_grant"}')).toEqual({ message: 'invalid_grant' });
  });

  it('takes the fields in order: message, detail, title, errors[0].message', () => {
    expect(cleanErrorMessage('{"detail":"Not allowed","title":"Forbidden"}').message).toBe('Not allowed');
    expect(cleanErrorMessage('{"title":"Forbidden","status":403}')).toEqual({
      message: 'Forbidden',
      code: 403,
    });
    expect(cleanErrorMessage('{"errors":[{"message":"Field x is required"}]}').message).toBe(
      'Field x is required',
    );
    expect(cleanErrorMessage('{"message":"   ","detail":"the real one"}').message).toBe('the real one');
  });

  it('unwraps a long real-length wrapper (about 2 KB)', () => {
    const sentence = 'Access denied: the path is outside the allowed directories.';
    const raw = `The call to files__read failed: MCP error -32603: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: sentence, data: { trace: 'x'.repeat(2000) } },
    })}`;
    expect(raw.length).toBeGreaterThan(2000);
    expect(cleanErrorMessage(raw)).toEqual({ message: sentence, code: -32603 });
  });

  it('repeats on JSON inside the message, three levels deep, and stops there', () => {
    const level3 = JSON.stringify({ message: 'deepest' });
    const level2 = JSON.stringify({ error: { message: `Upstream said: ${level3}` } });
    const level1 = `MCP error -32603: ${JSON.stringify({ error: { code: -32603, message: level2 } })}`;
    expect(cleanErrorMessage(level1)).toEqual({ message: 'deepest', code: -32603 });

    const level4 = JSON.stringify({ message: 'too deep' });
    const three = JSON.stringify({ message: level4 });
    const two = JSON.stringify({ message: three });
    const one = JSON.stringify({ message: two });
    // Three unwraps, then the fourth level is shown as it is.
    expect(cleanErrorMessage(one).message).toBe(level4);
  });

  it('reads a JSON array: the first element that has a message', () => {
    expect(cleanErrorMessage('Errors: [{"code":1},{"message":"second one"}]').message).toBe('second one');
    expect(cleanErrorMessage('[]').message).toBe('[]');
  });

  it('returns text without JSON as it is, trimmed', () => {
    expect(cleanErrorMessage('  Timed out after 60 s and was cancelled.  ')).toEqual({
      message: 'Timed out after 60 s and was cancelled.',
    });
    expect(cleanErrorMessage('')).toEqual({ message: '' });
    expect(cleanErrorMessage('{"unrelated":true}')).toEqual({ message: '{"unrelated":true}' });
  });

  it('falls back to the original text for truncated JSON', () => {
    const raw = 'MCP error -32603: {"jsonrpc":"2.0","error":{"code":-32603,"message":"cut her';
    expect(cleanErrorMessage(raw)).toEqual({ message: raw, code: -32603 });
  });

  it('does not parse a body over the size limit', () => {
    const raw = JSON.stringify({ message: 'hidden', padding: 'p'.repeat(CLEAN_ERROR_PARSE_LIMIT) });
    expect(raw.length).toBeGreaterThan(CLEAN_ERROR_PARSE_LIMIT);
    expect(cleanErrorMessage(raw).message).toBe(raw);
  });

  it("never returns the parser's own message (it can quote the text: Sprint 6 B-1)", () => {
    const secret = 'ghp_FAKESECRETVALUE1234567890';
    const raw = `Error: {"token": ${secret}, "message": "x"}`;
    const result = cleanErrorMessage(raw);
    expect(result.message).toBe(raw.trim());
    expect(JSON.stringify(result)).not.toMatch(/Unexpected token|is not valid JSON|position/i);
    // The only place the secret appears is the original text itself, unchanged.
    expect(result.message.split(secret)).toHaveLength(2);
  });

  it('skips brackets inside strings when finding the JSON', () => {
    const raw = 'failed: {"message":"a } and ] inside","code":5}';
    expect(cleanErrorMessage(raw)).toEqual({ message: 'a } and ] inside', code: 5 });
  });
});
