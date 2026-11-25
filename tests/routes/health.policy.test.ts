import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { resetConfig } from "../../src/config.js";
import { createHealthRouter } from "../../src/routes/health.js";

function requiredEnv(): void {
  process.env["DB_PATH"] = "/tmp/blossom-health-policy";
  process.env["R2_BUCKET"] = "test-bucket";
  process.env["R2_ENDPOINT"] = "https://test.r2.dev";
  process.env["R2_ACCESS_KEY_ID"] = "test-key";
  process.env["R2_SECRET_ACCESS_KEY"] = "test-secret";
  process.env["SFS_UPLOAD_TOKEN_SECRET"] = "upload-secret";
  process.env["SFS_INTERNAL_SECRET"] = "internal-secret";
}

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing policy server address");
      }
      resolve(address);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function readyApp() {
  const app = express();
  (
    app as unknown as {
      db: {
        ping: () => boolean;
        countRetryableUncommitted: () => number;
        countDeadLetterUncommitted: () => number;
      };
    }
  ).db = {
    ping: () => true,
    countRetryableUncommitted: () => 0,
    countDeadLetterUncommitted: () => 0,
  };
  app.use(
    createHealthRouter(app as never, {
      probeStorage: async () => ({ ok: true, probe: "missing" }),
    })
  );
  return app;
}

async function withGateway(
  app: express.Application,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing gateway address");
    }
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

describe("readiness policy probe", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    resetConfig();
    await Promise.all(servers.splice(0).map((server) => close(server)));
  });

  it("accepts a policy endpoint that fails once and then answers", async () => {
    const statuses: number[] = [];
    const urls: string[] = [];
    const policy = createServer((req, res) => {
      urls.push(req.url ?? "");
      const status = statuses.length === 0 ? 503 : 200;
      statuses.push(status);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? '{"ok":true}' : "{}");
    });
    servers.push(policy);
    const address = await listen(policy);
    requiredEnv();
    process.env["SFS_POLICY_URL"] =
      `http://127.0.0.1:${address.port}/internal/blossom/policy`;
    resetConfig();

    await withGateway(readyApp(), async (baseUrl) => {
      const ready = await fetch(`${baseUrl}/ready`);
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as { checks: { policy: string } };
      expect(body.checks.policy).toBe("ok");
    });
    expect(statuses).toEqual([503, 200]);
    expect(urls.every((url) => url.includes("pubkey=readiness_probe"))).toBe(
      true
    );
  });

  it("reports policy unavailable after the shared retry budget is spent", async () => {
    let calls = 0;
    const policy = createServer((_req, res) => {
      calls += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end("{}");
    });
    servers.push(policy);
    const address = await listen(policy);
    requiredEnv();
    process.env["SFS_POLICY_URL"] =
      `http://127.0.0.1:${address.port}/internal/blossom/policy`;
    resetConfig();

    await withGateway(readyApp(), async (baseUrl) => {
      const ready = await fetch(`${baseUrl}/ready`);
      expect(ready.status).toBe(503);
      const body = (await ready.json()) as {
        status: string;
        checks: { policy: string; storage: boolean };
      };
      expect(body.status).toBe("not_ready");
      expect(body.checks.policy).toBe("unavailable");
      expect(body.checks.storage).toBe(true);
    });
    expect(calls).toBe(3);
  });
});
