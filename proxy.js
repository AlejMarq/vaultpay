// Convenience redirects only (Next.js 16 Proxy). This checks whether a cookie is PRESENT,
// not whether it is valid – it grants nothing. Every protected page and Server Action
// enforces access itself through the DAL (lib/server/session.js).

import { NextResponse } from 'next/server';

// Same values as SESSION_COOKIE / TWO_FACTOR_COOKIE in lib/server/auth-config.js (kept
// literal so the proxy bundle does not pull in Better Auth).
const SESSION_COOKIE = 'better-auth.session_token';
const TWO_FACTOR_COOKIE = 'better-auth.two_factor';

export function proxy(request) {
  const { pathname } = request.nextUrl;
  // /mfa/verify is reached with Better Auth's sign-in challenge cookie, not a session.
  const needed = pathname === '/mfa/verify' ? [SESSION_COOKIE, TWO_FACTOR_COOKIE] : [SESSION_COOKIE];
  if (!needed.some((name) => request.cookies.has(name))) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/mfa/:path*', '/wallet/:path*', '/support/:path*', '/send/:path*'],
};
