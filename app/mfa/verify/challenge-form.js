'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { challengeAction } from '../actions';

const initialState = { method: 'totp', error: null, restart: false };

export function ChallengeForm() {
  const [state, formAction, pending] = useActionState(challengeAction, initialState);
  return (
    <>
      <form action={formAction} className="card stack">
        <input type="hidden" name="method" value="totp" />
        <label className="field">
          <span>6-digit code from your authenticator app</span>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
        </label>
        {state.error && state.method === 'totp' ? <p className="error" role="alert">{state.error}</p> : null}
        <button type="submit" disabled={pending}>Verify</button>
      </form>
      <form action={formAction} className="card stack">
        <input type="hidden" name="method" value="backup" />
        <label className="field">
          <span>Or use a one-time backup code</span>
          <input name="code" autoComplete="off" maxLength={32} required />
        </label>
        {state.error && state.method === 'backup' ? <p className="error" role="alert">{state.error}</p> : null}
        <button type="submit" className="secondary" disabled={pending}>Use backup code</button>
      </form>
      {state.restart ? <p><Link href="/login">Sign in again</Link></p> : null}
    </>
  );
}
