// Where backend services listen. Every service binds to 127.0.0.1 only.

export const MOCK_CORE_BANKING_HOST = '127.0.0.1';
export const SERVICE_HOST = '127.0.0.1';
export const DEFAULT_MOCK_CORE_BANKING_PORT = 4100;

// Service → [environment variable, default port]
const PORTS = Object.freeze({
  'mock-core-banking': ['VAULTPAY_MOCK_BANK_PORT', DEFAULT_MOCK_CORE_BANKING_PORT],
  identity: ['VAULTPAY_IDENTITY_PORT', 4200],
  cbi: ['VAULTPAY_CBI_PORT', 4300],
  fraud: ['VAULTPAY_FRAUD_PORT', 4400],
  settlement: ['VAULTPAY_SETTLEMENT_PORT', 4500],
});

/** The port for `service`: its environment variable, or the default; 0 means "any free port" (tests). */
export function servicePort(service, env = process.env) {
  const [variable, fallback] = PORTS[service] ?? [];
  if (!variable) throw new Error(`unknown service: ${service}`);
  const raw = env[variable];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${variable} must be a port number`);
  return port;
}

export const mockCoreBankingPort = (env = process.env) => servicePort('mock-core-banking', env);
