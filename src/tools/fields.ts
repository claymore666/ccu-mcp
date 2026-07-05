import { z } from "zod";

// Shared zod field definitions reused across tool modules so their descriptions
// stay identical (they previously drifted between copies).

// Optional per-call target override for read tools: route this one read to a
// named CCU without switching the active target (handy for prod-vs-dev compares).
export const targetField = z.string().optional()
  .describe("CCU target to read from (default: active). See list_ccu_targets.");

// Optional `confirm` field for write tools: required (true) to authorize a write
// against a `protected` CCU target (e.g. prod). Harmless on unprotected targets.
export const confirmField = z.boolean().optional()
  .describe("Set true to authorize this write against a protected CCU target (e.g. prod). Unlocks writes to that target for the rest of the session.");
