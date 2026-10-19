import { redirect } from 'next/navigation';

import { landingPath } from '@/lib/server/dal';
import { getViewer } from '@/lib/server/session';

import { LoginForm } from './login-form';

// Reads the session before rendering, so the page may block (no static shell).
export const instant = false;

export const metadata = { title: 'Sign in – VaultPay' };

export default async function LoginPage() {
  const viewer = await getViewer();
  if (viewer) redirect(landingPath(viewer));
  return (
    <main className="page narrow">
      <h1>Sign in to VaultPay</h1>
      <p className="muted">Localhost demonstration. Demo logins are listed in docs/SETUP.md – never use them for a real account.</p>
      <LoginForm />
    </main>
  );
}
