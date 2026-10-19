'use server';

// Two-factor Server Actions. Each one checks the same-origin rule first (Next.js rejects
// a foreign Origin; assertSameOrigin also refuses a missing one), then resolves the
// session again on the server – nothing in the submitted form or the previous state is
// trusted for an access decision. Session cookies are written by Better Auth's
// nextCookies plugin.

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/server/auth';
import { confirmEnrollment, mfaRateLimiter, startEnrollment, totpReplayGuard, verifyChallenge } from '@/lib/server/mfa';
import { assertSameOrigin } from '@/lib/server/origin';
import { getViewer, readOnlyIdentityDb } from '@/lib/server/session';

// The previous state only carries what the page displays (QR code, setup key).
const display = (state) => ({ qrDataUrl: state?.qrDataUrl ?? null, manualKey: state?.manualKey ?? null });

export async function enrollmentAction(previousState, formData) {
  const requestHeaders = await headers();
  assertSameOrigin(requestHeaders);
  const viewer = await getViewer();
  if (!viewer) redirect('/login');
  if (viewer.mfa.verified) redirect('/dashboard');

  const auth = await getAuth();
  const limiter = mfaRateLimiter();

  if (formData.get('step') === 'confirm') {
    const result = await confirmEnrollment({ auth, viewer, headers: requestHeaders, code: formData.get('code'), limiter, replayGuard: await totpReplayGuard() });
    if (!result.ok) return { step: 'confirm', ...display(previousState), error: result.error };
    // Better Auth has replaced the session with an MFA-verified one. The backup codes are
    // in this one response only; no page or action can show them again.
    return { step: 'done', backupCodes: result.backupCodes, error: null };
  }

  const result = await startEnrollment({ auth, viewer, headers: requestHeaders, password: formData.get('password'), limiter });
  if (!result.ok) return { step: 'password', error: result.error };
  return { step: 'confirm', qrDataUrl: result.qrDataUrl, manualKey: result.manualKey, error: null };
}

export async function challengeAction(_previousState, formData) {
  const requestHeaders = await headers();
  assertSameOrigin(requestHeaders);
  const method = formData.get('method') === 'backup' ? 'backup' : 'totp';
  const result = await verifyChallenge({
    auth: await getAuth(),
    identityDb: readOnlyIdentityDb(),
    headers: requestHeaders,
    method,
    code: formData.get('code'),
    limiter: mfaRateLimiter(),
    replayGuard: await totpReplayGuard(),
  });
  if (result.ok) redirect('/dashboard');
  return { method, error: result.error, restart: Boolean(result.restart) };
}
