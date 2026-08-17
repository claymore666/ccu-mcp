import { readFileSync } from "node:fs";
import type { CcuConfig, CcuProfile } from "./ccu/types.js";

export interface AppConfig {
  /**
   * Connection details for the DEFAULT target. Kept as an alias of
   * `profiles[defaultProfile].ccu` for back-compat with code/tests that read
   * `config.ccu.*` (e.g. `scriptTimeout`). Prefer `profiles` for new code.
   */
  ccu: CcuConfig;
  /** All configured CCU targets (always ≥1; a flat config yields one `default`). */
  profiles: CcuProfile[];
  /** Name of the target active at startup. */
  defaultProfile: string;
  mcp: {
    transport: "http" | "stdio";
    port: number;
    authToken?: string;
    /**
     * Previous bearer token kept valid for the rotation overlap
     * (`MCP_AUTH_TOKEN_PREVIOUS`). Lets operators roll `MCP_AUTH_TOKEN` without
     * dropping clients still on the old token; remove it (and restart) to end
     * the overlap. Applies to the explicit-token path only.
     */
    authTokenPrevious?: string;
    /**
     * Lifetime of the AUTO-GENERATED bearer token in ms (`MCP_AUTH_TOKEN_TTL_DAYS`,
     * fractional days allowed). Unset ⇒ the generated token never expires (the
     * historical default). Does not apply to an explicit `MCP_AUTH_TOKEN`, which
     * the operator owns. The token auto-rotates AT RUNTIME shortly before
     * expiry (and on startup if it expired while the server was down).
     */
    authTokenTtlMs?: number;
    /**
     * Overlap after an auto-rotation during which the just-replaced token still
     * validates, so in-flight clients survive the swap (`MCP_AUTH_TOKEN_GRACE_HOURS`,
     * default 24).
     */
    authTokenGraceMs: number;
    /**
     * Default-deny origin allowlist for browser-based MCP clients. Empty ⇒ no
     * cross-origin browser access (the secure default). A request whose `Origin`
     * is on this list gets that exact origin reflected in
     * `Access-Control-Allow-Origin` (never `*`); the same list drives the
     * transport's DNS-rebinding `allowedOrigins` so CORS and rebinding
     * protection can't drift apart. Set via `MCP_ALLOWED_ORIGINS`
     * (comma-separated, e.g. `https://app.example,http://localhost:6274`).
     */
    allowedOrigins: string[];
    /**
     * Host-header allowlist for the StreamableHTTP transport's DNS-rebinding
     * protection. Defaults to localhost/127.0.0.1 on the MCP port; extend via
     * `MCP_ALLOWED_HOSTS` when the server is reached under another hostname.
     */
    allowedHosts: string[];
    /**
     * Optional bind address for the HTTP listener (`MCP_HOST`). Unset ⇒ bind
     * all interfaces (the unchanged default). Set to `127.0.0.1`/`::1` to
     * restrict the server to loopback (e.g. when a reverse proxy terminates TLS
     * in front), which also suppresses the plaintext warning.
     */
    host?: string;
    /**
     * Optional TLS cert/key paths (`MCP_TLS_CERT` / `MCP_TLS_KEY`). When BOTH
     * are set the server listens over HTTPS natively; otherwise it serves plain
     * HTTP (the zero-config default). Setting only one is a configuration error.
     */
    tlsCertPath?: string;
    tlsKeyPath?: string;
    /**
     * Acknowledge that serving over plain HTTP is intended
     * (`MCP_ALLOW_PLAINTEXT=true`). Silences the non-loopback plaintext warning
     * for operators who deliberately run without TLS (e.g. a trusted LAN).
     */
    allowPlaintext: boolean;
  };
  cache: {
    dir: string;
    ttl: number;
  };
  rateLimiter: {
    burst: number;
    rate: number;
  };
  resourcePollInterval: number;
}

/**
 * The env-var prefix a profile name maps to: `prod-a` → `PROD_A`, read as
 * `CCU_PROD_A_*`. Single definition — this was written out three times, once as
 * the actual prefix, once in the duplicate-detection loop, and once inside an
 * error message that had to agree with both (issue #124).
 */
