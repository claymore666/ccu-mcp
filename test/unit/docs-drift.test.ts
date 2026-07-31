import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";

// Docs-drift guard for the TOOL surfaces. Four places name the tool set, and
// exactly one of them is the truth:
//
//   1. the MCP registration itself           — the truth
//   2. the `help` tool's per-tool docs       — TOOL_HELP in src/tools/meta.ts
//   3. the `help` tool's conceptual guide    — "## Available Tools", same file
//   4. README.md's "## Tools" section        — plus its hardcoded tool COUNT
//
// A tool added without touching 2-4 ships invisible: it works over MCP, but the
// help tool — which is how a model discovers what it can do here — never
// mentions it, and the README undersells the server. CLAUDE.md's QA loop lists
// "update the help tool's text" as a MANUAL step after every change, which is
// exactly the kind of instruction that holds until the one time it doesn't.
//
// Everything below is derived BEHAVIOURALLY: the registry is read off a real
// server, and both help surfaces come from actually calling `help`. Nothing
// regex-scrapes meta.ts, because tool names are not always literals at the
// registration site — `registerAssignChannel(server, deps, "add")` builds
// `assign_channel` at runtime, so a static scan silently under-reports and the
// guard would pass by never learning about the tool it was meant to catch.

const README = join(__dirname, "../../README.md");

/** Every tool actually registered on the server — the source of truth. */
function registeredTools(): string[] {
  const { server, deps } = createTestServer();
  try {
    const reg = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    return Object.keys(reg).sort();
  } finally {
    cleanupDeps(deps);
  }
}

/**
 * The tools `help` has per-tool docs for. Recovered from the unknown-topic
 * reply, which enumerates `Object.keys(TOOL_HELP)` — behaviour rather than
 * source text, so it stays correct if that table is ever refactored.
 */
async function toolsWithHelpEntries(): Promise<string[]> {
  const { server, deps } = createTestServer();
  try {
    const res = await callTool(server, "help", { topic: "no such topic" });
    const text = parseToolResult(res) as string;
    const line = text.split("\n").find((l) => l.startsWith("Available tools:"));
    if (!line) throw new Error(`help's unknown-topic reply changed shape:\n${text}`);
    return line
      .replace("Available tools:", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  } finally {
    cleanupDeps(deps);
  }
}

/** The conceptual guide `help` returns when given no topic. */
async function conceptualGuide(): Promise<string> {
  const { server, deps } = createTestServer();
  try {
    return parseToolResult(await callTool(server, "help", {})) as string;
  } finally {
    cleanupDeps(deps);
  }
}

/**
 * Tool names appearing in one markdown section, located by heading and ending
 * at the next heading of the same or higher level. Tool names are snake_case;
 * `help` is the only one without an underscore.
 */
function toolNamesInSection(text: string, heading: string): string[] {
  const start = text.indexOf(heading);
  if (start === -1) throw new Error(`section "${heading}" not found — was the heading renamed?`);
  const rest = text.slice(start + heading.length);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  const body = next === -1 ? rest : rest.slice(0, next);
  const found = [...body.matchAll(/\b(help|[a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}

describe("docs drift: the help tool vs the registered tools", () => {
  it("has a help entry for every registered tool", async () => {
    const documented = new Set(await toolsWithHelpEntries());
    const missing = registeredTools().filter((t) => !documented.has(t));
    expect(
      missing,
      `registered but absent from TOOL_HELP in src/tools/meta.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no help entry for a tool that isn't registered", async () => {
    const registered = new Set(registeredTools());
    const stale = (await toolsWithHelpEntries()).filter((t) => !registered.has(t));
    expect(
      stale,
      `documented in TOOL_HELP but no longer registered: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("lists every registered tool in the guide's Available Tools section", async () => {
    const listed = new Set(toolNamesInSection(await conceptualGuide(), "## Available Tools"));
    const missing = registeredTools().filter((t) => !listed.has(t));
    expect(
      missing,
      `missing from CONCEPTUAL_GUIDE's "## Available Tools": ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lists no unregistered tool in the guide's Available Tools section", async () => {
    const registered = new Set(registeredTools());
    const stale = toolNamesInSection(await conceptualGuide(), "## Available Tools").filter(
      (t) => !registered.has(t),
    );
    expect(
      stale,
      `listed in CONCEPTUAL_GUIDE's "## Available Tools" but not registered: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});

describe("docs drift: README vs the registered tools", () => {
  const readme = () => readFileSync(README, "utf-8");

  it("names every registered tool in the Tools section", () => {
    const listed = new Set(toolNamesInSection(readme(), "## Tools"));
    const missing = registeredTools().filter((t) => !listed.has(t));
    expect(
      missing,
      `registered but absent from README's "## Tools": ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("names no unregistered tool in the Tools section", () => {
    const registered = new Set(registeredTools());
    const stale = toolNamesInSection(readme(), "## Tools").filter((t) => !registered.has(t));
    expect(
      stale,
      `named in README's "## Tools" but not registered: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  // The count is prose, so nothing else can catch it going stale — and it is
  // the first thing a reader checks the list against.
  it("states the correct tool count", () => {
    const m = readme().match(/(\d+) tools organized/);
    expect(m, 'README must state "<N> tools organized by ..." in the Tools section').not.toBeNull();
    const count = registeredTools().length;
    expect(Number(m![1]), `README says ${m![1]} tools; ${count} are registered`).toBe(count);
  });
});
