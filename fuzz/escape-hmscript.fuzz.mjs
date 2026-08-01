// Coverage-guided fuzz target: HM Script string escaping.
//
// This is the highest-value target in the codebase. escapeHmScript is what
// stands between a tool parameter and the ReGa interpreter running on the CCU,
// and SECURITY.md names script injection through run_script as in-scope.
//
// The oracle is differential: escape, then decode with an independent
// reference implementation of ReGa's double-quoted literal reader. Any input
// that does not survive the round trip means the escaping is ambiguous, and an
// ambiguous escape into a scripting language is an injection.
//
// Run: npx jazzer fuzz/escape-hmscript.fuzz.mjs fuzz/corpus/escape-hmscript
import assert from "node:assert";
import { escapeHmScript } from "../dist/utils.js";

/** Independent reader for the four escapes escapeHmScript emits. */
function unescapeHmScript(s) {
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
    else throw new Error(`unknown escape \\${next} in ${JSON.stringify(s)}`);
  }
  return out;
}

export function fuzz(data) {
  const input = data.toString("utf-8");
  const escaped = escapeHmScript(input);

  assert.strictEqual(
    unescapeHmScript(escaped),
    input,
    `escapeHmScript is not round-trippable for ${JSON.stringify(input)}`,
  );

  // A raw newline would terminate the statement, not just the literal.
  assert.ok(!/[\n\r]/.test(escaped), `raw newline survived escaping: ${JSON.stringify(escaped)}`);

  // Every quote must sit behind an odd number of backslashes, or it closes the
  // literal early. Counting `\"` would wrongly accept `\\"`.
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && escaped[j] === "\\"; j--) backslashes++;
    assert.strictEqual(backslashes % 2, 1, `unescaped quote at ${i} in ${JSON.stringify(escaped)}`);
  }
}
