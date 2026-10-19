import { requireSupport } from '@/lib/server/session';

import { SessionKeepAlive, SignOutButton } from '../session-controls';
import { LookupForm } from './lookup-form';

// Read-only support area. requireSupport(): MFA completed in this session, an active
// support_readonly ops user. The lookup action checks this again on every request.
export const instant = false;

export const metadata = { title: 'Support – VaultPay' };

export default async function SupportPage() {
  const viewer = await requireSupport();
  return (
    <main className="page">
      <SessionKeepAlive />
      <header className="topbar">
        <h1>Customer support (read-only)</h1>
        <SignOutButton />
      </header>
      <p className="muted">Signed in as {viewer.ops.fullName} – {viewer.ops.role}. You can view customer records but not change them.</p>
      <LookupForm />
    </main>
  );
}
