// Read-only summary of who is signed in, resolved by the DAL (no caching).

const KYC_LABELS = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected', not_started: 'Not started' };

export function ViewerSummary({ viewer }) {
  return (
    <dl className="card summary">
      <dt>Signed in as</dt>
      <dd>{viewer.name} ({viewer.email})</dd>
      <dt>Account type</dt>
      <dd>{viewer.kind === 'customer' ? 'Customer' : viewer.kind === 'ops' ? `Operations – ${viewer.ops.role}` : 'No VaultPay role'}</dd>
      {viewer.customer ? (
        <>
          <dt>KYC status</dt>
          <dd>{KYC_LABELS[viewer.customer.kycStatus] ?? viewer.customer.kycStatus}</dd>
          <dt>Wallet</dt>
          <dd>{viewer.customer.wallet ? `${viewer.customer.wallet.walletId} (${viewer.customer.wallet.status})` : 'None'}</dd>
        </>
      ) : null}
      <dt>Two-factor</dt>
      <dd>
        {viewer.mfa.verified ? 'Verified for this session' : viewer.mfa.enrolled ? 'Enrolled – not verified for this session' : 'Not set up'}
      </dd>
      <dt>Session expires</dt>
      <dd>{viewer.session.expiresAt.toISOString()} (30 minutes of inactivity)</dd>
    </dl>
  );
}
