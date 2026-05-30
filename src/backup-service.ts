import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  BoundLogger,
  NamespaceStore,
  TypedStore,
} from "@vibecontrols/plugin-sdk";
import type { StorageProvider } from "@vibecontrols/plugin-sdk/contract";
import type {
  AgentHostServices,
  BackupConfig,
  BackupRecord,
  BackupStatus,
  PluginRouteDeps,
  RestoreOptions,
} from "./types.js";
import { createStorageTarget } from "./storage/index.js";

const LOG_SOURCE = "backup-service";
const NS = "backup";
const CONFIG_KEY = "config";
const LAST_HASH_KEY = "last-backup-hash";
const LAST_TIME_KEY = "last-backup-time";
const BACKUP_PREFIX = "backup:";

const DEFAULT_CONFIG: BackupConfig = {
  enabled: false,
  scheduleIntervalMs: 3600000,
  changeOnlyBackup: true,
  storageTarget: "wspace",
};

export class BackupService {
  private hostServices: AgentHostServices;
  private deps: PluginRouteDeps;
  private log: BoundLogger;
  private store: NamespaceStore;
  private configStore: TypedStore<BackupConfig>;
  private lastHashStore: TypedStore<string>;
  private lastTimeStore: TypedStore<string>;

  constructor(hostServices: AgentHostServices, deps: PluginRouteDeps) {
    this.hostServices = hostServices;
    this.deps = deps;
    this.log = new BoundLogger(hostServices.logger, LOG_SOURCE);
    // NamespaceStore expects SDK's structural StorageProvider; the agent's
    // string-valued AgentStorageProvider satisfies it at runtime because
    // TypedStore always JSON.stringify-s on set and JSON.parse-s on get.
    this.store = new NamespaceStore(
      hostServices.storage as unknown as StorageProvider,
      NS,
      hostServices.logger,
      "backup",
    );
    this.configStore = this.store.typed<BackupConfig>(CONFIG_KEY);
    this.lastHashStore = this.store.typed<string>(LAST_HASH_KEY);
    this.lastTimeStore = this.store.typed<string>(LAST_TIME_KEY);
  }

  async getConfig(): Promise<BackupConfig> {
    return (await this.configStore.get()) ?? { ...DEFAULT_CONFIG };
  }

  async setConfig(config: Partial<BackupConfig>): Promise<BackupConfig> {
    const current = await this.getConfig();
    const merged = { ...current, ...config };
    await this.configStore.set(merged);
    return merged;
  }

  async getAgentName(): Promise<string> {
    return (await this.deps.db.getConfig("agent-name")) ?? hostname();
  }

