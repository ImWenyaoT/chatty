import { timingSafeEqual } from "node:crypto";

/**
 * Decides whether a playground/API request is authorized.
 *
 * When no key is configured (`expectedKey` unset/empty) the endpoint is open,
 * preserving zero-config local/dev usage. When `CHATTY_API_KEY` is set, a request
 * must present a byte-equal `x-api-key` header; the comparison is constant-time
 * to avoid leaking the key through response timing.
 *
 * This protects a DEPLOYED instance from arbitrary callers. It is NOT per-customer
 * identity — a holder of the key can still address any customerId; binding a
 * caller to a customer is a larger auth layer left for later.
 */
export function isPlaygroundAuthorized(
  providedKey: string | null | undefined,
  expectedKey: string | undefined,
): boolean {
  if (!expectedKey) return true;
  if (typeof providedKey !== "string" || providedKey.length === 0) return false;
  const provided = Buffer.from(providedKey);
  const expected = Buffer.from(expectedKey);
  // timingSafeEqual throws on length mismatch; a length difference is already a
  // non-match, so guard it (the length itself is not the secret).
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
