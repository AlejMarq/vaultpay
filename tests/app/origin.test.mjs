import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSameOrigin, CrossOriginRequest } from '../../lib/server/origin.js';

const h = (values) => new Headers(values);

test('same-origin requests pass', () => {
  assertSameOrigin(h({ origin: 'http://localhost:3000', host: 'localhost:3000' }));
  assertSameOrigin(h({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }));
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
