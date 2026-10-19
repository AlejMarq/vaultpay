// Health check: reports only "ok" or "unavailable". Problem codes are logged on the
// server, never returned, so the response reveals nothing about files or configuration.
import { connection } from 'next/server';

import { getAuth } from '@/lib/server/auth';
import { checkHealth } from '@/lib/server/health';

export async function GET() {
  // Cache Components: run on every request, never at build time.
  await connection();
  const { ok, problems } = await checkHealth({ checkAuth: getAuth });
  if (!ok) console.error(`[health] unavailable: ${problems.join(', ')}`);
  return Response.json(
    { status: ok ? 'ok' : 'unavailable' },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
