import { describe, it, expect } from "vitest";
import { escapeHmScript, parseValue, parseValues, normalizeClientIp } from "../../src/utils.js";

describe("normalizeClientIp", () => {
  it("passes through a plain IPv4 / IPv6 address", () => {
    expect(normalizeClientIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeClientIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("strips the IPv6-mapped-IPv4 prefix so fail2ban sees the bare IPv4", () => {
    expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("returns 'unknown' for a missing address (no IP-based rule will match it)", () => {
    expect(normalizeClientIp(undefined)).toBe("unknown");
    expect(normalizeClientIp("")).toBe("unknown");
  });
});

describe("escapeHmScript", () => {
  // Escape semantics verified against a live CCU (issue #16):
  // \\ \" \n \r are real ReGa escapes; # must NOT be escaped (ReGa keeps
  // the backslash, corrupting the value).
  it("escapes backslash, quote, and newlines", () => {
    expect(escapeHmScript('a"b')).toBe('a\\"b');
    expect(escapeHmScript("a\\b")).toBe("a\\\\b");
    expect(escapeHmScript("a\nb\rc")).toBe("a\\nb\\rc");
  });

  it("leaves # untouched", () => {
    expect(escapeHmScript("a#b")).toBe("a#b");
  });
});

describe("parseValue", () => {
  it("converts CCU float strings to numbers", () => {
    expect(parseValue("19.000000")).toBe(19);
    expect(parseValue("21.500000")).toBe(21.5);
    expect(parseValue("0.500000")).toBe(0.5);
    expect(parseValue("-19.000000")).toBe(-19);
  });

  it("converts plain integers and booleans", () => {
    expect(parseValue("42")).toBe(42);
    expect(parseValue("0")).toBe(0);
    expect(parseValue("-7")).toBe(-7);
    expect(parseValue("true")).toBe(true);
    expect(parseValue("false")).toBe(false);
  });

  it("returns null for empty/null/undefined", () => {
    expect(parseValue("")).toBe(null);
    expect(parseValue(null)).toBe(null);
    expect(parseValue(undefined)).toBe(null);
  });

  // Regression: Number() coercion used to mangle these (issue #6)
  it("preserves strings that would lose information as numbers", () => {
    expect(parseValue("0123")).toBe("0123");            // leading zero (PIN/code)
    expect(parseValue("+4917012345")).toBe("+4917012345"); // phone number
    expect(parseValue("0x1A")).toBe("0x1A");            // hex notation
    expect(parseValue("1e5")).toBe("1e5");              // exponent notation
    expect(parseValue("Infinity")).toBe("Infinity");
    expect(parseValue("3.85.7")).toBe("3.85.7");        // version string
    expect(parseValue("  ")).toBe("  ");                // whitespace only
  });
});

describe("parseValues", () => {
  it("parses all values in a flat object", () => {
    expect(parseValues({ a: "1.000000", b: "true", c: "", d: "0123" }))
      .toEqual({ a: 1, b: true, c: null, d: "0123" });
  });
});
