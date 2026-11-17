import { beforeEach, describe, it, expect, vi } from "vitest";

import { resetConfig } from "../../src/config.js";
import * as storage from "../../src/services/storage.js";

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client {
    send = mockSend;
  },
  CopyObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  DeleteObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  HeadObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

describe("storage", () => {
  beforeEach(() => {
    process.env["SFS_UPLOAD_TOKEN_SECRET"] = "test-secret";
    process.env["R2_BUCKET"] = "test-bucket";
    process.env["R2_ENDPOINT"] = "https://test.r2.dev";
    process.env["R2_ACCESS_KEY_ID"] = "test-key";
    process.env["R2_SECRET_ACCESS_KEY"] = "test-secret";
    process.env["DB_PATH"] = "/tmp/blossom-storage-test";
    resetConfig();
    storage.__resetR2ClientForTesting();
    mockSend.mockReset();
  });

  describe("headObject", () => {
    it("returns exists true when HeadObject succeeds", async () => {
      mockSend.mockResolvedValueOnce({
        ContentType: "image/jpeg",
        ContentLength: 1234,
      });
      const result = await storage.headObject("abc.jpg");
      expect(result).toEqual({
        exists: true,
        contentType: "image/jpeg",
        contentLength: 1234,
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("returns exists false when NotFound", async () => {
      mockSend.mockRejectedValueOnce({ name: "NotFound" });
      const result = await storage.headObject("missing");
      expect(result).toEqual({ exists: false });
    });

    it("returns exists false when NoSuchKey", async () => {
      mockSend.mockRejectedValueOnce({ name: "NoSuchKey" });
      const result = await storage.headObject("missing");
      expect(result).toEqual({ exists: false });
    });

    it("returns exists false when R2 answers 404 without a NotFound name", async () => {
      const error = new Error("bucket and key omitted");
      error.name = "Unknown";
      Object.assign(error, { $metadata: { httpStatusCode: 404 } });
      mockSend.mockRejectedValueOnce(error);
      const result = await storage.headObject("missing");
      expect(result).toEqual({ exists: false });
    });

    it("rethrows authorization errors", async () => {
      const error = new Error("denied");
      error.name = "AccessDenied";
      Object.assign(error, { $metadata: { httpStatusCode: 403 } });
      mockSend.mockRejectedValueOnce(error);
      await expect(storage.headObject("k")).rejects.toThrow("denied");
    });

    it("rethrows other errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("network"));
      await expect(storage.headObject("k")).rejects.toThrow("network");
    });
  });

  describe("probeStorage", () => {
    it("treats a missing probe object as healthy storage", async () => {
      const result = await storage.probeStorage({
        head: async () => ({ exists: false }),
      });
      expect(result).toEqual({ ok: true, probe: "missing" });
    });

    it("treats a present probe object as healthy storage", async () => {
      const result = await storage.probeStorage({
        head: async () => ({ exists: true }),
      });
      expect(result).toEqual({ ok: true, probe: "present" });
    });

    it("reports access denied without calling the object present", async () => {
      const error = new Error("secret-looking message");
      error.name = "AccessDenied";
      const result = await storage.probeStorage({
        head: async () => {
          throw error;
        },
      });
      expect(result).toEqual({ ok: false, reason: "access_denied" });
    });

    it("reports a hung storage call as a timeout", async () => {
      const result = await storage.probeStorage({
        timeoutMs: 20,
        head: () => new Promise(() => undefined),
      });
      expect(result).toEqual({ ok: false, reason: "timeout" });
    });

    it("reports a refused connection as a network failure", async () => {
      const error = Object.assign(new Error("refused"), {
        code: "ECONNREFUSED",
      });
      const result = await storage.probeStorage({
        head: async () => {
          throw error;
        },
      });
      expect(result).toEqual({ ok: false, reason: "network" });
    });
  });

  describe("copyObject", () => {
    it("calls send with CopySource, Bucket, Key, ContentType", async () => {
      mockSend.mockResolvedValueOnce({});
      await storage.copyObject("src.temp", "dest.jpg", "image/jpeg");
      const call = mockSend.mock.calls[0];
      expect(call).toBeDefined();
      type SentCommand = { input?: Record<string, unknown> };
      const cmd: SentCommand | undefined = call?.[0] as SentCommand | undefined;
      // toMatchObject with expect.stringContaining triggers no-unsafe-assignment
      expect(cmd?.input).toMatchObject({
        Bucket: "test-bucket",
        Key: "dest.jpg",
        ContentType: "image/jpeg",
        MetadataDirective: "REPLACE",
      });
      expect(String(cmd?.input?.["CopySource"])).toContain("src.temp");
    });
  });

  describe("deleteObject", () => {
    it("calls send with Bucket and Key", async () => {
      mockSend.mockResolvedValueOnce({});
      await storage.deleteObject("key.to.delete");
      const call = mockSend.mock.calls[0];
      expect(call).toBeDefined();
      type SentCommand = { input?: Record<string, unknown> };
      const cmd: SentCommand | undefined = call?.[0] as SentCommand | undefined;
      expect(cmd?.input).toMatchObject({
        Bucket: "test-bucket",
        Key: "key.to.delete",
      });
    });
  });
});
