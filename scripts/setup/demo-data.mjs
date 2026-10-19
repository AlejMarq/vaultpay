// VaultPay demo data – LOCALHOST DEMONSTRATION ONLY.
//
// These passwords are fixed and published in docs/SETUP.md so anyone can try the demo.
// They must never be used for a real account, and a VaultPay installation seeded with
// them must never be reachable from outside this computer. Setup refuses to run with
// NODE_ENV=production.
//
// Balances live in the mock Core Banking database (D7: Core Banking is the source of
// truth). They are set once, when an account is first created, and never reset by setup.

// All demo addresses use example.test, a domain reserved for testing (RFC 2606).
export const DEMO_CUSTOMERS = Object.freeze([
  {
    email: 'alice@example.test',
    password: 'VaultPayDemo-Alice-1!',
    name: 'Alice Demo',
    phone: '+1-555-0101',
    customerId: 'cus_demo_alice',
    kyc: 'approved',
    walletId: 'wal_demo_alice',
    coreAccountRef: 'MCB-1001',
    openingBalanceCents: 50_000, // $500.00
  },
  {
    email: 'bob@example.test',
    password: 'VaultPayDemo-Bob-1!',
    name: 'Bob Demo',
    phone: '+1-555-0102',
    customerId: 'cus_demo_bob',
    kyc: 'approved',
    walletId: 'wal_demo_bob',
    coreAccountRef: 'MCB-1002',
    openingBalanceCents: 25_000, // $250.00
  },
  {
    // KYC pending: has funds, but must be blocked from moving money until verified.
    email: 'carol@example.test',
    password: 'VaultPayDemo-Carol-1!',
    name: 'Carol Demo',
    phone: '+1-555-0103',
    customerId: 'cus_demo_carol',
    kyc: 'pending',
    walletId: 'wal_demo_carol',
    coreAccountRef: 'MCB-1003',
    openingBalanceCents: 10_000, // $100.00
  },
]);

export const DEMO_OPS_USERS = Object.freeze([
  {
    email: 'support@example.test',
    password: 'VaultPayDemo-Support-1!',
    name: 'Sam Support',
    opsUserId: 'ops_demo_support',
    role: 'support_readonly',
  },
]);

export const DEMO_MERCHANTS = Object.freeze([
  {
    merchantId: 'mer_demo_coffee',
    displayName: 'Demo Coffee',
    qrIdentifier: 'vaultpay:merchant:demo-coffee',
    coreAccountRef: 'MCB-2001',
    openingBalanceCents: 0, // receives payments only
  },
]);

export const DEMO_KYC_REF = 'demo-kyc-seed';
