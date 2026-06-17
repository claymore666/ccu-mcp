import { describe, it, expect } from "vitest";
import { extractBearerToken } from "../../src/utils.js";

describe("extractBearerToken", () => {
  it("extracts a well-formed bearer token", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme (RFC 7235)", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("BEARER abc123")).toBe("abc123");
  });

  it("tolerates multiple spaces after the scheme", () => {
    expect(extractBearerToken("Bearer    abc123")).toBe("abc123");
  });

  it("returns '' for a missing or non-bearer header", () => {
    expect(extractBearerToken("")).toBe("");
    expect(extractBearerToken("Basic abc123")).toBe("");
    expect(extractBearerToken("Bearer")).toBe("");
    expect(extractBearerToken("Bearer ")).toBe("");
  });

  it("does not backtrack polynomially on a whitespace-only tail (ReDoS guard)", () => {
    // The old /^Bearer\s+(.+)$/ overlapped \s+ and .+ on whitespace; a long
    // all-space tail was the polynomial-ReDoS input. Anchoring to \S makes
    // this linear: it must complete near-instantly and yield no token.
    const malicious = "Bearer" + " ".repeat(100_000);
    const start = performance.now();
    const token = extractBearerToken(malicious);
    const elapsed = performance.now() - start;
    expect(token).toBe("");
    expect(elapsed).toBeLessThan(50);
  });
});
