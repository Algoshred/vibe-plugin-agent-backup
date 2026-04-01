import {
  S3Client, PutObjectCommand, GetObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command, HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync } from "node:fs";
import type { CustomS3Config, StorageTarget } from "../types.js";

export class CustomS3StorageTarget implements StorageTarget {
  private client: S3Client;
  private bucket: string;
  private pathPrefix: string;

  constructor(config: CustomS3Config) {
    this.bucket = config.bucket;
    this.pathPrefix = config.pathPrefix ?? "";
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: config.forcePathStyle ?? !!config.endpoint,
    });
  }

  private getKey(agentName: string, timestamp: string): string {
    const prefix = this.pathPrefix ? `${this.pathPrefix.replace(/\/+$/, "")}/` : "";
    return `${prefix}vibecontrols/agents/${agentName}/agent-${timestamp}.db`;
  }

  private getAgentPrefix(agentName: string): string {
    const prefix = this.pathPrefix ? `${this.pathPrefix.replace(/\/+$/, "")}/` : "";
    return `${prefix}vibecontrols/agents/${agentName}/`;
  }

  async upload(filePath: string, agentName: string, timestamp: string): Promise<{ storagePath: string }> {
    const key = this.getKey(agentName, timestamp);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: readFileSync(filePath),
      ContentType: "application/x-sqlite3",
      Metadata: { "agent-name": agentName, "backup-timestamp": timestamp },
    }));
    return { storagePath: key };
  }

  async download(storagePath: string, targetPath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storagePath }));
    if (!response.Body) throw new Error(`Empty response body for key: ${storagePath}`);
    writeFileSync(targetPath, await response.Body.transformToByteArray());
  }

  async delete(storagePath: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storagePath }));
  }

  async list(agentName: string): Promise<Array<{ path: string; size: number; lastModified: string }>> {
    const prefix = this.getAgentPrefix(agentName);
    const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }));
    return (response.Contents ?? [])
      .filter((obj) => obj.Key?.endsWith(".db"))
      .map((obj) => ({ path: obj.Key!, size: obj.Size ?? 0, lastModified: obj.LastModified?.toISOString() ?? "" }))
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, message: `Connected to bucket: ${this.bucket}` };
    } catch (err) {
      return { ok: false, message: `Failed to connect: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
