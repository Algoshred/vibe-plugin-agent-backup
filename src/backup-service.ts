import { existsSync, readFileSync, renameSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { BackupConfig, BackupRecord, BackupStatus, HostServices, PluginRouteDeps, RestoreOptions } from "./types.js";
import { createStorageTarget } from "./storage/index.js";

const LOG_SOURCE = "backup-service";
const NS = "backup";
const LAST_HASH_KEY = "last-backup-hash";
const LAST_TIME_KEY = "last-backup-time";

export class BackupService {
  private hostServices: HostServices;
  private deps: PluginRouteDeps;

  constructor(hostServices: HostServices, deps: PluginRouteDeps) {
    this.hostServices = hostServices;
    this.deps = deps;
  }

  async getConfig(): Promise<BackupConfig> {
    const raw = await this.hostServices.storage.get(NS, "config");
    if (!raw) return { enabled: false, scheduleIntervalMs: 3600000, changeOnlyBackup: true, storageTarget: "wspace" };
    return JSON.parse(raw) as BackupConfig;
  }

  async setConfig(config: Partial<BackupConfig>): Promise<BackupConfig> {
    const current = await this.getConfig();
    const merged = { ...current, ...config };
    await this.hostServices.storage.set(NS, "config", JSON.stringify(merged));
    return merged;
  }

  getAgentName(): string {
    return this.deps.db.getConfig("agent-name") ?? this.hostServices.getConfig("agent-name") ?? hostname();
  }

  private async computeDbHash(): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(this.deps.db.getDbPath()));
    return hasher.digest("hex");
  }

  private async getLastBackupHash(): Promise<string | null> {
    return this.hostServices.storage.get(NS, LAST_HASH_KEY);
  }

  async hasChangedSinceLastBackup(): Promise<boolean> {
    return (await this.computeDbHash()) !== (await this.getLastBackupHash());
  }

  async runBackup(force = false): Promise<BackupRecord> {
    const { logger } = this.hostServices;
    const config = await this.getConfig();
    const agentName = this.getAgentName();
    const startTime = Date.now();

    logger.info(LOG_SOURCE, `Starting backup for agent: ${agentName}`, { force, storageTarget: config.storageTarget });
    this.deps.broadcast("backup:started" as never, { agentName, force });

    try {
      if (!force && config.changeOnlyBackup && !(await this.hasChangedSinceLastBackup())) {
        logger.info(LOG_SOURCE, "No changes detected, skipping backup");
        return { id: randomUUID(), timestamp: new Date().toISOString(), agentName, dbSizeBytes: 0, sha256Hash: (await this.getLastBackupHash()) ?? "", storageTarget: config.storageTarget, storagePath: "", durationMs: Date.now() - startTime, status: "completed", error: "Skipped: no changes" };
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tempPath = join(tmpdir(), `vibe-backup-${randomUUID()}.db`);
      logger.info(LOG_SOURCE, `Creating snapshot at: ${tempPath}`);
      this.deps.db.vacuumInto(tempPath);

      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(readFileSync(tempPath));
      const sha256Hash = hasher.digest("hex");
      const dbSizeBytes = statSync(tempPath).size;

      const storageTarget = createStorageTarget(config, this.hostServices);
      const uploadResult = await storageTarget.upload(tempPath, agentName, timestamp);
      try { unlinkSync(tempPath); } catch { /* ignore */ }

      const record: BackupRecord = { id: randomUUID(), timestamp: new Date().toISOString(), agentName, dbSizeBytes, sha256Hash, storageTarget: config.storageTarget, storagePath: uploadResult.storagePath, fileId: uploadResult.fileId, durationMs: Date.now() - startTime, status: "completed" };

      await this.hostServices.storage.set(NS, `backup:${record.id}`, JSON.stringify(record));
      await this.hostServices.storage.set(NS, LAST_HASH_KEY, sha256Hash);
      await this.hostServices.storage.set(NS, LAST_TIME_KEY, record.timestamp);
      await this.applyRetention(config);

      logger.info(LOG_SOURCE, `Backup completed: ${record.id}`, { size: dbSizeBytes, duration: record.durationMs, path: record.storagePath });
      this.deps.broadcast("backup:completed" as never, record);
      return record;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(LOG_SOURCE, `Backup failed: ${errorMsg}`);
      this.deps.broadcast("backup:failed" as never, { agentName, error: errorMsg });
      throw err;
    }
  }

  async restore(options: RestoreOptions): Promise<{ success: boolean; message: string; preRestorePath?: string }> {
    const { logger } = this.hostServices;
    const config = await this.getConfig();
    const record = await this.getBackupRecord(options.backupId);
    if (!record) return { success: false, message: `Backup not found: ${options.backupId}` };
    if (record.status !== "completed" || !record.storagePath) return { success: false, message: "Cannot restore from a failed backup" };

    const tempPath = join(tmpdir(), `vibe-restore-${randomUUID()}.db`);
    const storageTarget = createStorageTarget(config, this.hostServices);
    await storageTarget.download(record.storagePath, tempPath);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(tempPath));
    if (hasher.digest("hex") !== record.sha256Hash) { unlinkSync(tempPath); return { success: false, message: `Hash mismatch` }; }
    if (options.dryRun) { unlinkSync(tempPath); return { success: true, message: `Dry run: backup validated successfully (${record.dbSizeBytes} bytes, hash matches)` }; }

    const dbPath = this.deps.db.getDbPath();
    const preRestorePath = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (existsSync(dbPath)) writeFileSync(preRestorePath, readFileSync(dbPath));

    try {
      for (const ext of ["-wal", "-shm"]) { const p = dbPath + ext; if (existsSync(p)) unlinkSync(p); }
      renameSync(tempPath, dbPath);
      logger.info(LOG_SOURCE, "Database restored. Agent restart recommended.");
      return { success: true, message: "Database restored successfully. Please restart the agent for changes to take effect.", preRestorePath };
    } catch (err) {
      if (existsSync(preRestorePath)) try { renameSync(preRestorePath, dbPath); } catch { /* critical */ }
      return { success: false, message: `Restore failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async listBackups(limit?: number): Promise<BackupRecord[]> {
    const entries = await this.hostServices.storage.list(NS);
    const records: BackupRecord[] = [];
    for (const entry of entries) {
      if (!entry.key.startsWith("backup:")) continue;
      try {
        const record = JSON.parse(entry.value) as BackupRecord;
        if (record.status === "completed" && record.storagePath) records.push(record);
      } catch { /* skip */ }
    }
    records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return limit ? records.slice(0, limit) : records;
  }

  async getBackupRecord(id: string): Promise<BackupRecord | null> {
    const raw = await this.hostServices.storage.get(NS, `backup:${id}`);
    return raw ? (JSON.parse(raw) as BackupRecord) : null;
  }

  async deleteBackup(id: string): Promise<boolean> {
    const record = await this.getBackupRecord(id);
    if (!record) return false;
    try { await createStorageTarget(await this.getConfig(), this.hostServices).delete(record.storagePath, record.fileId); } catch { /* ok */ }
    await this.hostServices.storage.delete(NS, `backup:${id}`);
    return true;
  }

  async getStatus(schedulerRunning: boolean): Promise<BackupStatus> {
    const config = await this.getConfig();
    const lastTime = await this.hostServices.storage.get(NS, LAST_TIME_KEY);
    const lastHash = await this.getLastBackupHash();
    const backups = await this.listBackups();
    let nextScheduled: string | null = null;
    if (config.enabled && schedulerRunning && lastTime) {
      nextScheduled = new Date(new Date(lastTime).getTime() + config.scheduleIntervalMs).toISOString();
    }
    return { enabled: config.enabled, schedulerRunning, lastBackupTime: lastTime, lastBackupHash: lastHash, nextScheduledBackup: nextScheduled, totalBackups: backups.length, storageTarget: config.storageTarget };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return createStorageTarget(await this.getConfig(), this.hostServices).testConnection();
  }

  private async applyRetention(config: BackupConfig): Promise<void> {
    const backups = await this.listBackups();
    if (config.maxBackups && backups.length > config.maxBackups) {
      for (const b of backups.slice(config.maxBackups)) await this.deleteBackup(b.id);
    }
    if (config.retentionDays) {
      const cutoff = Date.now() - config.retentionDays * 86400000;
      for (const b of backups) { if (new Date(b.timestamp).getTime() < cutoff) await this.deleteBackup(b.id); }
    }
  }
}
