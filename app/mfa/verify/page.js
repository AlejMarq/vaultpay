import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { TWO_FACTOR_COOKIE } from '@/lib/server/auth-config';
import { landingPath } from '@/lib/server/dal';
import { getViewer } from '@/lib/server/session';

import { ChallengeForm } from './challenge-form';

// Second step of signing in for an account with TOTP. There is no session yet – only
// Better Auth's short-lived challenge cookie, which Better Auth itself validates.
export const instant = false;

export const metadata = { title: 'Two-factor verification – VaultPay' };

export default async function MfaVerifyPage() {
  const viewer = await getViewer();
  if (viewer) redirect(landingPath(viewer));
  if (!(await cookies()).has(TWO_FACTOR_COOKIE)) redirect('/login');
  return (
    <main className="page narrow">
      <h1>Two-factor verification</h1>
      <p className="muted">Enter the code from your authenticator app to finish signing in.</p>
      <ChallengeForm />
    </main>
  );
}
