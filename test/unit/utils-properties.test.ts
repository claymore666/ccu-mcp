import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  escapeHmScript,
  extractBearerToken,
  normalizeClientIp,
  parseValue,
  parseValues,
} from "../../src/utils.js";

/**
 * Property-based tests over the functions that take attacker-influenced input.
 *
 * These are the *hermetic* half of this project's dynamic analysis: a fixed
 * seed and a fixed run count make each assertion a pure function of the commit
 * under test, so this belongs inside `build-and-test` alongside the coverage
 * ratchet. Coverage-guided fuzzing — where the verdict depends on how long it
 * ran — lives in .github/workflows/fuzz.yml and is never a required check, for
 * the same reason `npm audit` isn't.
 *
 * The seed is pinned deliberately. An unpinned property test that fails only
 * on some runs is worse than no test: it trains people to re-run CI until it
 * passes. When a counterexample IS found, fast-check prints the seed and path
 * needed to replay it.
 */
const RUNS = { numRuns: 2000, seed: 0x5cc0, verbose: false };

describe("escapeHmScript", () => {
  /**
   * Reference implementation of ReGa's double-quoted string-literal reader,
   * matching the four escapes escapeHmScript emits. Round-tripping through it
   * is the actual security property: if some input can escape to something
   * this cannot decode back, the interpolation is ambiguous, and an ambiguous
   * escape into a scripting language is an injection.
   */
  function unescapeHmScript(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== "\\") {
        out += s[i];
        continue;
      }
      const next = s[++i];
      if (next === "\\") out += "\\";
      else if (next === '"') out += '"';
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else throw new Error(`unknown escape \\${next} at ${i}`);
    }
    return out;
  }

  it("round-trips any input through a ReGa string literal", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(unescapeHmScript(escapeHmScript(s))).toBe(s);
      }),
      RUNS,
    );
  });

  // Under-escaping is injection; over-escaping is corruption. Issue #16 hit the
  // second: `\#` kept the backslash and silently changed the value. Round-trip
  // catches both directions, which a "does it contain a quote" check does not.
  it("round-trips strings built from the characters that matter", () => {
    const hostile = fc.string({
      unit: fc.constantFrom("\\", '"', "\n", "\r", "#", "'", ";", "!", "x", "\t", "\0"),
      maxLength: 40,
    });
    fc.assert(
      fc.property(hostile, (s) => {
        expect(unescapeHmScript(escapeHmScript(s))).toBe(s);
      }),
      RUNS,
    );
  });

  it("never leaves a quote that would terminate the literal early", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const escaped = escapeHmScript(s);
        // Walk the output the way a parser would: a quote is only safe when an
        // ODD number of backslashes precedes it. Counting `\"` occurrences
        // would wrongly accept `\\"`, where the backslash escapes itself and
        // the quote closes the literal.
        for (let i = 0; i < escaped.length; i++) {
          if (escaped[i] !== '"') continue;
          let backslashes = 0;
          for (let j = i - 1; j >= 0 && escaped[j] === "\\"; j--) backslashes++;
          expect(backslashes % 2).toBe(1);
        }
      }),
      RUNS,
    );
  });

  it("never emits a raw newline or carriage return", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(escapeHmScript(s)).not.toMatch(/[\n\r]/);
      }),
      RUNS,
    );
  });
});

describe("extractBearerToken", () => {
  it("is total — never throws on any header value", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof extractBearerToken(s)).toBe("string");
      }),
      RUNS,
    );
  });

  // The extracted token reaches log lines that fail2ban parses. A CR or LF in
  // it would let a caller forge log records, and this runs pre-authentication.
  it("never returns a value containing CR or LF", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(extractBearerToken(s)).not.toMatch(/[\r\n]/);
      }),
      RUNS,
    );
  });

  it("extracts the token verbatim from a well-formed header", () => {
    const token = fc
      .string({ minLength: 1, maxLength: 64 })
      .filter((t) => !/[\s\r\n]/.test(t) && t.length > 0);
    fc.assert(
      fc.property(
        token,
        fc.constantFrom("Bearer", "bearer", "BEARER", "BeArEr"),
        fc.string({ unit: fc.constantFrom(" ", "\t"),  minLength: 1, maxLength: 4  }),
        (t, scheme, gap) => {
          expect(extractBearerToken(`${scheme}${gap}${t}`)).toBe(t);
        },
      ),
      RUNS,
    );
  });
});

