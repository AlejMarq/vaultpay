import { redirect } from 'next/navigation';

import { requireViewer } from '@/lib/server/session';

import { SessionKeepAlive, SignOutButton } from '../../session-controls';
import { EnrollmentForm } from './enrollment-form';

// First-login TOTP enrollment for a password-only session of an account without TOTP.
export const instant = false;

export const metadata = { title: 'Set up two-factor – VaultPay' };

export default async function MfaSetupPage() {
  const viewer = await requireViewer();
  // A password-only session of an account that already has TOTP must sign in again.
  if (viewer.mfa.enrolled && !viewer.mfa.verified) redirect('/mfa');
  // No redirect for a verified session: the enrollment action's own response re-renders
  // this page with the new session, and the form must stay to show the backup codes once.
  return (
    <main className="page narrow">
      <SessionKeepAlive />
      <h1>Set up two-factor authentication</h1>
      <p className="muted">Signed in as {viewer.email}</p>
      <EnrollmentForm enabled={viewer.mfa.verified} />
      <SignOutButton />
    </main>
  );
}
