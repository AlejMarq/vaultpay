// Shared helpers for database tests: each test gets its own temporary data directory
// outside the project, removed when the test finishes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDatabase, openDatabase } from '../../lib/server/db/index.js';

// node:test runs t.after hooks in registration order; cleanups here run last-in-first-out
// instead, so connections close before their folder is deleted (Windows refuses to delete
// an open database with EBUSY).
const cleanups = new WeakMap();

export function onCleanup(t, fn) {
  if (!cleanups.has(t)) {
    const stack = [];
    cleanups.set(t, stack);
    t.after(() => {
      while (stack.length > 0) stack.pop()();
    });
  }
  cleanups.get(t).push(fn);
}

export function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-test-'));
  onCleanup(t, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// Creates a fresh database in a temp data dir and returns an open, writable connection.
export function freshDb(t, name) {
  const dataDir = tempDataDir(t);
  createDatabase(name, { dataDir });
  const db = openDatabase(name, { dataDir });
  onCleanup(t, () => db.close());
  return { db, dataDir };
}

// Stand-in for Better Auth's "user" table (setup creates the real one in a later
// section). Only the primary key matters for the identity schema's foreign keys.
export function addAuthUserStub(db, ...ids) {
  db.exec('CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO "user" (id) VALUES (?)');
  for (const id of ids) insert.run(id);
}

// Asserts that `fn` throws a DbError with the given code.
export function assertDbError(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'DbError', `expected DbError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

// Asserts that a SQL statement is rejected by SQLite (constraint or trigger),
// optionally matching part of the error message.
export function assertRejected(fn, messagePart) {
  assert.throws(fn, (err) => {
    assert.match(err.code ?? '', /^SQLITE_/, `expected a SQLite error, got: ${err.message}`);
    if (messagePart) assert.ok(err.message.includes(messagePart), `expected "${messagePart}" in: ${err.message}`);
    return true;
  });
}

export const T0 = 1_760_000_000_000; // fixed test clock (ms)
