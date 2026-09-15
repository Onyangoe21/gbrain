/**
 * secret-scan performance regressions. The per-line scanner runs
 * SYNCHRONOUSLY over untrusted content (transcript ingest, `sources push`
 * blobs up to 25 MB, compiled context), so a pattern that is quadratic on a
 * long line is a denial-of-service lever, not a slow path. Pre-fix timings
 * for the inputs below were seconds (8000 credential-less redis URLs on one
 * JSON line: ~4 s; 160k chars of repeated `redis://:`: ~5.6 s; 5000 Bearer
 * tokens on one line: ~2.6 s vs 41 ms one-per-line). The thresholds sit
 * 10-50x above the fixed timings and 10-100x below the broken ones, so they
 * bind on a regression without flaking on a loaded CI box.
 *
 * Every credential-shaped value is synthetic and runtime-joined from >= 2
 * fragments; constant names keep scanner keywords away from the `=`.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';

function elapsedMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const OPAQUE = ['opaque', 'Token0123456789abcdefXYZ'].join('');
const USERINFO = ['alice-example', ':', 's3cr3t', '@'].join('');
const PG_URL_CREDS = ['postgres://', USERINFO].join('');
const PG_URL = PG_URL_CREDS + 'db.example.com:5432/app';

/** One minified JSON line of credential-less redis URLs (~248k chars). */
function redisJsonLine(extraElement = ''): string {
  const items = Array.from({ length: 8000 }, (_, i) => `{"u":"redis://localhost:${6379 + (i % 7)}"}`);
  if (extraElement) items.push(extraElement);
  return `[${items.join(',')}]`;
}

