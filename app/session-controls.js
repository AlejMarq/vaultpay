'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { keepAlive, logout } from './session-actions';

let lastPing = 0;

/** On navigation, tells the server the user is active (throttled to once a minute). */
export function SessionKeepAlive() {
  const pathname = usePathname();
  useEffect(() => {
    if (Date.now() - lastPing < 60_000) return;
    lastPing = Date.now();
    keepAlive().catch(() => {});
  }, [pathname]);
  return null;
}

export function SignOutButton() {
  return (
    <form action={logout}>
      <button type="submit" className="secondary">Sign out</button>
    </form>
  );
}
