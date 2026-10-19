# VaultPay

Secure Software Development – Project 2. A localhost demonstration of a P2P wallet built
with Next.js 16, SQLite (better-sqlite3), Better Auth and mutual TLS between services.

> [!WARNING]
> Localhost demonstration only. Setup creates demo accounts with **published, demo-only
> passwords**. Never reuse them for real accounts and never expose this application
> beyond your own computer.

## Setup

Requires Windows, Node.js **22.23.3** (`.nvmrc`) and npm 10.9.9.

```powershell
npm.cmd ci
npm.cmd run setup          # creates data/: databases, dev CA + certificates, per-process secrets, demo data
npm.cmd run setup:check    # read-only verification of the installation
npm.cmd test               # automated tests
npm.cmd run dev            # http://localhost:3000
```

`npm run setup` is safe to repeat: it creates only what is missing and never overwrites
existing databases, secrets or certificates without an explicit option and a typed
confirmation. Everything it generates lives in the git-ignored `data/` folder, and each
computer runs its own setup.

Demo logins (password in [docs/SETUP.md](docs/SETUP.md#4-demo-accounts-localhost-only)):

| Login | Role | KYC | Opening balance |
|-------|------|-----|-----------------|
| `alice@example.test` | Customer | Approved | $500.00 |
| `bob@example.test` | Customer | Approved | $250.00 |
| `carol@example.test` | Customer | Pending | $100.00 |
| `support@example.test` | Ops, read-only support | – | – |

Merchant: **Demo Coffee** (QR `vaultpay:merchant:demo-coffee`, $0.00).

Full details – what setup creates, reset options, `setup:check`, troubleshooting:
**[docs/SETUP.md](docs/SETUP.md)**. Design decisions and test results:
[docs/PAIR_PROGRAMMING_LOG.md](docs/PAIR_PROGRAMMING_LOG.md).

---

The notes below come from the original Next.js starter.

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
