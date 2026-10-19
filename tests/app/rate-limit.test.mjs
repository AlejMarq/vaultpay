import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clientKey, createLoginRateLimiter, normalizeEmail } from '../../lib/server/rate-limit.js';

const h = (xff) => new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('emails are normalized; impossible values become null', () => {
  assert.equal(normalizeEmail('  Alice@Example.TEST '), 'alice@example.test');
  assert.equal(normalizeEmail('ａｌｉｃｅ@example.test'), 'alice@example.test'); // full-width → NFKC
  for (const bad of [undefined, null, 42, '', 'no-at-sign', 'a b@c.d', `${'x'.repeat(250)}@e.st`]) assert.equal(normalizeEmail(bad), null, String(bad));
});

test('client key: only a single loopback address counts; forwarded values are never trusted', () => {
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.5.6.7', ' 127.0.0.1 ']) assert.equal(clientKey(h(ok)), 'loopback', ok);
  for (const bad of [undefined, '', 'garbage', '10.0.0.5', '203.0.113.9', '127.0.0.1, 10.0.0.1', '10.0.0.1, 127.0.0.1', '::ffff:10.0.0.1', '127.0.0.1:1234']) {
    assert.equal(clientKey(h(bad)), 'unverified', String(bad));
  }
  assert.equal(clientKey(undefined), 'unverified');
});

test('five failures for one client and account block that pair for the window', () => {
  const c = clock();
  const limiter = createLoginRateLimiter({}, c.now);
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.check('loopback', 'alice@example.test').allowed, true);
    limiter.recordFailure('loopback', 'alice@example.test');
  }
  const blocked = limiter.check('loopback', 'alice@example.test');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 15 * 60);
  assert.equal(limiter.check('loopback', 'bob@example.test').allowed, true, 'other accounts unaffected');
  c.advance(15 * 60 * 1000 + 1);
  assert.equal(limiter.check('loopback', 'alice@example.test').allowed, true, 'window slides');
});

test('changing the client key does not escape the per-account limit', () => {
  const limiter = createLoginRateLimiter({}, clock().now);
  for (let i = 0; i < 5; i++) limiter.recordFailure('loopback', 'alice@example.test');
  for (let i = 0; i < 5; i++) limiter.recordFailure('unverified', 'alice@example.test');
  assert.equal(limiter.check('loopback', 'alice@example.test').allowed, false);
  assert.equal(limiter.check('unverified', 'alice@example.test').allowed, false);
  assert.equal(limiter.check('someone-else', 'alice@example.test').allowed, false, 'per-email limit (10) applies to any client');
});

test('password spraying from one client is limited across accounts', () => {
  const limiter = createLoginRateLimiter({}, clock().now);
  for (let i = 0; i < 30; i++) limiter.recordFailure('loopback', `user${i}@example.test`);
  assert.equal(limiter.check('loopback', 'fresh@example.test').allowed, false);
});

test('unknown and malformed emails are limited like real ones', () => {
  const limiter = createLoginRateLimiter({}, clock().now);
  for (let i = 0; i < 5; i++) limiter.recordFailure('loopback', 'nobody@example.test');
  assert.equal(limiter.check('loopback', 'nobody@example.test').allowed, false);
  for (let i = 0; i < 5; i++) limiter.recordFailure('loopback', null);
  assert.equal(limiter.check('loopback', null).allowed, false);
});

test('success clears the account\'s failures', () => {
  const limiter = createLoginRateLimiter({}, clock().now);
  for (let i = 0; i < 4; i++) limiter.recordFailure('loopback', 'alice@example.test');
  limiter.recordSuccess('loopback', 'alice@example.test');
  for (let i = 0; i < 4; i++) limiter.recordFailure('loopback', 'alice@example.test');
  assert.equal(limiter.check('loopback', 'alice@example.test').allowed, true);
});

test('memory stays bounded', () => {
  const c = clock();
  const limiter = createLoginRateLimiter({ maxKeys: 100 }, c.now);
  for (let i = 0; i < 1000; i++) limiter.recordFailure(`client${i}`, `user${i}@example.test`);
  assert.ok(limiter.size <= 100, `size ${limiter.size}`);
  c.advance(16 * 60 * 1000);
  limiter.recordFailure('loopback', 'x@example.test');
  assert.ok(limiter.size <= 100);
});
