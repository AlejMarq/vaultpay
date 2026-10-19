'use server';

// Session Server Actions shared by signed-in pages (same-origin POST only, like login).

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/server/auth';
import { SESSION_COOKIE } from '@/lib/server/auth-config';
import { assertSameOrigin } from '@/lib/server/origin';
import { getViewer } from '@/lib/server/session';

const TWO_FACTOR_COOKIE = 'better-auth.two_factor';

/** Revokes the session in the database and clears the browser's cookies. */
export async function logout() {
  const requestHeaders = await headers();
  assertSameOrigin(requestHeaders);
  const auth = await getAuth();
  try {
    await auth.api.signOut({ headers: requestHeaders });
  } catch {
    // Already expired or revoked – still clear the cookies below.
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(TWO_FACTOR_COOKIE);
  redirect('/login');
}

/**
 * Counts a page view as activity: lets Better Auth extend the session (at most every
 * 5 minutes) here, where the cookie can be rewritten together with the database row.
 */
export async function keepAlive() {
  assertSameOrigin(await headers());
  await getViewer({ refresh: true });
}
