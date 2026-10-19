'use server';

// Send money (Step 5). Same-origin POST only (Next.js + assertSameOrigin, which also
// requires a localhost Host), and requireVerifiedCustomer() runs inside the action – the
// page having loaded proves nothing. The transfer logic re-checks eligibility again
// immediately before writing (lib/server/transfer-initiation.js).

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AccessDenied, deniedPath } from '@/lib/server/dal';
import { assertSameOrigin } from '@/lib/server/origin';
import { loadCustomerBalance, readOnlyIdentityDb, requireVerifiedCustomer } from '@/lib/server/session';
import { initiateTransfer, reviewTransfer } from '@/lib/server/transfer-initiation';
import { transferWriter } from '@/lib/server/transfer-orchestrator';

export async function transferAction(_previousState, formData) {
  assertSameOrigin(await headers());
  const { viewer } = await requireVerifiedCustomer();
  const field = (name) => {
    const value = formData.get(name);
    return typeof value === 'string' ? value : '';
  };
  const input = {
    recipientEmail: field('recipient'),
    amount: field('amount'),
    sourceWalletId: field('sourceWalletId'),
    idempotencyKey: field('idempotencyKey'),
  };

  let result;
  try {
    switch (field('intent')) {
      case 'review':
        result = reviewTransfer(viewer, input, { identityDb: readOnlyIdentityDb() });
        break;
      case 'confirm':
        result = await initiateTransfer(viewer, input, {
          identityDb: readOnlyIdentityDb(),
          writer: transferWriter(),
          fetchBalance: () => loadCustomerBalance(viewer),
        });
        break;
      default: // 'edit' (change the details) or 'new' (another transfer)
        result = { step: 'edit', values: { recipient: input.recipientEmail.slice(0, 254), amount: input.amount.slice(0, 32) } };
    }
  } catch (err) {
    if (err instanceof AccessDenied) redirect(deniedPath(err));
    throw err;
  }
  return result;
}
