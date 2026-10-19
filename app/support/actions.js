'use server';

// Read-only customer lookup for support. Same-origin POST only (Next.js + assertSameOrigin),
// and requireSupport() runs again inside the action – the page having loaded proves
// nothing. The only write this causes is the audit record (lib/server/audit.js).

import { headers } from 'next/headers';

import { auditWriter } from '@/lib/server/audit';
import { assertSameOrigin } from '@/lib/server/origin';
import { readOnlyIdentityDb, readOnlyTransactionDb, requireSupport } from '@/lib/server/session';
import { lookupCustomer } from '@/lib/server/support';

export async function lookupAction(_previousState, formData) {
  assertSameOrigin(await headers());
  const viewer = await requireSupport();
  const email = formData.get('email');
  const result = lookupCustomer(viewer, email, {
    identityDb: readOnlyIdentityDb(),
    transactionDb: readOnlyTransactionDb(),
    audit: auditWriter(),
  });
  return { searched: typeof email === 'string' ? email.slice(0, 254) : '', result };
}
