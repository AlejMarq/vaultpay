import { SignOutButton } from '../session-controls';

export const metadata = { title: 'Access denied – VaultPay' };

// Shown when a signed-in, MFA-verified account may not use the page it asked for: wrong
// role, a suspended or closed customer, a disabled ops user, or no VaultPay role at all.
// Static: it reveals nothing about the account.
export default function AccessDeniedPage() {
  return (
    <main className="page narrow">
      <h1>Access denied</h1>
      <p>Your account does not have access to this part of VaultPay, or it is not active. Contact VaultPay support if you think this is a mistake.</p>
      <SignOutButton />
    </main>
  );
}
