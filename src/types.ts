/**
 * Type declarations for vibe-plugin-agent-backup.
 *
 * Plugin contract / host service / capability types come from
 * @vibecontrols/plugin-sdk — do NOT redeclare them locally.
 */

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";

// ── Agent-specific host surface extension ───────────────────────────────
//
// The SDK's HostServices is the structural minimum every plugin can rely on.
// This plugin uses richer agent-specific surface (storage.list returning
// StorageEntry[], synchronous getConfig, workspaceQuery, isGatewayConfigured,
// getAgentRecordId, getWorkspaceId) that the SDK contract intentionally
// keeps loose. We type these as a local extension; this is NOT a
// redeclaration of any SDK type — it's an augmentation for what the plugin
// reaches for at runtime against the vibecontrols-agent host.

export interface StorageEntry {
  key: string;
  value: string;
  updatedAt?: string;
}

/**
 * Agent's runtime storage provider — string-valued, with rich `list()`
 * returning `StorageEntry[]`. The SDK's `StorageProvider` is a structural
 * subset (generic-typed values, optional `list` returning `string[]`); we
 * use the agent shape directly here because the plugin reads/writes
 * stringified JSON via `TypedStore`, and `listBackups()` needs the rich
 * key+value entries. This is NOT a redeclaration of an SDK type.
 */
export interface AgentStorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  list(namespace: string): Promise<StorageEntry[]>;
  deleteAll?(namespace: string): Promise<number>;
}

export interface AgentHostServices extends Omit<HostServices, "storage"> {
  storage: AgentStorageProvider;
  workspaceQuery<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data?: T; errors?: Array<{ message: string }> }>;
  isGatewayConfigured(): boolean;
  getAgentRecordId(): Promise<string | null>;
  getWorkspaceId(): Promise<string | null>;
}

export interface PluginRouteDeps {
  db: {
    vacuumInto(targetPath: string): void;
    getDbPath(): string;
    getConfig(key: string): string | undefined;
    setConfig(key: string, value: string): void;
  };
  broadcast: (type: string, payload: unknown) => void;
  hostServices?: AgentHostServices;
  app?: unknown;
}

// ── Backup domain types ─────────────────────────────────────────────────

export interface BackupConfig {
  enabled: boolean;
  scheduleIntervalMs: number;
  changeOnlyBackup: boolean;
  storageTarget: "wspace" | "custom-s3";
  customS3?: CustomS3Config;
  retentionDays?: number;
  maxBackups?: number;
}

export interface CustomS3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathPrefix?: string;
  forcePathStyle?: boolean;
}

export interface BackupRecord {
  id: string;
  timestamp: string;
  agentName: string;
  dbSizeBytes: number;
  sha256Hash: string;
  storageTarget: "wspace" | "custom-s3";
  storagePath: string;
  fileId?: string;
  durationMs: number;
  status: "completed" | "failed";
  error?: string;
}

export interface RestoreOptions {
  backupId: string;
  dryRun?: boolean;
}

export interface BackupStatus {
  enabled: boolean;
  schedulerRunning: boolean;
  lastBackupTime: string | null;
  lastBackupHash: string | null;
  nextScheduledBackup: string | null;
  totalBackups: number;
  storageTarget: "wspace" | "custom-s3";
}

export interface StorageTarget {
  upload(
    filePath: string,
    agentName: string,
    timestamp: string,
  ): Promise<{ storagePath: string; fileId?: string }>;
  download(storagePath: string, targetPath: string): Promise<void>;
  delete(storagePath: string, fileId?: string): Promise<void>;
  list(
    agentName: string,
  ): Promise<Array<{ path: string; size: number; lastModified: string }>>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}
