'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { enrollmentAction } from '../actions';

const initialState = { step: 'password', error: null };

// `enabled`: the current session has completed MFA (decided on the server).
export function EnrollmentForm({ enabled }) {
  const [state, formAction, pending] = useActionState(enrollmentAction, initialState);

  if (state.step !== 'done' && enabled) {
    return (
      <section className="card stack">
        <p>Two-factor authentication is already set up for this account.</p>
        <Link className="button" href="/dashboard">Go to your dashboard</Link>
      </section>
    );
  }

  if (state.step === 'done') {
    return (
      <section className="card stack">
        <h2>Two-factor authentication is on</h2>
        <p>
          Save these backup codes somewhere safe. Each one works <strong>once</strong>, if you
          lose access to your authenticator app. They are shown only now.
        </p>
        <ul className="codes">
          {state.backupCodes.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
        <Link className="button" href="/dashboard">Continue to your dashboard</Link>
      </section>
    );
  }

  if (state.step === 'confirm') {
    return (
      <form action={formAction} className="card stack">
        <input type="hidden" name="step" value="confirm" />
        <h2>Step 2 – scan and confirm</h2>
        <p>Scan this code with an authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password).</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- inline data: URL generated on the server; nothing for next/image to optimize */}
        {state.qrDataUrl ? <img className="qr" src={state.qrDataUrl} alt="QR code for your authenticator app" width={240} height={240} /> : null}
        <p className="muted">Or enter this setup key manually:</p>
        <p><code className="key">{state.manualKey}</code></p>
        <label className="field">
          <span>6-digit code from the app</span>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
        </label>
        {state.error ? <p className="error" role="alert">{state.error}</p> : null}
        <button type="submit" disabled={pending}>{pending ? 'Checking…' : 'Turn on two-factor'}</button>
      </form>
    );
  }

  return (
    <form action={formAction} className="card stack">
      <input type="hidden" name="step" value="password" />
      <h2>Step 1 – confirm your password</h2>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required maxLength={128} />
      </label>
      {state.error ? <p className="error" role="alert">{state.error}</p> : null}
      <button type="submit" disabled={pending}>{pending ? 'Checking…' : 'Continue'}</button>
    </form>
  );
}
