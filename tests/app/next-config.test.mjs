import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import nextConfig from '../../next.config.mjs';

test('security headers apply to every path', async () => {
  const rules = await nextConfig.headers();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, '/:path*');
  const headers = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
  assert.equal(headers['Content-Security-Policy'], "frame-ancestors 'none'");
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /microphone=\(\)/);
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('X-Powered-By is disabled and Cache Components stays on', () => {
  assert.equal(nextConfig.poweredByHeader, false);
  assert.equal(nextConfig.cacheComponents, true);
});

test('dev and start only listen on 127.0.0.1', () => {
  const { scripts } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(scripts.dev, 'next dev --hostname 127.0.0.1');
  assert.equal(scripts.start, 'next start --hostname 127.0.0.1');
});
