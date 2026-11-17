import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

import { loadConfig } from "../config.js";

let client: S3Client | null = null;

/** Reset cached client (for tests only). */
export function __resetR2ClientForTesting(): void {
  client = null;
}

export function getR2Client(): S3Client {
  if (!client) {
    const { r2 } = loadConfig();
    client = new S3Client({
      region: "auto",
      endpoint: r2.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
  }
  return client;
}

export async function copyObject(
  sourceKey: string,
  destKey: string,
  contentType: string
): Promise<void> {
  const c = getR2Client();
  const bucket = loadConfig().r2.bucket;
  await c.send(
    new CopyObjectCommand({
      CopySource: `/${bucket}/${sourceKey}`,
      Bucket: bucket,
      Key: destKey,
      MetadataDirective: "REPLACE",
      ContentType: contentType,
    })
  );
}

export async function deleteObject(key: string): Promise<void> {
  const c = getR2Client();
  await c.send(
    new DeleteObjectCommand({
      Bucket: loadConfig().r2.bucket,
      Key: key,
    })
  );
}

const MISSING_OBJECT_NAMES = new Set([
  "NotFound",
  "NoSuchKey",
  "NotFoundException",
]);

const ACCESS_DENIED_NAMES = new Set([
  "AccessDenied",
  "Forbidden",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "InvalidToken",
  "CredentialsProviderError",
]);

const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);

const NETWORK_NAMES = new Set(["NetworkingError"]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ENETUNREACH",
]);

export type StorageProbeFailure =
  "access_denied" | "timeout" | "network" | "unavailable";

export type StorageProbeResult =
  | { ok: true; probe: "present" | "missing" }
  | { ok: false; reason: StorageProbeFailure };

interface StorageErrorShape {
  name?: string;
  code?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

function storageErrorShape(error: unknown): StorageErrorShape {
  if (!error || typeof error !== "object") return {};
  const record = error as Record<string, unknown>;
  const metadata = record["$metadata"];
  const httpStatusCode =
    metadata &&
    typeof metadata === "object" &&
    "httpStatusCode" in metadata &&
    typeof metadata.httpStatusCode === "number"
      ? metadata.httpStatusCode
      : undefined;
  return {
    name: typeof record["name"] === "string" ? record["name"] : undefined,
    code: typeof record["code"] === "string" ? record["code"] : undefined,
    Code: typeof record["Code"] === "string" ? record["Code"] : undefined,
    ...(httpStatusCode === undefined ? {} : { $metadata: { httpStatusCode } }),
  };
}

/** A missing object is a successful storage response. Permission and network failures are not. */
export function isMissingObjectError(error: unknown): boolean {
  const shape = storageErrorShape(error);
  const name = shape.name ?? "";
  const code = String(shape.Code ?? shape.code ?? "");
  if (MISSING_OBJECT_NAMES.has(name)) return true;
  if (code === "NotFound" || code === "NoSuchKey" || code === "404")
    return true;
  return shape.$metadata?.httpStatusCode === 404;
}

/**
 * Classifies a storage failure without reading `error.message`.
 * SDK messages often include the bucket or key.
 */
export function classifyStorageProbeError(
  error: unknown
): StorageProbeFailure | "missing" {
  if (isMissingObjectError(error)) return "missing";
  const shape = storageErrorShape(error);
  const name = shape.name ?? "";
  const code = String(shape.code ?? shape.Code ?? "");
  const status = shape.$metadata?.httpStatusCode;
  if (status === 401 || status === 403 || ACCESS_DENIED_NAMES.has(name)) {
    return "access_denied";
  }
  if (TIMEOUT_NAMES.has(name) || code === "ABORT_ERR" || code === "ETIMEDOUT") {
    return "timeout";
  }
  if (NETWORK_NAMES.has(name) || NETWORK_CODES.has(code)) return "network";
  return "unavailable";
}

export async function headObject(
  key: string,
  options?: { timeoutMs?: number }
): Promise<{
  exists: boolean;
  contentType?: string;
  contentLength?: number;
}> {
  const c = getR2Client();
  const bucket = loadConfig().r2.bucket;
  const abortSignal = options?.timeoutMs
    ? AbortSignal.timeout(options.timeoutMs)
    : undefined;
  try {
    const out = await c.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
      abortSignal ? { abortSignal } : undefined
    );
    return {
      exists: true,
      contentType: out.ContentType,
      contentLength: out.ContentLength,
    };
  } catch (err: unknown) {
    if (isMissingObjectError(err)) return { exists: false };
    throw err;
  }
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

/**
 * Readiness probe. A missing `__readiness_probe__` object means R2 answered.
 * The check does not pass merely because NODE_ENV is test.
 */
export async function probeStorage(options?: {
  key?: string;
  timeoutMs?: number;
  head?: (
    key: string,
    headOptions?: { timeoutMs?: number }
  ) => Promise<{ exists: boolean }>;
}): Promise<StorageProbeResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const head = options?.head ?? headObject;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      head(options?.key ?? "__readiness_probe__", { timeoutMs }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("storage probe timed out");
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
    return { ok: true, probe: result.exists ? "present" : "missing" };
  } catch (error) {
    const reason = classifyStorageProbeError(error);
    if (reason === "missing") return { ok: true, probe: "missing" };
    return { ok: false, reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