  /**
   * Snapshot the live storage to `targetPath`. Prefers the adapter's own
   * `backup(targetPath)` (Skalex/Postgres provide deterministic dumps).
   * Falls back to tarring the data directory at `getDbPath()` for older
   * adapter builds that pre-date the `backup()` contract — the
   * "this.deps.db.backup is not a function" path observed in alpha when
   * a stale adapter was bundled into the agent image.
   */
  private async snapshot(targetPath: string): Promise<void> {
    const db = this.deps.db as unknown as {
      backup?: (p: string) => Promise<void>;
      getDbPath?: () => string;
    };
    if (typeof db.backup === "function") {
      await db.backup(targetPath);
      return;
    }
    if (typeof db.getDbPath !== "function") {
      throw new Error(
        "Backup unavailable: storage adapter has neither backup() nor getDbPath().",
      );
    }
    const dbPath = db.getDbPath();
    this.log.warn(
      "Storage adapter does not implement backup(); falling back to tar of getDbPath()",
      { dbPath },
    );
    // `tar` ships with Windows 10 1803+ (tar.exe) as well as POSIX systems, so
    // we guard on availability rather than platform. If it's missing, the
    // storage adapter must implement backup() instead.
    const tarPath = Bun.which("tar", { PATH: process.env.PATH });
    if (tarPath === null) {
      throw new Error(
        "Backup fallback requires tar: 'tar' was not found on PATH. " +
          "Install tar (bundled with Windows 10 1803+ and most POSIX systems) " +
          "or use a storage adapter that implements backup().",
      );
    }
    const proc = Bun.spawn([tarPath, "-czf", targetPath, "-C", dbPath, "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Backup fallback tar failed (exit ${exitCode}): ${err}`);
    }
  }

  private async getLastBackupHash(): Promise<string | null> {
    return this.lastHashStore.get();
  }

  async runBackup(force = false): Promise<BackupRecord> {
    const config = await this.getConfig();
    const agentName = await this.getAgentName();
    const startTime = Date.now();

    this.log.info(`Starting backup for agent: ${agentName}`, {
      force,
      storageTarget: config.storageTarget,
    });
    this.deps.broadcast("backup:started", { agentName, force });

    try {
      // Snapshot first, then hash the snapshot itself for change-detection.
      // The old impl tried to hash getDbPath() directly, which broke for
      // adapters that aren't a single file (Skalex = directory, Postgres =
      // connection string).
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tempPath = join(tmpdir(), `vibe-backup-${randomUUID()}.db`);
      this.log.info(`Creating snapshot at: ${tempPath}`);
      await this.snapshot(tempPath);

      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(readFileSync(tempPath));
      const sha256Hash = hasher.digest("hex");
      const dbSizeBytes = statSync(tempPath).size;

      if (
        !force &&
        config.changeOnlyBackup &&
        sha256Hash === (await this.getLastBackupHash())
      ) {
        try {
          unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
        this.log.info("No changes detected, skipping backup");
        return {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          agentName,
          dbSizeBytes,
          sha256Hash,
          storageTarget: config.storageTarget,
          storagePath: "",
          durationMs: Date.now() - startTime,
          status: "completed",
          error: "Skipped: no changes",
        };
      }

      const storageTarget = createStorageTarget(config, this.hostServices);
      const uploadResult = await storageTarget.upload(
        tempPath,
        agentName,
        timestamp,
      );
      try {
        unlinkSync(tempPath);
      } catch {
        /* ignore */
      }

      const record: BackupRecord = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        agentName,
        dbSizeBytes,
        sha256Hash,
        storageTarget: config.storageTarget,
        storagePath: uploadResult.storagePath,
        fileId: uploadResult.fileId,
        durationMs: Date.now() - startTime,
        status: "completed",
      };

      await this.store
        .typed<BackupRecord>(`${BACKUP_PREFIX}${record.id}`)
        .set(record);
      await this.lastHashStore.set(sha256Hash);
      await this.lastTimeStore.set(record.timestamp);
      await this.applyRetention(config);

      this.log.info(`Backup completed: ${record.id}`, {
        size: dbSizeBytes,
        duration: record.durationMs,
        path: record.storagePath,
      });
      this.deps.broadcast("backup:completed", record);
      return record;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error(`Backup failed: ${errorMsg}`);
      this.deps.broadcast("backup:failed", { agentName, error: errorMsg });
      throw err;
    }
  }

  async restore(
    options: RestoreOptions,
  ): Promise<{ success: boolean; message: string; preRestorePath?: string }> {
    const config = await this.getConfig();
    const record = await this.getBackupRecord(options.backupId);
    if (!record)
      return {
        success: false,
        message: `Backup not found: ${options.backupId}`,
      };
    if (record.status !== "completed" || !record.storagePath)
      return { success: false, message: "Cannot restore from a failed backup" };

    const tempPath = join(tmpdir(), `vibe-restore-${randomUUID()}.db`);
    const storageTarget = createStorageTarget(config, this.hostServices);
    await storageTarget.download(record.storagePath, tempPath);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(tempPath));
    if (hasher.digest("hex") !== record.sha256Hash) {
      unlinkSync(tempPath);
      return { success: false, message: `Hash mismatch` };
    }
    if (options.dryRun) {
      unlinkSync(tempPath);
      return {
        success: true,
        message: `Dry run: backup validated successfully (${record.dbSizeBytes} bytes, hash matches)`,
      };
    }

    const dbPath = this.deps.db.getDbPath();
    const preRestorePath = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (existsSync(dbPath)) writeFileSync(preRestorePath, readFileSync(dbPath));

    try {
      for (const ext of ["-wal", "-shm"]) {
        const p = dbPath + ext;
        if (existsSync(p)) unlinkSync(p);
      }
      renameSync(tempPath, dbPath);
      this.log.info("Database restored. Agent restart recommended.");
      return {
        success: true,
        message:
          "Database restored successfully. Please restart the agent for changes to take effect.",
        preRestorePath,
      };
    } catch (err) {
      if (existsSync(preRestorePath))
        try {
          renameSync(preRestorePath, dbPath);
        } catch {
          /* critical */
        }
      return {
        success: false,
        message: `Restore failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async listBackups(limit?: number): Promise<BackupRecord[]> {
    // Agent's storage.list returns rich StorageEntry[] (key+value); read directly.
    const entries = await this.hostServices.storage.list(NS);
    const records: BackupRecord[] = [];
    for (const entry of entries) {
      if (!entry.key.startsWith(BACKUP_PREFIX)) continue;
      try {
        const record = JSON.parse(entry.value) as BackupRecord;
        if (record.status === "completed" && record.storagePath)
          records.push(record);
      } catch {
        /* skip */
      }
    }
    records.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    return limit ? records.slice(0, limit) : records;
  }

  async getBackupRecord(id: string): Promise<BackupRecord | null> {
    return this.store.typed<BackupRecord>(`${BACKUP_PREFIX}${id}`).get();
  }

  async deleteBackup(id: string): Promise<boolean> {
    const record = await this.getBackupRecord(id);
    if (!record) return false;
    try {
      await createStorageTarget(
        await this.getConfig(),
        this.hostServices,
      ).delete(record.storagePath, record.fileId);
    } catch {
      /* ok */
    }
    await this.store.typed<BackupRecord>(`${BACKUP_PREFIX}${id}`).delete();
    return true;
  }

  async getStatus(schedulerRunning: boolean): Promise<BackupStatus> {
    const config = await this.getConfig();
    const lastTime = await this.lastTimeStore.get();
    const lastHash = await this.getLastBackupHash();
    const backups = await this.listBackups();
    let nextScheduled: string | null = null;
    if (config.enabled && schedulerRunning && lastTime) {
      nextScheduled = new Date(
        new Date(lastTime).getTime() + config.scheduleIntervalMs,
      ).toISOString();
    }
    return {
      enabled: config.enabled,
      schedulerRunning,
      lastBackupTime: lastTime,
      lastBackupHash: lastHash,
      nextScheduledBackup: nextScheduled,
      totalBackups: backups.length,
      storageTarget: config.storageTarget,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return createStorageTarget(
      await this.getConfig(),
      this.hostServices,
    ).testConnection();
  }

  private async applyRetention(config: BackupConfig): Promise<void> {
    const backups = await this.listBackups();
    if (config.maxBackups && backups.length > config.maxBackups) {
      for (const b of backups.slice(config.maxBackups))
        await this.deleteBackup(b.id);
    }
    if (config.retentionDays) {
      const cutoff = Date.now() - config.retentionDays * 86400000;
      for (const b of backups) {
        if (new Date(b.timestamp).getTime() < cutoff)
          await this.deleteBackup(b.id);
      }
    }
  }
}
