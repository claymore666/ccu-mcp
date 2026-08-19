import { describe, it, expect } from "vitest";
import { createMcpServer, serverSubscriptions } from "../../src/server.js";
import { RESOURCE_URIS } from "../../src/resources/registry.js";
import { createMockDeps } from "./_helpers.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// resources/subscribe and resources/unsubscribe are hand-registered in
// src/server.ts because the SDK's McpServer backs no handler for the
// capability we advertise. Nothing exercised those handlers, so the
// subscription set the ResourcePoller consults was untested.

/** Invoke a registered request handler the way the SDK transport would. */
async function callHandler(server: any, schema: any, params: unknown): Promise<unknown> {
  const method = schema.shape.method.value as string;
  const handler = server.server._requestHandlers.get(method);
  expect(handler, `no handler registered for ${method}`).toBeDefined();
  return handler({ method, params }, { signal: new AbortController().signal });
}

describe("resources/subscribe handlers", () => {
  it("records a subscription for a known URI", async () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    const uri = RESOURCE_URIS[0];

    await callHandler(server, SubscribeRequestSchema, { uri });

    // The poller reads exactly this set to decide who gets notified.
    expect(serverSubscriptions.get(server)?.has(uri)).toBe(true);
    deps.rateLimiter.destroy();
  });

  it("rejects an unknown URI instead of silently accepting it", async () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);

    // Accepting a typo would leave the client waiting forever for
    // notifications that can never arrive.
    await expect(
      callHandler(server, SubscribeRequestSchema, { uri: "ccu://typo" }),
    ).rejects.toThrow(McpError);

    try {
      await callHandler(server, SubscribeRequestSchema, { uri: "ccu://typo" });
    } catch (err) {
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      // The error must name the valid URIs so the client can self-correct.
      expect((err as McpError).message).toContain(RESOURCE_URIS[0]);
      // …and say it once: McpError builds its message as "MCP error <code>:
      // <text>", which the client prefixes again on receipt, so a raw McpError
      // message reaches the user doubled.
      expect((err as McpError).message).not.toContain("MCP error");
    }

    expect(serverSubscriptions.get(server)?.size).toBe(0);
    deps.rateLimiter.destroy();
  });

  it("unsubscribe removes the URI and is idempotent", async () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    const uri = RESOURCE_URIS[0];

    await callHandler(server, SubscribeRequestSchema, { uri });
    await callHandler(server, UnsubscribeRequestSchema, { uri });
    expect(serverSubscriptions.get(server)?.has(uri)).toBe(false);

    // Unsubscribing something never subscribed must not throw.
    await expect(
      callHandler(server, UnsubscribeRequestSchema, { uri }),
    ).resolves.toEqual({});
    deps.rateLimiter.destroy();
  });

  it("keeps subscription sets separate per server instance", async () => {
    const depsA = createMockDeps();
    const depsB = createMockDeps();
    const a = createMcpServer(depsA);
    const b = createMcpServer(depsB);

    await callHandler(a, SubscribeRequestSchema, { uri: RESOURCE_URIS[0] });

    // In HTTP mode every client gets its own McpServer; one client's
    // subscribe must not leak notifications to another.
    expect(serverSubscriptions.get(a)?.has(RESOURCE_URIS[0])).toBe(true);
    expect(serverSubscriptions.get(b)?.has(RESOURCE_URIS[0])).toBe(false);

    depsA.rateLimiter.destroy();
    depsB.rateLimiter.destroy();
  });
});
