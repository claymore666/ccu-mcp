import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:https";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate } from "node:crypto";
import { AddressInfo } from "node:net";
import { Logger } from "../../src/logger.js";
import { CcuClient } from "../../src/ccu/client.js";
import { CcuError } from "../../src/middleware/error-mapper.js";

// Issue #51: the CcuClient must actually verify the CCU's self-signed TLS cert
// when CCU_TLS_FINGERPRINT or CCU_CA_CERT is configured. This drives a real
// local HTTPS server (a self-signed cert minted with openssl) through the
// client's connector. Skipped if openssl isn't available.
const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

const logger = new Logger("error");

describe.skipIf(!HAVE_OPENSSL)("CcuClient TLS verification (real HTTPS server)", () => {
  let server: Server;
  let port: number;
  let certPem: string;
  let fingerprint: string;
  let tmpDir: string;

  const base = {
    host: "127.0.0.1",
    https: true,
    tlsVerify: false,
    user: "Admin",
    password: "pw",
    timeout: 5000,
    scriptTimeout: 30000,
  };

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ccu-tls-"));
    const certPath = join(tmpDir, "cert.pem");
    const keyPath = join(tmpDir, "key.pem");
    // SAN must carry IP:127.0.0.1 — Node (>=17) dropped subject-CN fallback, and
    // CA-cert mode (rejectUnauthorized:true) checks identity against the host.
    const gen = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=ccu",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
    if (gen.status !== 0) throw new Error("openssl failed to generate test cert");

    certPem = readFileSync(certPath, "utf-8");
    fingerprint = new X509Certificate(certPem).fingerprint256; // "AB:CD:.."

    server = createServer(
      { cert: certPem, key: readFileSync(keyPath) },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "1", version: "1.1", result: "ok", error: null }));
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      }),
    );
  });

  afterAll(() => {
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("connects when the pinned fingerprint matches", async () => {
    const client = new CcuClient({ ...base, port, tlsFingerprint: fingerprint }, logger);
    await expect(client.call("Test", {})).resolves.toBe("ok");
  });

  it("accepts a fingerprint written without colons", async () => {
    const client = new CcuClient(
      { ...base, port, tlsFingerprint: fingerprint.replace(/:/g, "") },
      logger,
    );
    await expect(client.call("Test", {})).resolves.toBe("ok");
  });

  // Regression: TLS session resumption returns an empty peer cert on a resumed
  // connection, which made fingerprint pinning reject those requests. One
  // awaited call caches the TLS session; the following concurrent burst then
  // opens fresh connections that would resume it. The client disables session
  // caching so every connection presents the cert and all calls verify.
  it("verifies the fingerprint on connections that would resume the TLS session", async () => {
    const client = new CcuClient({ ...base, port, tlsFingerprint: fingerprint }, logger);
    await client.call("Test", {}); // full handshake, caches the session
    const results = await Promise.all(Array.from({ length: 8 }, () => client.call("Test", {})));
    expect(results).toEqual(Array(8).fill("ok"));
  });

  it("refuses to connect when the pinned fingerprint does not match", async () => {
    const wrong = "00:".repeat(31) + "00";
    const client = new CcuClient({ ...base, port, tlsFingerprint: wrong }, logger);
    try {
      await client.call("Test", {});
      expect.unreachable("should have rejected the cert");
    } catch (err) {
      expect(err).toBeInstanceOf(CcuError);
      expect((err as CcuError).structured.error).toBe("UNREACHABLE");
    }
  });

  it("connects when the cert is trusted via caCert", async () => {
    const client = new CcuClient({ ...base, port, caCert: certPem }, logger);
    await expect(client.call("Test", {})).resolves.toBe("ok");
  });

  it("rejects an untrusted cert under caCert verification", async () => {
    // A different (unrelated) CA must not validate the server's cert.
    const otherDir = mkdtempSync(join(tmpdir(), "ccu-tls-other-"));
    const otherCert = join(otherDir, "cert.pem");
    spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(otherDir, "key.pem"), "-out", otherCert,
      "-days", "1", "-subj", "/CN=other", "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
    const client = new CcuClient(
      { ...base, port, caCert: readFileSync(otherCert, "utf-8") },
      logger,
    );
    try {
      await client.call("Test", {});
      expect.unreachable("should have rejected the untrusted cert");
    } catch (err) {
      expect(err).toBeInstanceOf(CcuError);
      expect((err as CcuError).structured.error).toBe("UNREACHABLE");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
