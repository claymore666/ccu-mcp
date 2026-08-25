import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_IDENTITY } from "./server.js";
import { registerSetupTools } from "./tools/setup.js";
import type { Logger } from "./logger.js";

/**
 * Instructions for setup mode. Unlike the configured server's, these must
 * carry the whole flow: the client has never seen this server work, so the
 * model's only guidance is what arrives with the initialize result. The
 * password rule is stated twice on purpose — it is the one step where the
 * model doing the "helpful" thing (asking for the password in chat) would be
 * wrong.
 */
function setupInstructions(envPath: string, configError: string): string {
  return `This ccu-mcp server is NOT configured yet — it started in setup mode because loading \
its configuration failed (${configError}). Only the setup_* tools are available; they write to \
${envPath}.

Walk the user through configuring their HomeMatic CCU connection:
1. setup_status shows what the env file already contains.
2. Ask for the CCU's hostname or IP; setup_probe finds the port/HTTPS and fetches the TLS \
certificate. On HTTPS, recommend pinning the certificate fingerprint.
3. setup_write_profile writes the connection settings. It has no password parameter.
4. The password must NEVER travel through this conversation — do not ask for it, and refuse it \
if offered. Instead have the user run the \`ccu-mcp secret\` command printed by \
setup_write_profile in a terminal; it prompts locally with echo off and stores only the password.
5. setup_test verifies reachability, the certificate pin and the login.
6. When every check passes, tell the user to reconnect this MCP server (restart the client or \
its MCP connection) — it will start fully configured with the normal tool set.

Multiple CCUs (e.g. prod and dev) are supported: repeat steps 2-5 with a name per target \
("default" means a single unnamed CCU).`;
}

/**
 * The minimal MCP server the process runs when started with --stdio --env
 * <path> and an invalid/missing configuration (see index.ts). Same identity as
 * the configured server, but only the four setup tools — no resources, no
 * prompts, no CCU-backed anything.
 */
export function createSetupServer(envPath: string, configError: string, logger: Logger): McpServer {
  const server = new McpServer(SERVER_IDENTITY, {
    instructions: setupInstructions(envPath, configError),
    capabilities: { tools: {}, logging: {} },
  });
  registerSetupTools(server, { envPath, configError, logger });
  return server;
}
