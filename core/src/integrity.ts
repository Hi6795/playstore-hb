import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { constantTimeHashEqual } from "./catalog.js";

export interface IntegrityResult { ok: boolean; actualSize: number; actualSha256: string; reason?: "SIZE_MISMATCH" | "HASH_MISMATCH" }
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk)); stream.once("end", resolve); stream.once("error", reject);
  });
  return hash.digest("hex");
}
export async function verifyPackage(path: string, expectedSize: number, expectedSha256: string): Promise<IntegrityResult> {
  const actualSize = (await stat(path)).size;
  if (actualSize !== expectedSize) return { ok: false, actualSize, actualSha256: "", reason: "SIZE_MISMATCH" };
  const actualSha256 = await sha256File(path);
  return constantTimeHashEqual(actualSha256, expectedSha256)
    ? { ok: true, actualSize, actualSha256 }
    : { ok: false, actualSize, actualSha256, reason: "HASH_MISMATCH" };
}
