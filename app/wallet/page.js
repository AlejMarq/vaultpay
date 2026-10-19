import Link from 'next/link';

import { requireCustomer, readOnlyIdentityDb, readOnlyTransactionDb } from '@/lib/server/session';
import { getWalletOverview } from '@/lib/server/wallet';

import { SessionKeepAlive, SignOutButton } from '../session-controls';
import { KYC_LABELS, TransferTable } from '../transfer-table';

// Customer area (read-only). requireCustomer(): MFA completed in this session, an active
// customer – checked on every request, together with the data read below.
export const instant = false;

export const metadata = { title: 'Your wallet – VaultPay' };

export default async function WalletPage() {
  const viewer = await requireCustomer();
  const overview = getWalletOverview(viewer, { identityDb: readOnlyIdentityDb(), transactionDb: readOnlyTransactionDb() });
  return (
    <main className="page">
      <SessionKeepAlive />
      <header className="topbar">
        <h1>Your wallet</h1>
        <SignOutButton />
      </header>
      <dl className="card summary">
        <dt>Name</dt>
        <dd>{overview.name}</dd>
        <dt>Email</dt>
        <dd>{overview.email}</dd>
        <dt>KYC status</dt>
        <dd>{KYC_LABELS[overview.kycStatus] ?? overview.kycStatus}</dd>
        <dt>Wallet</dt>
        <dd>{overview.wallet ? <><code>{overview.wallet.walletId}</code> ({overview.wallet.status})</> : 'No wallet'}</dd>
        <dt>Balance</dt>
        <dd className="notice">Balance retrieval will be available after Core Banking Integration (CBI) is connected.</dd>
      </dl>
      {overview.kycStatus !== 'approved' ? (
        <p className="notice">Your identity verification is not complete yet. Sending money will require approved KYC.</p>
      ) : null}
      <nav>
        <Link className="button" href="/send">Send money</Link>
      </nav>
      <section className="stack">
        <h2>Recent transfers</h2>
        <TransferTable transfers={overview.transfers} />
      </section>
    </main>
  );
}
