'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { formatUsd, STATUS_LABELS } from '../transfer-table';
import { transferAction } from './actions';

const MESSAGES = {
  invalid_amount: 'Enter an amount in US dollars, for example 12.50.',
  amount_out_of_range: 'The amount must be between $0.01 and $1,000.00.',
  invalid_recipient: 'That recipient cannot receive transfers. Check the email address.',
  self_transfer: 'You cannot send money to yourself.',
  source_wallet_changed: 'Your wallet changed. Please start again.',
  invalid_request: 'This request could not be processed. Please start again.',
  idempotency_conflict: 'This transfer request was already used with different details. Please start again.',
  insufficient_funds: 'Your available balance is not enough for this transfer.',
  banking_unavailable: 'We cannot check your balance right now, so the transfer was not sent. Please try again later.',
  unavailable: 'The transfer could not be submitted right now. Nothing was sent. Please try again.',
  rate_limited: 'Too many transfer attempts. Nothing was sent. Please wait a minute and try again.',
  backlog_full: 'Too many transfers are still being processed. Nothing was sent. Please try again later.',
};

const initialState = { step: 'edit', values: { recipient: '', amount: '' } };

function ErrorMessage({ code }) {
  return code ? <p className="error" role="alert" data-error={code}>{MESSAGES[code] ?? MESSAGES.unavailable}</p> : null;
}

export function TransferForm({ walletId }) {
  const [state, formAction, pending] = useActionState(transferAction, initialState);

  if (state.step === 'done') {
    const t = state.transfer;
    return (
      <section className="card stack" data-transfer-step="done" data-transfer-status={t.status}>
        <h2>Transfer submitted</h2>
        <p>
          {formatUsd(t.amountCents)} to {t.recipient} – <strong>{STATUS_LABELS[t.status] ?? t.status}</strong>.
        </p>
        <p className="notice">The transfer is not complete yet: it is screened for fraud and then settled by the bank. Its status is shown in your wallet.</p>
        <p className="muted">Reference <code>{t.transferId}</code></p>
        <form action={formAction}>
          <input type="hidden" name="intent" value="new" />
          <button type="submit" className="secondary">Send another transfer</button>
        </form>
        <p><Link href="/wallet">Back to your wallet</Link></p>
      </section>
    );
  }

  if (state.step === 'confirm') {
    const r = state.review;
    return (
      <section className="card stack" data-transfer-step="confirm">
        <h2>Confirm your transfer</h2>
        <dl className="summary">
          <dt>From</dt>
          <dd><code>{r.sourceWalletId}</code></dd>
          <dt>To</dt>
          <dd>{r.recipient}</dd>
          <dt>Amount</dt>
          <dd><strong>{formatUsd(r.amountCents)}</strong> {r.currency}</dd>
        </dl>
        <ErrorMessage code={state.error} />
        <form action={formAction} className="stack">
          <input type="hidden" name="intent" value="confirm" />
          <input type="hidden" name="recipient" value={r.recipient} />
          <input type="hidden" name="amount" value={r.amount} />
          <input type="hidden" name="sourceWalletId" value={r.sourceWalletId} />
          <input type="hidden" name="idempotencyKey" value={r.idempotencyKey} />
          <button type="submit" disabled={pending}>{pending ? 'Sending…' : 'Confirm and send'}</button>
        </form>
        <form action={formAction}>
          <input type="hidden" name="intent" value="edit" />
          <input type="hidden" name="recipient" value={r.recipient} />
          <input type="hidden" name="amount" value={r.amount} />
          <button type="submit" className="secondary" disabled={pending}>Change details</button>
        </form>
      </section>
    );
  }

  return (
    <form action={formAction} className="card stack" data-transfer-step="edit" key={`${state.values?.recipient}|${state.values?.amount}|${state.error ?? ''}`}>
      <p>From wallet <code>{walletId}</code></p>
      <input type="hidden" name="intent" value="review" />
      <label className="field">
        <span>Recipient email</span>
        <input name="recipient" type="email" required maxLength={254} defaultValue={state.values?.recipient} autoComplete="off" />
      </label>
      <label className="field">
        <span>Amount (USD)</span>
        <input name="amount" type="text" inputMode="decimal" required maxLength={12} pattern="\$?[0-9]+(\.[0-9]{1,2})?" placeholder="0.00" defaultValue={state.values?.amount} autoComplete="off" />
      </label>
      <ErrorMessage code={state.error} />
      <button type="submit" disabled={pending}>Review transfer</button>
      <p className="muted">Up to $1,000.00 per transfer. You will see a confirmation before anything is sent.</p>
    </form>
  );
}
