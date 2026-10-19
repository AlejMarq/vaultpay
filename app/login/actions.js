'use server';

// Login Server Action. CSRF protection: Next.js rejects a foreign Origin, and
// assertSameOrigin also refuses a missing one. Better Auth's own Origin check does not
// apply to direct auth.api calls. Session cookies are written by Better Auth's
// nextCookies plugin.

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/server/auth';
import { attemptLogin, loginRateLimiter } from '@/lib/server/login';
import { assertSameOrigin } from '@/lib/server/origin';

export async function login(_previousState, formData) {
  const requestHeaders = await headers();
  assertSameOrigin(requestHeaders);
  const email = formData.get('email');
  const result = await attemptLogin({
    auth: await getAuth(),
    limiter: loginRateLimiter(),
    headers: requestHeaders,
    email,
    password: formData.get('password'),
  });
  if (!result.ok) {
    return { error: result.error, email: typeof email === 'string' ? email.slice(0, 254) : '' };
  }
  // TOTP enrolled: Better Auth created no session, only a short-lived challenge cookie.
  if (result.twoFactor) redirect('/mfa/verify');
  // Not enrolled yet: a password-only session, which can only reach /mfa (enrollment).
  redirect('/mfa');
}
