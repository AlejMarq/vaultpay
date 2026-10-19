// Core Banking client for the Core Banking Integration (CBI) process (Step 4A).
//
// CBI is the only VaultPay component that talks to Core Banking and the only holder of
// the Core Banking credential (D1). This module is for the CBI process only – the Next.js
// app must never import it (enforced by a test); browsers never see any of this.
//
// Each call:
//   - mutual TLS with CBI's own client certificate; the server must chain to this
//     installation's CA, present a localhost SAN, AND be CN=vaultpay-mock-core-banking
//     (a valid certificate of another VaultPay service is refused – threat 85)
//   - a hard deadline covering connect, TLS, request and response (default 3 s)
//   - a response size limit and strict schema validation (the bank's reply is untrusted)
//   - one error type with a small set of codes; no response body, header or secret is
//     ever copied into an error message

import { z } from 'zod';

import { mtlsRequest } from '../services/mtls-request.js';
import { loadProcessEnv } from '../services/process-env.js';
import { MOCK_CORE_BANKING_HOST, mockCoreBankingPort } from '../services/ports.js';

export const ACCOUNT_REF_PATTERN = /^MCB-[0-9]{4,10}$/;
export const EXPECTED_SERVER_CN = 'vaultpay-mock-core-banking';
export const DEFAULT_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export class CoreBankingError extends Error {
  /**
   * code: 'invalid_account' (rejected before sending) | 'not_found' | 'rejected'
   * (bank refused our credentials) | 'unavailable' (connection, TLS, timeout, 5xx) |
   * 'bad_response' (unexpected status or body, wrong server identity)
   */
  constructor(code, message) {
    super(message);
    this.name = 'CoreBankingError';
    this.code = code;
  }
}

const Balance = z.object({
  accountRef: z.string().regex(ACCOUNT_REF_PATTERN),
  currency: z.literal('USD'),
  balanceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['active', 'frozen', 'closed']),
  asOf: z.iso.datetime(),
}).strict();

export function createCoreBankingClient({
  host = MOCK_CORE_BANKING_HOST,
  port,
  tls: credentials,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  expectedServer = EXPECTED_SERVER_CN,
}) {
  if (!Number.isInteger(port) || port <= 0) throw new Error('Core Banking client: port is required');
  if (!apiKey) throw new Error('Core Banking client: API key is required');

  // Shared mTLS transport (lib/services/mtls-request.js): CBI's client certificate, the
  // dev CA, the bank's exact CN, a hard deadline and a size limit.
  async function request(path) {
    try {
      return await mtlsRequest({
        host, port, path, credentials, expectedServer, timeoutMs, maxBytes: MAX_RESPONSE_BYTES,
        headers: { authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      if (err.code === 'bad_server') throw new CoreBankingError('bad_response', 'Core Banking server identity could not be verified');
      if (err.code === 'bad_response') throw new CoreBankingError('bad_response', 'Core Banking response was invalid');
      throw new CoreBankingError('unavailable', 'Core Banking unavailable');
    }
  }
  return Object.freeze({
    /** Read-only balance of one Core Banking account. */
    async getBalance(accountRef) {
      if (typeof accountRef !== 'string' || !ACCOUNT_REF_PATTERN.test(accountRef)) {
        throw new CoreBankingError('invalid_account', 'invalid Core Banking account reference');
      }
      const res = await request(`/v1/accounts/${accountRef}/balance`);
      if (res.status === 404) throw new CoreBankingError('not_found', 'Core Banking account not found');
      if (res.status === 400) throw new CoreBankingError('invalid_account', 'Core Banking rejected the account reference');
      if (res.status === 401 || res.status === 403) throw new CoreBankingError('rejected', 'Core Banking refused CBI\'s credentials');
      if (res.status >= 500) throw new CoreBankingError('unavailable', `Core Banking error (HTTP ${res.status})`);
      if (res.status !== 200 || !res.type.startsWith('application/json')) throw new CoreBankingError('bad_response', `unexpected Core Banking response (HTTP ${res.status})`);
      let parsed;
      try {
        parsed = Balance.parse(res.json);
      } catch {
        throw new CoreBankingError('bad_response', 'Core Banking balance response failed validation');
      }
      if (parsed.accountRef !== accountRef) throw new CoreBankingError('bad_response', 'Core Banking answered for a different account');
      return Object.freeze(parsed);
    },
  });
}

/** The client CBI uses: its own cbi.env credentials and certificate. */
export function loadCoreBankingClient({ dataDir, port = mockCoreBankingPort(), timeoutMs } = {}) {
  const { values, tls: credentials } = loadProcessEnv('cbi', { dataDir, required: ['MOCK_CORE_BANKING_API_KEY'] });
  return createCoreBankingClient({ port, tls: credentials, apiKey: values.MOCK_CORE_BANKING_API_KEY, timeoutMs });
}
