import { resolve } from "node:path";
import { Prompter, type PromptIo } from "./prompt.js";
import { envFileArg, loadEnvFile, selfCommand } from "./common.js";
import { quoteEnvValue, readEnvFile, replaceEnvKey, writeEnvFile } from "./env-writer.js";
import { envPrefix } from "../config.js";

/**
 * `ccu-mcp secret [profile]` — store ONE value, the CCU password, into the env
 * file via a local hidden prompt. This is the hand-off the MCP setup flow
 * (tools/setup.ts) prints so the password never travels through the model or
 * the chat transcript; it is also the documented rotation path.
 */
export async function run(argv: string[], io?: PromptIo): Promise<number> {
  const out = io?.output ?? process.stdout;
  const say = (text: string): void => void out.write(text + "\n");
  let envPath: string;
  let vars: Record<string, string>;
  let content: string | undefined;
  try {
    envPath = envFileArg(argv);
    content = readEnvFile(envPath);
    if (content === undefined) {
      say(`ccu-mcp secret: ${resolve(envPath)} does not exist — run \`${selfCommand("init", "--env", envPath)}\` or the MCP setup flow first.`);
      return 1;
    }
    vars = loadEnvFile(envPath);
  } catch (err) {
    say(`ccu-mcp secret: ${(err as Error).message}`);
    return 1;
  }

  // The profile name is the first bare positional argument (skip --env's value).
  const profileArg = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--env");

  const names = vars.CCU_PROFILES?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  let key: string;
  let target: string;
  if (names.length > 0) {
    if (!profileArg) {
      say(`This file configures named targets (${names.join(", ")}) — say which one:`);
      say(`  ${selfCommand("secret", "<profile>", "--env", envPath)}`);
      return 1;
    }
    const match = names.find((n) => n.toLowerCase() === profileArg.toLowerCase());
    if (!match) {
      say(`ccu-mcp secret: "${profileArg}" is not one of the configured targets (${names.join(", ")}).`);
      return 1;
    }
    key = `CCU_${envPrefix(match)}_PASSWORD`;
    target = `${vars[`CCU_${envPrefix(match)}_USER`] || "Admin"}@${vars[`CCU_${envPrefix(match)}_HOST`] || match}`;
  } else {
    if (profileArg) {
      say(`ccu-mcp secret: this file uses the single-CCU form — no profile name needed:`);
      say(`  ${selfCommand("secret", "--env", envPath)}`);
      return 1;
    }
    key = "CCU_PASSWORD";
    target = `${vars.CCU_USER || "Admin"}@${vars.CCU_HOST || "CCU"}`;
  }

  const ui = new Prompter(io ?? { input: process.stdin, output: process.stdout });
  try {
    const password = await ui.askHidden(`CCU password for ${target} (input hidden)`);
    if (password === "") {
      ui.say("  Storing an EMPTY password (normal for a fresh OpenCCU dev box).");
    }
    writeEnvFile(envPath, replaceEnvKey(content, key, quoteEnvValue(password)));
    ui.say(`Wrote ${key} to ${resolve(envPath)} (mode 0600).`);
    ui.say(`Verify with: ${selfCommand("doctor", "--env", envPath)}`);
    return 0;
  } catch (err) {
    if ((err as Error).message === "input closed") {
      process.stderr.write("ccu-mcp secret: input closed — nothing written.\n");
      return 130;
    }
    process.stderr.write(`ccu-mcp secret: ${(err as Error).message}\n`);
    return 1;
  } finally {
    ui.close();
  }
}
