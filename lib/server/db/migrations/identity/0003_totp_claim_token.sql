-- VaultPay Customer & Identity DB – schema v3
-- TOTP replay claims get a random owner token (Step 3, Section 3E).
--
-- Releasing a claim (after Better Auth rejected the code) must only ever remove the
-- caller's own claim. Matching on claimed_at alone is not enough: two requests can claim
-- the same code in the same millisecond (e.g. from two processes), and a late release
-- would then delete the other request's successful claim and reopen the code.

ALTER TABLE totp_code_use ADD COLUMN claim_token TEXT CHECK (claim_token IS NULL OR length(claim_token) = 32);
