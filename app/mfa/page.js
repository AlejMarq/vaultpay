import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireViewer } from '@/lib/server/session';

import { SessionKeepAlive, SignOutButton } from '../session-controls';

// Landing page for a password-only session. Before MFA it shows only who is signed in
// and what to do next – no KYC, wallet or other account data.
export const instant = false;

export const metadata = { title: 'Two-factor required – VaultPay' };

export default async function MfaPendingPage() {
  const viewer = await requireViewer();
  if (viewer.mfa.verified) redirect('/dashboard');
  return (
    <main className="page narrow">
      <SessionKeepAlive />
      <h1>Two-factor authentication required</h1>
      <p>Signed in with your password as <strong>{viewer.name}</strong> ({viewer.email}).</p>
      {viewer.mfa.enrolled ? (
        <p>
          This account already uses two-factor authentication, but this session has not been
          verified. Sign out, then sign in again and enter the code from your authenticator app.
        </p>
      ) : (
        <>
          <p>VaultPay requires a code from an authenticator app every time you sign in. Set it up now to continue.</p>
          <Link className="button" href="/mfa/setup">Set up two-factor authentication</Link>
        </>
      )}
      <SignOutButton />
    </main>
  );
}
