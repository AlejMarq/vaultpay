// Development CA and service certificates for mutual TLS (D9).
//
// Section B covers the required Core Banking links first (approved decision 2):
//   Settlement ──mTLS──► Core Banking Integration ──mTLS──► mock Core Banking
//   Reconciliation & Audit (inside Next.js) ──mTLS, read-only scope──► CBI
// Other internal links can be added to CERTIFICATES later.
//
// Lifetimes (approved decision 8): CA 2 years, service certificates 1 year, warn at 30 days.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import selfsigned from 'selfsigned';

import { writeNewFile } from './paths.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CA_DAYS = 730;
export const LEAF_DAYS = 365;
export const WARN_DAYS = 30;

export const CA_CN = 'VaultPay Development CA';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

export const CERTIFICATES = Object.freeze([
  { name: 'cbi', cn: 'vaultpay-cbi', serverAuth: true, clientAuth: true },          // server for Settlement/Recon, client to mock Core Banking
  { name: 'settlement', cn: 'vaultpay-settlement', serverAuth: false, clientAuth: true },
  { name: 'recon', cn: 'vaultpay-recon', serverAuth: false, clientAuth: true },      // read-only records scope at CBI
  { name: 'mock-core-banking', cn: 'vaultpay-mock-core-banking', serverAuth: true, clientAuth: false },
]);

export const PKI_FILES = Object.freeze(
  ['ca.crt', 'ca.key', ...CERTIFICATES.flatMap((c) => [`${c.name}.crt`, `${c.name}.key`])].sort(),
);

const BASE = { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' };

export async function generatePki(dir, { now = Date.now() } = {}) {
  const notBeforeDate = new Date(now);
  const caNotAfter = new Date(now + CA_DAYS * DAY_MS);
  const ca = await selfsigned.generate([{ name: 'commonName', value: CA_CN }], {
    ...BASE,
    notBeforeDate,
    notAfterDate: caNotAfter,
    extensions: [
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  writeNewFile(path.join(dir, 'ca.crt'), ca.cert);
  writeNewFile(path.join(dir, 'ca.key'), ca.private);

  // A service certificate never outlives the CA that signed it.
  const leafNotAfter = new Date(Math.min(now + LEAF_DAYS * DAY_MS, caNotAfter.getTime()));
  for (const c of CERTIFICATES) {
    const leaf = await selfsigned.generate([{ name: 'commonName', value: c.cn }], {
      ...BASE,
      notBeforeDate,
      notAfterDate: leafNotAfter,
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, critical: true },
        { name: 'extKeyUsage', serverAuth: c.serverAuth, clientAuth: c.clientAuth },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
      ],
    });
    writeNewFile(path.join(dir, `${c.name}.crt`), leaf.cert);
    writeNewFile(path.join(dir, `${c.name}.key`), leaf.private);
  }
}

function read(dir, file, problems) {
  try {
    return fs.readFileSync(path.join(dir, file));
  } catch (err) {
    problems.push(`${file}: cannot read (${err.code})`);
    return undefined;
  }
}

const fingerprint = (x509) => x509.fingerprint256.replaceAll(':', '').toLowerCase();

/**
 * Validates the CA and every service certificate. Returns { problems, warnings, certificates };
 * any problem means the PKI must not be used.
 */
export function verifyPki(dir, { now = Date.now() } = {}) {
  const problems = [];
  const warnings = [];
  const certificates = {};

  let present;
  try {
    present = fs.readdirSync(dir).sort();
  } catch (err) {
    return { problems: [`pki directory unreadable (${err.code})`], warnings, certificates };
  }
  const missing = PKI_FILES.filter((f) => !present.includes(f));
  const extra = present.filter((f) => !PKI_FILES.includes(f));
  if (missing.length) problems.push(`missing: ${missing.join(', ')}`);
  if (extra.length) problems.push(`unexpected files: ${extra.join(', ')}`);
  if (missing.length) return { problems, warnings, certificates };

  const checkDates = (label, x509) => {
    const from = new Date(x509.validFrom).getTime();
    const to = new Date(x509.validTo).getTime();
    if (now < from) problems.push(`${label}: not valid until ${x509.validFrom}`);
    else if (now > to) problems.push(`${label}: expired ${x509.validTo}`);
    else if (to - now < WARN_DAYS * DAY_MS) warnings.push(`${label}: expires in ${Math.floor((to - now) / DAY_MS)} day(s) (${x509.validTo}); run npm run setup -- --renew-certs`);
    return to;
  };

  let ca;
  try {
    ca = new crypto.X509Certificate(read(dir, 'ca.crt', problems));
    const caKey = crypto.createPrivateKey(read(dir, 'ca.key', problems));
    if (!ca.ca) problems.push('ca.crt: not a CA certificate');
    if (ca.subject !== `CN=${CA_CN}`) problems.push(`ca.crt: unexpected subject ${ca.subject}`);
    if (!ca.verify(ca.publicKey)) problems.push('ca.crt: not self-signed');
    if (!ca.checkPrivateKey(caKey)) problems.push('ca.key: does not match ca.crt');
    checkDates('ca.crt', ca);
    certificates.ca = { cn: CA_CN, sha256: fingerprint(ca), notAfter: new Date(ca.validTo).toISOString() };
  } catch (err) {
    problems.push(`ca: ${err.message}`);
    return { problems, warnings, certificates };
  }

  for (const c of CERTIFICATES) {
    const label = `${c.name}.crt`;
    try {
      const x509 = new crypto.X509Certificate(read(dir, label, problems));
      const key = crypto.createPrivateKey(read(dir, `${c.name}.key`, problems));
      if (x509.ca) problems.push(`${label}: must not be a CA`);
      if (x509.subject !== `CN=${c.cn}`) problems.push(`${label}: subject ${x509.subject}, expected CN=${c.cn}`);
      if (!x509.checkIssued(ca) || !x509.verify(ca.publicKey)) problems.push(`${label}: not signed by the VaultPay development CA`);
      if (!x509.checkPrivateKey(key)) problems.push(`${c.name}.key: does not match ${label}`);

      const eku = x509.keyUsage ?? [];
      if (eku.includes(OID_SERVER_AUTH) !== c.serverAuth) problems.push(`${label}: serverAuth usage should be ${c.serverAuth}`);
      if (eku.includes(OID_CLIENT_AUTH) !== c.clientAuth) problems.push(`${label}: clientAuth usage should be ${c.clientAuth}`);
      const san = x509.subjectAltName ?? '';
      if (!san.includes('DNS:localhost') || !san.includes('IP Address:127.0.0.1')) problems.push(`${label}: subjectAltName must cover localhost and 127.0.0.1 (got "${san}")`);

      const to = checkDates(label, x509);
      if (to > new Date(ca.validTo).getTime()) problems.push(`${label}: outlives the CA`);
      certificates[c.name] = { cn: c.cn, sha256: fingerprint(x509), notAfter: new Date(x509.validTo).toISOString() };
    } catch (err) {
      problems.push(`${label}: ${err.message}`);
    }
  }
  return { problems, warnings, certificates };
}