describe("normalizeClientIp", () => {
  it("is total and never returns an empty string", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (s) => {
        const out = normalizeClientIp(s);
        expect(typeof out).toBe("string");
        expect(out.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  // It only ever slices a known prefix, so the result must be a suffix of the
  // input. Anything else would mean it invented or reordered characters, and
  // this value is what fail2ban matches as <HOST>.
  it("returns a suffix of its input, or the literal \"unknown\"", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = normalizeClientIp(s);
        expect(out === "unknown" || s.endsWith(out)).toBe(true);
      }),
      RUNS,
    );
  });

  it("strips exactly one IPv6-mapped-IPv4 prefix", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (rest) => {
        expect(normalizeClientIp(`::ffff:${rest}`)).toBe(rest);
      }),
      RUNS,
    );
  });
});

describe("parseValue", () => {
  it("is total on arbitrary CCU payload values", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(() => parseValue(v)).not.toThrow();
      }),
      RUNS,
    );
  });

  /**
   * The precision guard is the point of this function: a numeric-looking value
   * in a STRING datapoint (a long device or order ID) must not be silently
   * rounded by Number(). So whenever it DOES hand back a number, that number
   * has to carry the original digits exactly.
   */
  it("only returns a number when the decimal value survives exactly", () => {
    const numericish = fc
      .tuple(
        fc.constantFrom("", "-"),
        fc.string({ unit: fc.constantFrom(..."0123456789"),  minLength: 1, maxLength: 30  }),
        fc.option(fc.string({ unit: fc.constantFrom(..."0123456789"),  minLength: 1, maxLength: 12  }), {
          nil: undefined,
        }),
      )
      .map(([sign, int, frac]) => `${sign}${int}${frac === undefined ? "" : `.${frac}`}`);

    fc.assert(
      fc.property(numericish, (s) => {
        const out = parseValue(s);
        if (typeof out !== "number") {
          // Falling back to the string is always safe — nothing is lost.
          expect(out).toBe(s);
          return;
        }
        // Compare as decimals, not as strings: "1.50" -> 1.5 is a faithful
        // numeric parse even though the text differs.
        expect(Number(s)).toBe(out);
        if (!s.includes(".")) expect(BigInt(s)).toBe(BigInt(out));
      }),
      RUNS,
    );
  });

  it("returns null, boolean, number or the original string — never anything else", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = parseValue(s);
        const ok =
          out === null || typeof out === "boolean" || typeof out === "number" || out === s;
        expect(ok).toBe(true);
      }),
      RUNS,
    );
  });
});

/**
 * Concrete regressions for the three defects this file's own generators (and
 * the fuzzer) turned up when it was first written. The properties above would
 * catch all three again, but only across thousands of runs — these pin them as
 * named, one-line cases so a future reader sees what actually went wrong.
 */
describe("regressions found by property testing and fuzzing", () => {
  it("parseValue survives an object with no primitive conversion", () => {
    // String({toString: false}) throws TypeError. Reachable: this parses
    // JSON-RPC payloads off the network.
    expect(parseValue({ toString: false })).toBeNull();
    expect(parseValue({ toString: null, valueOf: null })).toBeNull();
  });

  it("parseValues keeps a __proto__ key instead of swallowing it", () => {
    // `result[k] = v` routed the key through Object.prototype's setter, so it
    // never became an own property and vanished from the output.
    const out = parseValues({ ["__proto__"]: "1", NORMAL: "2" });
    expect(Object.keys(out).sort()).toEqual(["NORMAL", "__proto__"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("normalizeClientIp never returns an empty host", () => {
    // "::ffff:" stripped to "". An empty <HOST> matches no fail2ban rule, and
    // collapses every such client into a single rate-limit bucket.
    expect(normalizeClientIp("::ffff:")).toBe("unknown");
  });
});

describe("parseValues", () => {
  it("preserves the key set exactly and maps each value through parseValue", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (obj) => {
        const out = parseValues(obj);
        expect(Object.keys(out).sort()).toEqual(Object.keys(obj).sort());
        for (const [k, v] of Object.entries(obj)) {
          expect(out[k]).toEqual(parseValue(v));
        }
      }),
      RUNS,
    );
  });
});
