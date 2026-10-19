// Health check: reports only "ok" or "unavailable". Problem codes are logged on the
// server, never returned, so the response reveals nothing about files or configuration.
import { headers } from 'next/headers';
import { connection } from 'next/server';

import { getAuth } from '@/lib/server/auth';
import { checkHealth } from '@/lib/server/health';
import { isLocalHost } from '@/lib/server/origin';

const json = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET() {
  // Cache Components: run on every request, never at build time.
  await connection();
  // DNS rebinding: answer only requests addressed to localhost.
  if (!isLocalHost((await headers()).get('host'))) return json({ status: 'forbidden' }, 403);
  const { ok, problems } = await checkHealth({ checkAuth: getAuth });
  if (!ok) console.error(`[health] unavailable: ${problems.join(', ')}`);
  return json({ status: ok ? 'ok' : 'unavailable' }, ok ? 200 : 503);
}
