import Link from 'next/link';

import { INELIGIBLE, readEligibility } from '@/lib/server/eligibility';
import { readOnlyIdentityDb, requireCustomer } from '@/lib/server/session';

import { SessionKeepAlive, SignOutButton } from '../session-controls';
import { TransferForm } from './transfer-form';

// Send money (Step 5). requireCustomer(): MFA completed in this session and an active
// customer (support users and suspended customers never get here). The eligibility rules
// are then read from the database on this request; only an eligible customer gets the
// form. The Server Action (./actions.js) checks everything again – showing the form
// grants nothing.
export const instant = false;

export const metadata = { title: 'Send money – VaultPay' };

const EXPLANATIONS = {
  [INELIGIBLE.kycPending]: 'Your identity verification (KYC) is still pending. You can send money once it has been approved.',
  [INELIGIBLE.kycRejected]: 'Your identity verification (KYC) was not approved, so sending money is not available. Please contact VaultPay support.',
  [INELIGIBLE.kycNotStarted]: 'You have not completed identity verification (KYC) yet. Sending money requires approved KYC.',
  [INELIGIBLE.walletFrozen]: 'Your wallet is frozen, so sending money is not available. Please contact VaultPay support.',
  [INELIGIBLE.walletClosed]: 'Your wallet is closed, so sending money is not available.',
  [INELIGIBLE.noWallet]: 'You do not have an active wallet, so sending money is not available.',
  [INELIGIBLE.customerInactive]: 'Your account is not active, so sending money is not available.',
};

export default async function SendPage() {
  const viewer = await requireCustomer();
  const eligibility = readEligibility(readOnlyIdentityDb(), viewer.customer.customerId);
  return (
    <main className="page narrow">
      <SessionKeepAlive />
      <header className="topbar">
        <h1>Send money</h1>
        <SignOutButton />
      </header>
      {eligibility.eligible ? (
        <section className="stack" data-eligibility="eligible">
          <TransferForm walletId={eligibility.walletId} />
        </section>
      ) : (
        <section className="card stack" data-eligibility="ineligible">
          <h2>Sending money is unavailable</h2>
          <ul className="stack">
            {eligibility.reasons.map((r) => <li key={r} data-reason={r}>{EXPLANATIONS[r] ?? 'Sending money is not available for this account.'}</li>)}
          </ul>
        </section>
      )}
      <p><Link href="/wallet">Back to your wallet</Link></p>
    </main>
  );
}
