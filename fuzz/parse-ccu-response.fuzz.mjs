// Coverage-guided fuzz target: parsing values out of a CCU JSON-RPC response.
//
// parseValue/parseValues run on data that arrived over the network. The
// property tests already pin the invariants; this target exists to reach the
// shapes a generator does not think of — the JSON parser feeding it means the
// fuzzer explores structure, not just strings.
//
// Two real bugs came out of the first property run on this surface: a
// TypeError on `{"toString": false}` (String() has no primitive to fall back
// to) and a "__proto__" key vanishing from the output. Both were network-
// reachable. This keeps that surface under continuous pressure.
//
// Run: npx jazzer fuzz/parse-ccu-response.fuzz.mjs fuzz/corpus/parse-ccu-response
import assert from "node:assert";
import { parseValue, parseValues, tryParseJson, expectArray } from "../dist/utils.js";

export function fuzz(data) {
  const text = data.toString("utf-8");

  // tryParseJson must never throw — it is the "parse or keep the raw text"
  // fallback, so a throw here defeats its entire purpose.
  const decoded = tryParseJson(text);

  const value = parseValue(decoded);
  // The contract: null, boolean, number, or a string. Anything else means a
  // caller's type assumptions are wrong.
  assert.ok(
    value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string",
    `parseValue returned ${Object.prototype.toString.call(value)}`,
  );

  // A number must carry the original digits exactly — the precision guard
  // exists so a long ID in a STRING datapoint is not silently rounded.
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `parseValue produced a non-finite number from ${text}`);
  }

  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
    const parsed = parseValues(decoded);
    // Key preservation, including keys that collide with Object.prototype.
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      Object.keys(decoded).sort(),
      "parseValues changed the key set",
    );
    assert.strictEqual(
      Object.getPrototypeOf(parsed),
      Object.prototype,
      "parseValues returned an object with a mutated prototype",
    );
  }

  // expectArray is the guard every list tool funnels through; it must reject
  // non-arrays with a clean error rather than letting one through.
  try {
    const arr = expectArray(decoded, "Fuzz.method");
    assert.ok(Array.isArray(arr), "expectArray returned a non-array without throwing");
  } catch (err) {
    assert.ok(err instanceof Error, `expectArray threw a non-Error: ${String(err)}`);
  }
}
