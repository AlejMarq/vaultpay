import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertLocalHost, assertSameOrigin, CrossOriginRequest, isLocalHost } from '../../lib/server/origin.js';

const h = (values) => new Headers(values);

test('same-origin requests pass', () => {
  assertSameOrigin(h({ origin: 'http://localhost:3000', host: 'localhost:3000' }));
  assertSameOrigin(h({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }));
});

test('DNS rebinding: only localhost Host headers are accepted, even when Origin matches', () => {
  for (const ok of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'localhost', 'LOCALHOST:3999', '127.0.0.1:3999']) {
    assert.equal(isLocalHost(ok), true, ok);
    assertLocalHost(h({ host: ok }));
  }
  for (const bad of ['evil.example:3000', 'localhost.evil.example:3000', '127.0.0.1.nip.io:3000', '192.168.1.43:3000', '127.0.0.2:3000',
    'user@localhost:3000', 'localhost:3000/path', '', undefined, null]) {
    assert.equal(isLocalHost(bad), false, String(bad));
  }
  // A rebinding attacker's request is perfectly "same-origin" – and still refused.
  assert.throws(() => assertSameOrigin(h({ origin: 'http://evil.example:3000', host: 'evil.example:3000' })), CrossOriginRequest);
  assert.throws(() => assertLocalHost(h({})), CrossOriginRequest);
});

test('missing, foreign, malformed or "null" origins are refused', () => {
  for (const values of [
    { host: 'localhost:3000' },
    { origin: 'http://evil.example', host: 'localhost:3000' },
    { origin: 'http://localhost:3001', host: 'localhost:3000' },
    { origin: 'http://127.0.0.1:3000', host: 'localhost:3000' },
    { origin: 'null', host: 'localhost:3000' },
    { origin: 'not a url', host: 'localhost:3000' },
    { origin: 'file://localhost:3000', host: 'localhost:3000' },
    { origin: 'http://localhost:3000' },
  ]) {
    assert.throws(() => assertSameOrigin(h(values)), CrossOriginRequest, JSON.stringify(values));
  }
});
