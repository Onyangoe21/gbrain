/**
 * Format-based detector edges not pinned by test/secret-scan.test.ts: the
 * remaining connection-string schemes, the AKIA arm's new hard right edge,
 * and the bearer catch-all's length floor + left boundary. Every value is
 * synthetic and runtime-joined from >= 2 fragments; constant names keep
 * scanner keywords away from the `=`.
 */
import { describe, expect, test } from 'bun:test';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';

const USERINFO = ['dbuser', ':', 'p4ssw0rd', '@'].join('');
const AKIA_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const OPAQUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');

describe('db_url_credentials — every listed scheme', () => {
  for (const scheme of ['postgresql', 'mysql', 'mongodb', 'rediss', 'amqp', 'mssql']) {
    test(`${scheme}:// with inline credentials fires once and keeps the host`, () => {
      const url = `${scheme}://${USERINFO}host.internal/db`;
      expect(scanText(`url ${url}`).map((f) => f.pattern)).toEqual(['db_url_credentials']);
      const { text } = redactFindings(url);
      expect(text).toBe('<REDACTED:db_url_credentials>host.internal/db');
      expect(text.includes('p4ssw0rd')).toBe(false);
    });
  }

  test('a database URL with an EMPTY password (user, trailing colon) does not fire', () => {
    expect(scanText('postgres://dbuser:@host.internal/db')).toEqual([]);
  });
});

describe('aws_access_key — AKIA keeps firing, now with a hard right edge', () => {
  test('bare AKIA id fires', () => {
    expect(scanText(`aws ${AKIA_ID}`).map((f) => f.pattern)).toEqual(['aws_access_key']);
  });

  test('AKIA followed by more alphanumerics is an identifier, not a key id', () => {
    expect(scanText(`${AKIA_ID}XYZ`)).toEqual([]);
    expect(scanText(`${AKIA_ID}1`)).toEqual([]);
  });
});

describe('bearer catch-all — floor and left boundary', () => {
  test('a token under 20 chars does not reach the bearer floor', () => {
    expect(scanText('Authorization: Bearer abcdef1234')).toEqual([]);
  });

  test('the keyword needs a non-word left boundary; punctuation counts as one', () => {
    expect(scanText(`xBearer ${OPAQUE}`)).toEqual([]);
    expect(scanText(`(Bearer ${OPAQUE})`).map((f) => f.pattern)).toEqual(['bearer']);
  });

  test('the redaction keeps the header keyword and drops only the token', () => {
    const { text } = redactFindings(`(Bearer ${OPAQUE})`);
    expect(text).toBe('(Bearer <REDACTED:bearer>)');
  });
});
