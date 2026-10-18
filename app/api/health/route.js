// TEMPORARY Phase 0 check: proves Next.js 16 can load the better-sqlite3 native module
// inside a server route. We replace this in Step 2 with a real health check.
import Database from 'better-sqlite3';
import { connection } from 'next/server';

// Cache Components is enabled, so `export const dynamic` is not available. A synchronous
// better-sqlite3 query would otherwise finish during prerendering and the build would
// freeze the result; connection() makes the check run on every request.
export async function GET() {
  await connection();
  const db = new Database(':memory:');
  const ok = db.prepare('SELECT 1 AS one').get().one === 1;
  db.close();
  return Response.json({ status: ok ? 'ok' : 'error' });
}
