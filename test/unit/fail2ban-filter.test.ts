import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../../src/logger.js";
import { normalizeClientIp } from "../../src/utils.js";

// Locks the contract between the auth-failure log line the server emits and the
// committed fail2ban filter. If either the log shape (src/index.ts) or the
// filter regex (fail2ban/filter.d/ccu-mcp.conf) drifts, this fails — so a
// shipped filter can't silently stop matching real log lines.

const FILTER = join(__dirname, "../../fail2ban/filter.d/ccu-mcp.conf");

/** The exact line the server writes on a rejected request (mirrors src/index.ts). */
function authFailedLine(client: string, hadToken: boolean): string {
  const logger = new Logger("warn");
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    logger.warn("auth_failed", { client: normalizeClientIp(client), hadToken });
    return (spy.mock.calls[0]![0] as string).trim();
  } finally {
    spy.mockRestore();
  }
}

/** Read a `failregex`/`#failregex` value from the filter and make it a JS RegExp. */
function failRegex(commented: boolean): RegExp {
  const text = readFileSync(FILTER, "utf-8");
  const re = commented ? /^#failregex\s*=\s*(.+)$/m : /^failregex\s*=\s*(.+)$/m;
  const pattern = text.match(re)?.[1];
  expect(pattern, "filter must define a failregex").toBeTruthy();
  // fail2ban's <HOST> placeholder → a capturing IPv4/IPv6 group for the test.
  return new RegExp(pattern!.replace("<HOST>", "([0-9a-fA-F:.]+)"));
}

describe("fail2ban filter", () => {
  it("defines exactly one active (uncommented) failregex", () => {
    const active = readFileSync(FILTER, "utf-8")
      .split("\n")
      .filter((l) => /^failregex\s*=/.test(l));
    expect(active).toHaveLength(1);
  });

  it("matches the real auth_failed line and captures the client IP", () => {
    const line = authFailedLine("203.0.113.7", true);
    const m = line.match(failRegex(false));
    expect(m, `filter did not match: ${line}`).not.toBeNull();
    expect(m![1]).toBe("203.0.113.7");
  });

  it("captures the bare IPv4 from an IPv6-mapped peer address", () => {
    const line = authFailedLine("::ffff:198.51.100.9", false);
    const m = line.match(failRegex(false));
    expect(m).not.toBeNull();
    expect(m![1]).toBe("198.51.100.9");
  });

  it("active rule bans both bad-token and no-credential attempts", () => {
    const re = failRegex(false);
    expect(authFailedLine("203.0.113.7", true)).toMatch(re);
    expect(authFailedLine("203.0.113.7", false)).toMatch(re);
  });

  it("the stricter (commented) rule matches a bad token but not a credential-less probe", () => {
    const strict = failRegex(true);
    expect(authFailedLine("203.0.113.7", true)).toMatch(strict);
    expect(authFailedLine("203.0.113.7", false)).not.toMatch(strict);
  });
});
