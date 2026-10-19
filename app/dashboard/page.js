import { redirect } from 'next/navigation';

import { landingPath } from '@/lib/server/dal';
import { requireMfaVerifiedViewer } from '@/lib/server/session';

// After sign-in: sends an MFA-verified session to its role's home (/wallet or /support),
// or to /access-denied. Password-only sessions are sent to /mfa by the guard.
export const instant = false;

export default async function DashboardPage() {
  redirect(landingPath(await requireMfaVerifiedViewer()));
}
