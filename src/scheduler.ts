import { BoundLogger } from "@vibecontrols/plugin-sdk";
import type { AgentHostServices } from "./types.js";
import type { BackupService } from "./backup-service.js";

export class BackupScheduler {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private log: BoundLogger;
  private backupService: BackupService;

  constructor(hostServices: AgentHostServices, backupService: BackupService) {
    this.log = new BoundLogger(hostServices.logger, "backup-scheduler");
    this.backupService = backupService;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(intervalMs: number): void {
    this.stop();
    this.running = true;
    this.log.info(`Scheduler started: interval=${intervalMs}ms`);
    this.intervalHandle = setInterval(async () => {
      try {
        this.log.info("Scheduled backup triggered");
        await this.backupService.runBackup(false);
      } catch (err) {
        this.log.error(
          `Scheduled backup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.running) this.log.info("Scheduler stopped");
    this.running = false;
  }

  restart(intervalMs: number): void {
    this.stop();
    this.start(intervalMs);
  }
}
