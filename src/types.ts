/**
 * Type declarations for vibe-plugin-backup.
 */

import type { Elysia } from "elysia";
import type { Command } from "commander";

// ── Host-provided interfaces ────────────────────────────────────────────

export interface StorageEntry {
  key: string;
  value: string;
  updatedAt?: string;
}

export interface StorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  list(namespace: string): Promise<StorageEntry[]>;
  deleteAll(namespace: string): Promise<number>;
}

export interface ServiceRegistry {
  get<T = unknown>(name: string): T | undefined;
}

export type WsEventType = string;

export interface HostServices {
  telemetry?: {
    emit: (name: string, payload?: Record<string, unknown>) => void;
  };
  storage: StorageProvider;
  logger: {
    debug(source: string, message: string, metadata?: Record<string, unknown>): void;
    info(source: string, message: string, metadata?: Record<string, unknown>): void;
    warn(source: string, message: string, metadata?: Record<string, unknown>): void;
    error(source: string, message: string, metadata?: Record<string, unknown>): void;
  };
  serviceRegistry: ServiceRegistry;
  broadcast(type: WsEventType, payload: unknown): void;
  workspaceQuery<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data?: T; errors?: Array<{ message: string }> }>;
  isGatewayConfigured(): boolean;
  getAgentRecordId(): string | null;
  getWorkspaceId(): string | null;
  getConfig(key: string): string | undefined;
  getAgentBaseUrl(): string;
  getAgentVersion(): string;
}

export interface PluginRouteDeps {
  db: {
    vacuumInto(targetPath: string): void;
    getDbPath(): string;
    getConfig(key: string): string | undefined;
    setConfig(key: string, value: string): void;
  };
  broadcast: (type: WsEventType, payload: unknown) => void;
  hostServices?: HostServices;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app?: any;
}

export interface PluginCapabilities {
  storage?: "none" | "read" | "rw";
  secrets?: "none" | "read" | "rw";
  gateway?: boolean;
  broadcast?: boolean;
  subprocess?: boolean;
  audit?: boolean;
  telemetry?: boolean;
}

export interface VibePlugin {
  capabilities?: PluginCapabilities;
  name: string;
  version: string;
  description?: string;
  tags?: Array<"backend" | "frontend" | "cli" | "provider" | "adapter" | "integration">;
  cliCommand?: string;
  apiPrefix?: string;
  onCliSetup?: (program: Command, hostServices: HostServices) => void | Promise<void>;
  onServerStart?: (app: Elysia, hostServices: HostServices) => void | Promise<void>;
  onServerReady?: (app: Elysia, hostServices: HostServices) => void | Promise<void>;
  onServerStop?: () => void | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRoutes?: (deps: PluginRouteDeps) => any;
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
  upload(filePath: string, agentName: string, timestamp: string): Promise<{ storagePath: string; fileId?: string }>;
  download(storagePath: string, targetPath: string): Promise<void>;
  delete(storagePath: string, fileId?: string): Promise<void>;
  list(agentName: string): Promise<Array<{ path: string; size: number; lastModified: string }>>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}
