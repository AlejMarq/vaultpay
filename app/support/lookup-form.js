'use client';

import { useActionState } from 'react';

import { KYC_LABELS, TransferTable } from '../transfer-table';
import { lookupAction } from './actions';

const initialState = { searched: '', result: null };

export function LookupForm() {
  const [state, formAction, pending] = useActionState(lookupAction, initialState);
  const { result } = state;
  return (
    <>
      <form action={formAction} className="card stack">
        <label className="field">
          <span>Customer email</span>
          <input name="email" type="email" required maxLength={254} defaultValue={state.searched} autoComplete="off" />
        </label>
        <button type="submit" disabled={pending}>{pending ? 'Searching…' : 'Look up customer'}</button>
        <p className="muted">Every search and view is recorded in the audit trail.</p>
      </form>

      {result && !result.found ? <p className="notice" role="status">No customer found for that email.</p> : null}

      {result?.found ? (
        <section className="stack">
          <dl className="card summary">
            <dt>Customer</dt>
            <dd>{result.customer.fullName} (<code>{result.customer.customerId}</code>)</dd>
            <dt>Email</dt>
            <dd>{result.customer.maskedEmail}</dd>
            <dt>Phone</dt>
            <dd>{result.customer.maskedPhone ?? '—'}</dd>
            <dt>Customer status</dt>
            <dd>{result.customer.status}</dd>
            <dt>KYC status</dt>
            <dd>{KYC_LABELS[result.customer.kycStatus] ?? result.customer.kycStatus}</dd>
            <dt>Wallet</dt>
            <dd>{result.wallet ? <><code>{result.wallet.walletId}</code> ({result.wallet.status})</> : 'No wallet'}</dd>
          </dl>
          <h2>Transfers</h2>
          <TransferTable transfers={result.transfers} />
        </section>
      ) : null}
    </>
  );
}
