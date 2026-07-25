import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { MultipartStorage, UploadPart } from "./uploads.js";

export interface S3MultipartStorageOptions {
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  allowInsecureHttp?: boolean;
  sessionToken?: string;
  serverSideEncryption?: "AES256" | "aws:kms";
  kmsKeyId?: string;
}

export class S3MultipartStorage implements MultipartStorage {
  private readonly client: S3Client;

  constructor(private readonly options: S3MultipartStorageOptions) {
    if (options.endpoint) {
      const endpoint = new URL(options.endpoint);
      if (
        endpoint.protocol !== "https:" &&
        endpoint.hostname !== "localhost" &&
        endpoint.hostname !== "127.0.0.1" &&
        !options.allowInsecureHttp
      ) {
        throw new Error(
          "S3_ENDPOINT must use HTTPS unless insecure HTTP is explicitly enabled for development"
        );
      }
    }
    if (options.serverSideEncryption === "aws:kms" && !options.kmsKeyId) {
      throw new Error("S3_KMS_KEY_ID is required when aws:kms encryption is enabled");
    }
    if (Boolean(options.accessKeyId) !== Boolean(options.secretAccessKey)) {
      throw new Error("S3 access key id and secret access key must be provided together");
    }
    this.client = new S3Client({
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? false,
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
              ...(options.sessionToken ? { sessionToken: options.sessionToken } : {})
            }
          }
        : {})
    });
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): S3MultipartStorage {
    const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
    const serverSideEncryption = environment.S3_SERVER_SIDE_ENCRYPTION;
    if (
      serverSideEncryption !== undefined &&
      serverSideEncryption !== "AES256" &&
      serverSideEncryption !== "aws:kms"
    ) {
      throw new Error("S3_SERVER_SIDE_ENCRYPTION must be AES256 or aws:kms");
    }
    return new S3MultipartStorage({
      ...(environment.S3_ENDPOINT ? { endpoint: environment.S3_ENDPOINT } : {}),
      region: environment.S3_REGION?.trim() || "us-east-1",
      ...(accessKeyId ? { accessKeyId } : {}),
      ...(secretAccessKey ? { secretAccessKey } : {}),
      forcePathStyle: parseBoolean(environment.S3_FORCE_PATH_STYLE, false),
      allowInsecureHttp: parseBoolean(environment.S3_ALLOW_INSECURE_HTTP, false),
      ...(environment.S3_SESSION_TOKEN ? { sessionToken: environment.S3_SESSION_TOKEN } : {}),
      ...(serverSideEncryption ? { serverSideEncryption } : {}),
      ...(environment.S3_KMS_KEY_ID ? { kmsKeyId: environment.S3_KMS_KEY_ID } : {})
    });
  }

  async initiate(input: {
    bucket: string;
    objectKey: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<{ providerUploadId: string }> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
        Metadata: input.metadata,
        ...(this.options.serverSideEncryption
          ? { ServerSideEncryption: this.options.serverSideEncryption }
          : {}),
        ...(this.options.kmsKeyId ? { SSEKMSKeyId: this.options.kmsKeyId } : {})
      })
    );
    if (!response.UploadId) throw new Error("Object storage did not return a multipart upload id");
    return { providerUploadId: response.UploadId };
  }

  async presignPart(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<{ url: string; requiredHeaders: Record<string, string> }> {
    const command = new UploadPartCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      UploadId: input.providerUploadId,
      PartNumber: input.partNumber
    });
    return {
      url: await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds }),
      requiredHeaders: {}
    };
  }

  async listParts(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
  }): Promise<UploadPart[]> {
    const parts: UploadPart[] = [];
    let partNumberMarker: string | undefined;
    do {
      const response = await this.client.send(
        new ListPartsCommand({
          Bucket: input.bucket,
          Key: input.objectKey,
          UploadId: input.providerUploadId,
          ...(partNumberMarker ? { PartNumberMarker: partNumberMarker } : {})
        })
      );
      for (const part of response.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          part.ETag === undefined ||
          part.Size === undefined
        ) {
          throw new Error("Object storage returned incomplete multipart part metadata");
        }
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          sizeBytes: part.Size,
          uploadedAt: (part.LastModified ?? new Date(0)).toISOString()
        });
      }
      partNumberMarker = response.IsTruncated
        ? String(response.NextPartNumberMarker ?? "")
        : undefined;
      if (response.IsTruncated && !partNumberMarker) {
        throw new Error("Object storage returned a truncated part list without a marker");
      }
    } while (partNumberMarker);
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async complete(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    const parts: CompletedPart[] = input.parts.map((part) => ({
      ETag: part.etag,
      PartNumber: part.partNumber
    }));
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.objectKey,
        UploadId: input.providerUploadId,
        MultipartUpload: { Parts: parts }
      })
    );
  }

  async abort(input: {
    bucket: string;
    objectKey: string;
    providerUploadId: string;
  }): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.objectKey,
        UploadId: input.providerUploadId
      })
    );
  }

  async headObject(input: {
    bucket: string;
    objectKey: string;
  }): Promise<{ sizeBytes: number; etag?: string }> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: input.bucket, Key: input.objectKey })
    );
    if (response.ContentLength === undefined) {
      throw new Error("Object storage did not return Content-Length");
    }
    return {
      sizeBytes: response.ContentLength,
      ...(response.ETag ? { etag: response.ETag } : {})
    };
  }

  async deleteObject(input: { bucket: string; objectKey: string }): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: input.bucket, Key: input.objectKey })
    );
  }

  async checkBucket(bucket: string, timeoutMs = 3_000): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }), {
        abortSignal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("S3_FORCE_PATH_STYLE must be true or false");
}
