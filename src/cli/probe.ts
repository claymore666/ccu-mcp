import { connect as tlsConnect } from "node:tls";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { CcuClient, normalizeFingerprint } from "../ccu/client.js";
import { SessionManager } from "../ccu/session.js";
import { CcuError } from "../middleware/error-mapper.js";
import type { CcuConfig, StructuredError } from "../ccu/types.js";
import { Logger } from "../logger.js";

/**
 * The wizard talks to the user on stdout itself; the structured JSON logger
 * the client/session classes expect would only interleave noise. Expected
 * failures (unreachable probe, wrong password) are reported by the wizard.
 */
class SilentLogger extends Logger {
  override error(): void {}
  override warn(): void {}
  override info(): void {}
  override debug(): void {}
}

export const silentLogger: Logger = new SilentLogger();

/** A CcuConfig for probing: no TLS verification, short timeout. */
export function probeConfig(host: string, port: number, https: boolean, timeout = 5000): CcuConfig {
  return {
    host,
    port,
    https,
    tlsVerify: false,
    user: "",
    password: "",
    timeout,
    scriptTimeout: 30_000,
  };
}

export type ProbeKind = "ccu" | "not-ccu" | "tls" | "timeout" | "unreachable";

export interface ProbeOutcome {
  kind: ProbeKind;
  detail: string;
}

/**
 * Classify what answers at ${host}:${port}/api/homematic.cgi. Sends a bogus
 * JSON-RPC method: a CCU replies with a JSON-RPC error envelope (proof of the
 * API without needing credentials); anything else is classified by how it
 * fails. TLS settings on `ccu` are ignored — reachability is the question
 * here, pin verification is the doctor's separate check.
 */
export async function probeApi(ccu: CcuConfig): Promise<ProbeOutcome> {
  const client = new CcuClient(
    { ...ccu, tlsFingerprint: undefined, caCert: undefined, tlsVerify: false },
    silentLogger,
  );
  try {
    await client.call("CCU.probe", {}, ccu.timeout);
    return { kind: "ccu", detail: "JSON-RPC endpoint answered" };
  } catch (err) {
    if (!(err instanceof CcuError)) throw err;
    const s = err.structured;
    if (s.error === "TIMEOUT") return { kind: "timeout", detail: s.message };
    if (s.error === "TLS_ERROR") return { kind: "tls", detail: s.message };
    if (s.error === "UNREACHABLE") return { kind: "unreachable", detail: s.message };
    if (s.message.includes("Invalid JSON response") || s.message.includes("no JSON-RPC error in body")) {
      return { kind: "not-ccu", detail: s.message };
    }
    // The endpoint answered with a JSON-RPC error envelope — it IS a CCU API.
    return { kind: "ccu", detail: s.message };
  }
}

export interface CertInfo {
  /** SHA-256 fingerprint as Node reports it: colon-separated uppercase hex. */
  fingerprint256: string;
  subjectCN?: string;
  issuerCN?: string;
  validFrom?: string;
  validTo?: string;
}

/**
 * Fetch the peer certificate without verifying it — the whole point is to
 * show the operator what the CCU presents so they can decide to pin it.
 */
export function fetchCert(host: string, port: number, timeoutMs = 5000): Promise<CertInfo> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      rejectUnauthorized: false,
      // SNI must be a hostname; tls.connect throws on an IP literal.
      ...(isIP(host) === 0 ? { servername: host } : {}),
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert || !cert.fingerprint256) {
        reject(new Error("Peer presented no certificate"));
        return;
      }
      // subject/issuer CN can be a string array for multi-valued RDNs.
      const first = (v: string | string[] | undefined): string | undefined =>
        Array.isArray(v) ? v[0] : v;
      resolve({
        fingerprint256: cert.fingerprint256,
        subjectCN: first(cert.subject?.CN),
        issuerCN: first(cert.issuer?.CN),
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
      });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

/** True when the presented fingerprint matches the pinned one (colon/case-insensitive). */
export function fingerprintMatches(pinned: string, presented: string): boolean {
  return normalizeFingerprint(pinned) === normalizeFingerprint(presented);
}

export type CcuRole = "ADMIN" | "USER" | "UNKNOWN";

export type LoginResult =
  | { ok: true; role: CcuRole; version?: string }
  | { ok: false; error: StructuredError };

/**
 * Log in with the profile's real TLS settings, detect the privilege level,
 * log out again. Role detection is the same capability probe get_system_info
 * uses: `CCU.getVersion` is ADMIN-only per the OCCU method table, so a result
 * means ADMIN and an access denial means USER.
 */
export async function testLogin(ccu: CcuConfig): Promise<LoginResult> {
  // Unique throwaway session file: never touch (or restore) the running
  // server's persisted session, and leave nothing behind — logout clears it.
  const sessionFile = `ccu-mcp-cli-${process.pid}-${Date.now()}.json`;
  const session = new SessionManager(ccu, silentLogger, tmpdir(), sessionFile);
  try {
    await session.login();
  } catch (err) {
    if (err instanceof CcuError) return { ok: false, error: err.structured };
    throw err;
  }
  try {
    const version = await session.call("CCU.getVersion");
    if (typeof version === "string" && version !== "") {
      return { ok: true, role: "ADMIN", version };
    }
    return { ok: true, role: "USER" };
  } catch (err) {
    if (err instanceof CcuError && err.structured.error === "AUTH") {
      return { ok: true, role: "USER" };
    }
    // Login itself worked; the role probe failed for some other reason.
    return { ok: true, role: "UNKNOWN" };
  } finally {
    await session.logout();
  }
}