function envPrefix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function loadConfig(): AppConfig {
  // CLI flags override env vars for transport. Validate the env value: a typo
  // ("STDIO", "Stdio") must fail loudly, not silently select HTTP and leave a
  // stdio-spawning client hanging forever.
  const args = process.argv.slice(2);
  const transportEnv = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  if (transportEnv && transportEnv !== "http" && transportEnv !== "stdio") {
    throw new Error(`MCP_TRANSPORT must be "http" or "stdio", got: "${process.env.MCP_TRANSPORT}"`);
  }
  let transport: "http" | "stdio" = (transportEnv as "http" | "stdio" | undefined) || "http";
  if (args.includes("--stdio")) transport = "stdio";
  if (args.includes("--http")) transport = "http";

  // Strict: the whole value must be a plain positive integer. parseInt() used to
  // do this and stopped at the first non-digit, so "30s" silently became 30 —
  // a 30 MILLISECOND CCU_TIMEOUT, whose every failure then looked like a slow
  // CCU rather than a config typo (issue #119). The units are documented only
  // in comments, so a "30s" is a natural thing to write.
  // Rejecting via regex rather than Number() also excludes forms Number()
  // accepts but nobody means here: hex ("0x10"), exponent ("1e4"), decimals.
  const parseIntEnv = (name: string, fallback: string): number => {
    // Unset or explicitly empty ("VAR=" in a compose file) means "use the
    // default", as before. Whitespace-only does NOT — it is a typo, and the old
    // parseInt(" ") → NaN rejected it. Trim only after that distinction.
    const raw = process.env[name];
    const source = raw === undefined || raw === "" ? fallback : raw.trim();
    if (!/^\d+$/.test(source) || !Number.isSafeInteger(Number(source)) || Number(source) <= 0) {
      throw new Error(`${name} must be a positive integer, got: "${process.env[name]}"`);
    }
    return Number(source);
  };

  // Booleans were compared as `process.env[name] === "true"` against the RAW value,
  // so a trailing space or CR made the setting silently false (issue #120).
  // For CCU_<P>_PROTECTED / _READONLY that failed OPEN — the production write
  // gate quietly disabled. Docker passes `environment:` values verbatim, and
  // docker-compose.yml documents exactly those variables, so this was reachable.
  // Garbage is rejected rather than read as false, matching MCP_TRANSPORT:
  // `CCU_PROD_PROTECTED=yes` must not mean "unprotected".
  const parseBoolEnv = (name: string): boolean => {
    const raw = process.env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === "") return false;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`${name} must be "true" or "false", got: "${process.env[name]}"`);
  };

  // Optional positive duration in `unitMs` units; fractional values allowed
  // (e.g. 0.5 days). Returns undefined when unset; throws on garbage so a
  // typo'd TTL fails loudly instead of silently disabling expiry.
  const parseDurationEnv = (name: string, unitMs: number): number | undefined => {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error(`${name} must be a positive number, got: "${process.env[name]}"`);
    }
    return Math.round(val * unitMs);
  };

  const mcpPort = parseIntEnv("MCP_PORT", "3000");
  // DNS-rebinding defense: the transport rejects any Host header not on this
  // list. localhost/127.0.0.1 on the bound port covers local use; deployments
  // reached under another hostname (reverse proxy, container DNS name) add it
  // via MCP_ALLOWED_HOSTS (comma-separated, "host:port").
  const allowedHosts = [
    `127.0.0.1:${mcpPort}`,
    `localhost:${mcpPort}`,
    // IPv6 loopback: a client connecting to http://[::1]:port sends the
    // bracketed literal in the Host header, and the SDK's check is an exact
    // string match — without this entry the documented MCP_HOST=::1 setup
    // would 403 every request.
    `[::1]:${mcpPort}`,
    ...(process.env.MCP_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  ];

  // Default-deny browser origin allowlist. Empty unless MCP_ALLOWED_ORIGINS is
  // set; it feeds both the reflective CORS headers and the transport's
  // DNS-rebinding Origin check (single source of truth).
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Native TLS for the HTTP transport is opt-in: set BOTH cert and key. Plain
  // HTTP stays the zero-config default (issue #50). Setting only one is almost
  // certainly a mistake, so fail loudly rather than silently serving plaintext.
  const tlsCertPath = process.env.MCP_TLS_CERT?.trim() || undefined;
  const tlsKeyPath = process.env.MCP_TLS_KEY?.trim() || undefined;
  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
    throw new Error("MCP_TLS_CERT and MCP_TLS_KEY must both be set (or both unset)");
  }

  // CCU TLS verification (issue #51). A CCU ships a self-signed cert, so verify
  // it either by pinning the leaf fingerprint or by trusting a CA/self-signed
  // PEM. Read the PEM here; the env var name is only for the error message
  // (don't interpolate the env-derived PATH into logs — js/clear-text-logging).
  const readCaCert = (envName: string, path: string | undefined): string | undefined => {
    if (!path) return undefined;
    try {
      return readFileSync(path, "utf-8");
    } catch (err) {
      throw new Error(`${envName} could not be read: ${(err as Error).message}`, { cause: err });
    }
  };

  // Build one named profile from CCU_<PREFIX>_* env vars (issue #69). These are
  // read DYNAMICALLY (template-literal keys), so the env-example-sync test's
  // literal scan doesn't see them — intentional; they're documented as comments
  // in .env.example. Password may be empty (OpenCCU dev boxes default to it).
  const buildProfile = (name: string): CcuProfile => {
    const p = envPrefix(name);
    const get = (suffix: string): string | undefined => process.env[`CCU_${p}_${suffix}`]?.trim() || undefined;
    const host = get("HOST");
    if (!host) throw new Error(`profile "${name}" is missing CCU_${p}_HOST`);
    const https = parseBoolEnv(`CCU_${p}_HTTPS`);
    return {
      name,
      protected: parseBoolEnv(`CCU_${p}_PROTECTED`),
      readonly: parseBoolEnv(`CCU_${p}_READONLY`),
      ccu: {
        host,
        port: parseIntEnv(`CCU_${p}_PORT`, https ? "443" : "80"),
        https,
        tlsVerify: parseBoolEnv(`CCU_${p}_TLS_VERIFY`),
        tlsFingerprint: get("TLS_FINGERPRINT"),
        caCert: readCaCert(`CCU_${p}_CA_CERT`, get("CA_CERT")),
        user: get("USER") || "Admin",
        password: process.env[`CCU_${p}_PASSWORD`] ?? "",
        timeout: parseIntEnv(`CCU_${p}_TIMEOUT`, "10000"),
        scriptTimeout: parseIntEnv(`CCU_${p}_SCRIPT_TIMEOUT`, "30000"),
      },
    };
  };

  const profilesEnv = process.env.CCU_PROFILES?.trim();
  let profiles: CcuProfile[];
  let defaultProfile: string;

  if (!profilesEnv) {
    // Back-compat: no CCU_PROFILES ⇒ one "default" profile from the flat
    // CCU_HOST/CCU_PASSWORD/... vars, with the exact validation as before.
    // A leftover CCU_DEFAULT_PROFILE would be silently meaningless here — and
    // writes would target the flat CCU_HOST box while the env file suggests a
    // named profile — so fail loudly like every other config typo.
    if (process.env.CCU_DEFAULT_PROFILE?.trim()) {
      throw new Error(
        "CCU_DEFAULT_PROFILE is set but CCU_PROFILES is not — either define CCU_PROFILES or remove CCU_DEFAULT_PROFILE",
      );
    }
    const host = process.env.CCU_HOST;
    if (!host) throw new Error("CCU_HOST environment variable is required");
    const password = process.env.CCU_PASSWORD;
    if (!password) throw new Error("CCU_PASSWORD environment variable is required");
    const flatHttps = parseBoolEnv("CCU_HTTPS");
    profiles = [{
      name: "default",
      protected: false,
      readonly: false,
      isFlat: true,
      ccu: {
        host,
        port: parseIntEnv("CCU_PORT", flatHttps ? "443" : "80"),
        https: flatHttps,
        tlsVerify: parseBoolEnv("CCU_TLS_VERIFY"),
        tlsFingerprint: process.env.CCU_TLS_FINGERPRINT?.trim() || undefined,
        caCert: readCaCert("CCU_CA_CERT", process.env.CCU_CA_CERT?.trim() || undefined),
        user: process.env.CCU_USER || "Admin",
        password,
        timeout: parseIntEnv("CCU_TIMEOUT", "10000"),
        scriptTimeout: parseIntEnv("CCU_SCRIPT_TIMEOUT", "30000"),
      },
    }];
    defaultProfile = "default";
  } else {
    const names = profilesEnv.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) throw new Error("CCU_PROFILES is set but lists no profile names");
    const seen = new Set<string>();
    // Distinct names can still collide on the sanitized env prefix
    // ("prod-a" and "prod.a" both read CCU_PROD_A_*), which would silently
    // configure two "different" targets from the same variables.
    const seenPrefix = new Map<string, string>();
    for (const n of names) {
      const key = n.toLowerCase();
      if (seen.has(key)) throw new Error(`CCU_PROFILES lists "${n}" more than once`);
      seen.add(key);
      const prefix = envPrefix(n);
      const clash = seenPrefix.get(prefix);
      if (clash) {
        throw new Error(
          `CCU_PROFILES names "${clash}" and "${n}" both map to the same env prefix CCU_${prefix}_* — rename one`,
        );
      }
      seenPrefix.set(prefix, n);
    }
    profiles = names.map(buildProfile);
    const requested = process.env.CCU_DEFAULT_PROFILE?.trim();
    const match = requested
      ? profiles.find((p) => p.name.toLowerCase() === requested.toLowerCase())
      : profiles[0];
    if (!match) {
      throw new Error(`CCU_DEFAULT_PROFILE="${requested}" is not one of CCU_PROFILES (${names.join(", ")})`);
    }
    defaultProfile = match.name;
  }

  // TLS settings on a plain-HTTP target are a contradiction: the pinning /
  // verification code path is only built for HTTPS, so the operator would
  // believe the connection is verified while credentials travel in cleartext.
  // Fail fast instead of silently ignoring the settings.
  for (const p of profiles) {
    if (!p.ccu.https && (p.ccu.tlsFingerprint || p.ccu.caCert || p.ccu.tlsVerify)) {
      // `isFlat`, not `name === "default"`: CCU_PROFILES=default,dev is legal
      // and yields a profile genuinely NAMED "default" that reads
      // CCU_DEFAULT_HTTPS. Keying off the name told that operator to set
      // CCU_HTTPS, which the profile path never reads — following the hint
      // would not clear the error (issue #124).
      const httpsVar = p.isFlat ? "CCU_HTTPS" : `CCU_${envPrefix(p.name)}_HTTPS`;
      throw new Error(
        `CCU profile "${p.name}": TLS_FINGERPRINT/CA_CERT/TLS_VERIFY is set but HTTPS is disabled — ` +
        `these settings only apply over HTTPS. Set ${httpsVar}=true or remove them.`,
      );
    }
  }

  const defaultCcu = profiles.find((p) => p.name === defaultProfile)!.ccu;

  return {
    ccu: defaultCcu,
    profiles,
    defaultProfile,
    mcp: {
      transport,
      port: mcpPort,
      // trim: a trailing space/CR (CRLF env file, quoted systemd Environment=)
      // would otherwise be hashed into the expected token and 401 every client;
      // MCP_AUTH_TOKEN_PREVIOUS and file-parsed tokens are already trimmed.
      authToken: process.env.MCP_AUTH_TOKEN?.trim() || undefined,
      authTokenPrevious: process.env.MCP_AUTH_TOKEN_PREVIOUS?.trim() || undefined,
      authTokenTtlMs: parseDurationEnv("MCP_AUTH_TOKEN_TTL_DAYS", 86_400_000),
      authTokenGraceMs: parseDurationEnv("MCP_AUTH_TOKEN_GRACE_HOURS", 3_600_000) ?? 24 * 3_600_000,
      allowedOrigins,
      allowedHosts,
      host: process.env.MCP_HOST?.trim() || undefined,
      tlsCertPath,
      tlsKeyPath,
      allowPlaintext: parseBoolEnv("MCP_ALLOW_PLAINTEXT"),
    },
    cache: {
      dir: process.env.CACHE_DIR || "/data",
      ttl: parseIntEnv("CACHE_TTL", "86400"),
    },
    rateLimiter: {
      burst: parseIntEnv("CCU_RATE_LIMIT_BURST", "20"),
      rate: parseIntEnv("CCU_RATE_LIMIT_RATE", "10"),
    },
    resourcePollInterval: parseIntEnv("RESOURCE_POLL_INTERVAL", "60"),
  };
}
