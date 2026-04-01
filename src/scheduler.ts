import type { HostServices } from "./types.js";
import type { BackupService } from "./backup-service.js";

const LOG_SOURCE = "backup-scheduler";

export class BackupScheduler {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private hostServices: HostServices;
  private backupService: BackupService;

  constructor(hostServices: HostServices, backupService: BackupService) {
    this.hostServices = hostServices;
    this.backupService = backupService;
  }

  get isRunning(): boolean { return this.running; }

  start(intervalMs: number): void {
    this.stop();
    this.running = true;
    this.hostServices.logger.info(LOG_SOURCE, `Scheduler started: interval=${intervalMs}ms`);
    this.intervalHandle = setInterval(async () => {
      try {
        this.hostServices.logger.info(LOG_SOURCE, "Scheduled backup triggered");
        await this.backupService.runBackup(false);
      } catch (err) {
        this.hostServices.logger.error(LOG_SOURCE, `Scheduled backup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null; }
    if (this.running) this.hostServices.logger.info(LOG_SOURCE, "Scheduler stopped");
    this.running = false;
  }

  restart(intervalMs: number): void { this.stop(); this.start(intervalMs); }
}
