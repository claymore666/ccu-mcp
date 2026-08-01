// Coverage-guided fuzz target: Authorization header parsing.
//
// extractBearerToken runs BEFORE authentication, on a header the caller fully
// controls, so it is reachable by anyone who can open a socket. It has already
// carried one ReDoS (CodeQL js/polynomial-redos: `\s+(.+)` overlapped on
// whitespace and backtracked polynomially). A fuzzer is the right tool for the
// next one — libFuzzer's own timeout catches catastrophic backtracking, which
// a fixed-iteration property test cannot assert on without a flaky wall-clock
// comparison in a required check.
//
// Run: npx jazzer fuzz/bearer-token.fuzz.mjs fuzz/corpus/bearer-token
import assert from "node:assert";
import { extractBearerToken, normalizeClientIp } from "../dist/utils.js";

export function fuzz(data) {
  const header = data.toString("utf-8");

  const token = extractBearerToken(header);
  assert.strictEqual(typeof token, "string", "extractBearerToken returned a non-string");

  // The token reaches log lines that fail2ban parses. A CR or LF in it would
  // let an unauthenticated caller forge log records.
  assert.ok(!/[\r\n]/.test(token), `token carries CR/LF: ${JSON.stringify(token)}`);

  // Whatever it extracts has to be a substring of what came in — never
  // invented, never reordered.
  assert.ok(token === "" || header.includes(token), "extracted token is not part of the header");

  // Same header bytes, reused as a peer address: normalizeClientIp feeds the
  // rate limiter, and returning "" would collapse every client into one bucket.
  const ip = normalizeClientIp(header);
  assert.ok(ip.length > 0, "normalizeClientIp returned an empty string");
  assert.ok(
    ip === "unknown" || header.endsWith(ip),
    "normalizeClientIp returned something that is not a suffix of its input",
  );
}
