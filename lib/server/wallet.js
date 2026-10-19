// Customer wallet overview (read-only). Data comes only from the viewer's own records:
// the wallet id is the one the DAL resolved for this session, never a request value, so a
// customer cannot ask for another customer's wallet.
//
// Balances are not read here: Core Banking is the source of truth (D7) and is reached
// only through Core Banking Integration, which is not built yet.

import { assertCustomer } from './dal.js';
import { recentTransfers } from './transfers.js';

export function getWalletOverview(viewer, { identityDb, transactionDb }) {
  assertCustomer(viewer); // checked again here, close to the data
  const { customer } = viewer;
  return Object.freeze({
    name: viewer.name,
    email: viewer.email,
    customerId: customer.customerId,
    kycStatus: customer.kycStatus,
    wallet: customer.wallet,
    transfers: customer.wallet ? recentTransfers({ transactionDb, identityDb, walletId: customer.wallet.walletId }) : [],
  });
}