describe('db_url_credentials is linear on long lines', () => {
  test('(i) 8000 credential-less redis URLs on one JSON line: 0 findings, < 200ms', () => {
    const line = redisJsonLine();
    expect(line.length).toBeGreaterThan(160_000);
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('(i-b) the same line WITH an @ elsewhere (the cheap precheck passes): still 0 findings, < 200ms', () => {
    // An email address means the `@` precheck cannot skip the pattern — this
    // pins the bounded quantifiers on their own, not the precheck. It also
    // pins the FALSE POSITIVE the unbounded form had: the run from the last
    // URL's port through `"},{"owner":"ops` to the email's `@` was one bogus
    // db_url_credentials finding, because string delimiters were legal
    // password characters. Second element: the same shape through the
    // USER segment (`cache"},{"contact":"ops` + `:oncall@`).
    const line = redisJsonLine('{"owner":"ops@example.com"},{"u":"redis://cache"},{"contact":"ops:oncall@example.com"}');
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('(ii) 160k chars of repeated `redis://:` (no @): < 200ms', () => {
    const line = 'redis://:'.repeat(17_778);
    expect(line.length).toBeGreaterThan(160_000);
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  test('(ii-b) 160k chars of repeated `redis://:` followed by a single @: < 200ms', () => {
    const line = 'redis://:'.repeat(17_778) + '@';
    let findings: unknown[] = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings).toEqual([]);
    expect(ms).toBeLessThan(200);
  });
});

describe('preview + corpus redaction are linear in hits on one line', () => {
  const bearerLine = Array.from({ length: 5000 }, () => `Bearer ${OPAQUE}`).join(' ');

  test('(iii) 5000 Bearer tokens on one 190k line: scanText < 1500ms, one finding per occurrence', () => {
    expect(bearerLine.length).toBeGreaterThan(160_000);
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(bearerLine); });
    expect(findings.length).toBe(5000);
    expect(findings.every((f) => f.pattern === 'bearer')).toBe(true);
    expect(JSON.stringify(findings).includes(OPAQUE)).toBe(false);
    expect(ms).toBeLessThan(1500);
  });

  test('(iii-b) redactFindings over the same line: < 1500ms, no raw token survives', () => {
    let result = { text: '', redactions: [] as ReturnType<typeof scanText> };
    const ms = elapsedMs(() => { result = redactFindings(bearerLine); });
    expect(result.redactions.length).toBe(5000);
    expect(result.text.includes(OPAQUE)).toBe(false);
    expect(result.text.startsWith('Bearer <REDACTED:bearer> Bearer <REDACTED:bearer>')).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  test('(iii-c) hit count scales linearly: 20000 tokens on one 760k line < 1500ms', () => {
    // The first-wins overlap check and the preview window used to walk every
    // prior span per hit (O(hits²)): 5000 hits 305 ms, 10000 1.4 s, 20000
    // 5.4 s. Both are O(log hits) now.
    const line = Array.from({ length: 20_000 }, () => `Bearer ${OPAQUE}`).join(' ');
    let findings: ReturnType<typeof scanText> = [];
    const ms = elapsedMs(() => { findings = scanText(line); });
    expect(findings.length).toBe(20_000);
    expect(ms).toBeLessThan(1500);
  });
});

describe('the bounded connection-string pattern still fires on real credentials', () => {
  test('(iv) scheme://user:pass@host: value is exactly the credential span ending at @', () => {
    const findings = scanText(`DATABASE_URL=${PG_URL}`);
    expect(findings.map((f) => f.pattern)).toEqual(['db_url_credentials']);
    // The fingerprint is the sha256 of the span that ends at `@` — host/db
    // are not part of the value.
    const expected = createHash('sha256').update(PG_URL_CREDS).digest('hex').slice(0, 16);
    expect(findings[0]!.fingerprint).toBe(`sha256:${expected}`);
    const { text } = redactFindings(`DATABASE_URL=${PG_URL}`);
    expect(text).toBe('DATABASE_URL=<REDACTED:db_url_credentials>db.example.com:5432/app');
  });

  test('an empty user (redis-style `://:pw@`) still fires', () => {
    const url = ['redis://', ':', 'r3dis', '@cache.internal:6379'].join('');
    expect(scanText(url).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(redactFindings(url).text).toBe('<REDACTED:db_url_credentials>cache.internal:6379');
  });

  test('the password bound is exactly 256 chars (pinned so an edit is a visible edit)', () => {
    const pw256 = 'p4'.repeat(128);
    expect(pw256.length).toBe(256);
    const ok = ['mysql://', 'svc', ':', pw256, '@h/db'].join('');
    expect(scanText(ok).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    // 257 is the accepted miss: a JWT that long is still claimed by `jwt`;
    // an opaque password that long is not a realistic wire shape.
    const over = ['mysql://', 'svc', ':', pw256 + 'x', '@h/db'].join('');
    expect(scanText(over)).toEqual([]);
  });

  test('the RFC 3986 sub-delims, a `:` and a %XX escape are still legal password characters', () => {
    // `'` is the one sub-delim deliberately NOT accepted: it is a string
    // delimiter in minified JS/YAML, the same false-positive shape as `"`.
    const pw = ['p%40ss', '!$&()*+,;=~-._:x'].join('');
    const url = ['mysql://', 'svc', ':', pw, '@h/db'].join('');
    const findings = scanText(`u ${url}`);
    expect(findings.map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(redactFindings(url).text).toBe('<REDACTED:db_url_credentials>h/db');
  });

  test('the user bound is 128 chars; an unescaped `/` cannot be part of a URL password', () => {
    const user128 = 'u'.repeat(128);
    expect(scanText(['amqp://', user128, ':', 'p4ss', '@h'].join('')).map((f) => f.pattern)).toEqual(['db_url_credentials']);
    expect(scanText(['amqp://', user128 + 'u', ':', 'p4ss', '@h'].join(''))).toEqual([]);
    // `scheme://user:pa/th@host` is a path with an `@` in it, not a
    // credential — the old unbounded form matched it.
    expect(scanText(['mssql://', 'svc', ':', 'pa/th', '@h'].join(''))).toEqual([]);
  });
});
