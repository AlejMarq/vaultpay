'use client';

import { useActionState } from 'react';

import { login } from './actions';

const initialState = { error: null, email: '' };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);
  return (
    <form action={formAction} className="card stack" noValidate>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="username" required maxLength={254} defaultValue={state.email} />
      </label>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required maxLength={128} />
      </label>
      {state.error ? <p className="error" role="alert">{state.error}</p> : null}
      <button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
