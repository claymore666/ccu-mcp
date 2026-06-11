import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";

const ENV_FILENAME = ".env";

export async function resolveAuthToken(
  envToken: string | undefined,
  dataDir: string,
  logger: Logger,
): Promise<string> {
  // 1. Explicit env var takes priority
  if (envToken) {
    logger.info("auth_token_from_env");
    return envToken;
  }

  // 2. Try loading from /data/.env
  const envPath = join(dataDir, ENV_FILENAME);
  try {
    const content = await readFile(envPath, "utf-8");
    const match = content.match(/^MCP_AUTH_TOKEN=(.+)$/m);
    if (match?.[1]) {
      logger.info("auth_token_from_file");
      // trim: tolerate trailing \r if the file was edited with CRLF line endings
      return match[1].trim();
    }
  } catch {
    // File doesn't exist — will generate
  }

  // 3. Generate new token
  const token = randomBytes(32).toString("base64url");

  try {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = envPath + ".tmp";
    // 0600: file contains the bearer token for the HTTP transport
    await writeFile(tmpPath, `MCP_AUTH_TOKEN=${token}\n`, { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, envPath);
    logger.info("auth_token_generated");
    // Log to stderr so user can copy it
    process.stderr.write(`\n[debmatic-mcp] Generated auth token: ${token}\n`);
    process.stderr.write(`[debmatic-mcp] Token saved to ${envPath}\n`);
    process.stderr.write(`[debmatic-mcp] Use this token in your MCP client configuration.\n\n`);
  } catch (err) {
    logger.error("auth_token_save_failed", { error: (err as Error).message });
  }

  return token;
}
