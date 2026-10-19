import { redirect } from 'next/navigation';

import { landingPath } from '@/lib/server/dal';
import { getViewer } from '@/lib/server/session';

export const instant = false;

// "/" sends everyone to the right place: /login, /mfa or /dashboard.
export default async function Home() {
  redirect(landingPath(await getViewer()));
}
