import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  probeApi,
  probeConfig,
  fetchCert,
  fingerprintMatches,
  testLogin,
} from "../../src/cli/probe.js";
import { startMockCcu, startMockCcuTls, adminResults, type MockCcu } from "./_mock-ccu.js";

const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

describe("probeApi", () => {
  it("classifies a JSON-RPC error envelope as a CCU", async () => {
    const mock = await startMockCcu(); // every method -> error envelope
    try {
      const outcome = await probeApi(probeConfig("127.0.0.1", mock.port, false));
      expect(outcome.kind).toBe("ccu");
    } finally {
      await mock.close();
    }
  });

  it("classifies a non-JSON-RPC HTTP server as not-ccu", async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>hello</html>");
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
    try {
      const outcome = await probeApi(probeConfig("127.0.0.1", port, false));
      expect(outcome.kind).toBe("not-ccu");
    } finally {
      server.close();
    }
  });

  it("classifies a closed port as unreachable", async () => {
    // Grab an ephemeral port and free it again — nothing listens there now.
    const server: Server = createServer(() => {});
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const outcome = await probeApi(probeConfig("127.0.0.1", port, false));
    expect(outcome.kind).toBe("unreachable");
  });
});

describe("testLogin", () => {
  let mock: MockCcu;

  afterAll(async () => {
    await mock?.close();
  });

  it("reports ADMIN when the capability probe answers", async () => {
    mock = await startMockCcu(adminResults());
    const result = await testLogin({ ...probeConfig("127.0.0.1", mock.port, false), user: "Admin", password: "pw" });
    expect(result).toMatchObject({ ok: true, role: "ADMIN", version: "3.85.7-mock" });
    // The probe must clean up after itself: the session it minted is logged out.
    expect(mock.calls).toContain("Session.logout");
    await mock.close();
  });

  it("reports USER when the ADMIN-only probe is denied", async () => {
    // Code 400 is the CCU's "access denied"; with the session still valid the
    // session manager surfaces it as a privilege denial, which means USER.
    mock = await startMockCcu({
      ...adminResults(),
      "CCU.getVersion": { __error: { code: 400, message: "access denied" } },
    });
    const result = await testLogin({ ...probeConfig("127.0.0.1", mock.port, false), user: "claude", password: "pw" });
    expect(result).toMatchObject({ ok: true, role: "USER" });
    await mock.close();
  });

  it("reports UNKNOWN when the probe fails for a non-privilege reason", async () => {
    mock = await startMockCcu({
      ...adminResults(),
      "CCU.getVersion": { __error: { code: 501, message: "internal error" } },
    });
    const result = await testLogin({ ...probeConfig("127.0.0.1", mock.port, false), user: "Admin", password: "pw" });
    expect(result).toMatchObject({ ok: true, role: "UNKNOWN" });
    await mock.close();
  });

  it("returns the structured error when login fails", async () => {
    mock = await startMockCcu({
      ...adminResults(),
      "Session.login": { __error: { code: 400, message: "access denied" } },
    });
    const result = await testLogin({ ...probeConfig("127.0.0.1", mock.port, false), user: "Admin", password: "wrong" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("AUTH");
    await mock.close();
  });
});

describe.skipIf(!HAVE_OPENSSL)("fetchCert (real HTTPS server)", () => {
  let mock: MockCcu;
  let fingerprint: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-probe-tls-"));
    const certPath = join(tmpDir, "cert.pem");
    const keyPath = join(tmpDir, "key.pem");
    const gen = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=ccu-test",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
    if (gen.status !== 0) throw new Error("openssl failed to generate test cert");
    const certPem = readFileSync(certPath, "utf-8");
    fingerprint = new X509Certificate(certPem).fingerprint256;
    mock = await startMockCcuTls({ cert: certPem, key: readFileSync(keyPath, "utf-8") }, adminResults());
  });

  afterAll(async () => {
    await mock?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the certificate's SHA-256 fingerprint and subject", async () => {
    const cert = await fetchCert("127.0.0.1", mock.port);
    expect(fingerprintMatches(cert.fingerprint256, fingerprint)).toBe(true);
    expect(cert.subjectCN).toBe("ccu-test");
  });

  it("fingerprintMatches is colon- and case-insensitive", () => {
    expect(fingerprintMatches(fingerprint.replace(/:/g, "").toLowerCase(), fingerprint)).toBe(true);
    expect(fingerprintMatches("00".repeat(32), fingerprint)).toBe(false);
  });

  it("probes and logs in over HTTPS with a pinned fingerprint", async () => {
    const config = {
      ...probeConfig("127.0.0.1", mock.port, true),
      tlsFingerprint: fingerprint,
      user: "Admin",
      password: "pw",
    };
    expect((await probeApi(config)).kind).toBe("ccu");
    const result = await testLogin(config);
    expect(result).toMatchObject({ ok: true, role: "ADMIN" });
  });

  it("rejects on a connection that is not TLS", async () => {
    const plain = await startMockCcu();
    try {
      await expect(fetchCert("127.0.0.1", plain.port, 2000)).rejects.toThrow();
    } finally {
      await plain.close();
    }
  });
});
