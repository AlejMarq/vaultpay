import { requireMfaVerifiedViewer } from '@/lib/server/session';

import { SessionKeepAlive, SignOutButton } from '../session-controls';
import { ViewerSummary } from '../viewer-summary';

// Protected: requires a session that completed MFA in this login. Password-only
// sessions are redirected to /mfa by requireMfaVerifiedViewer().
export const instant = false;

export const metadata = { title: 'Dashboard – VaultPay' };

export default async function DashboardPage() {
  const viewer = await requireMfaVerifiedViewer();
  return (
    <main className="page narrow">
      <SessionKeepAlive />
      <h1>Welcome, {viewer.name}</h1>
      <ViewerSummary viewer={viewer} />
      <SignOutButton />
    </main>
  );
}
