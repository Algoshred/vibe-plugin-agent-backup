import type { Elysia } from "elysia";
import type { Command } from "commander";
import type { HostServices, PluginRouteDeps, VibePlugin } from "./types.js";
import { createBackupRoutes, setHostServices, getSchedulerRef } from "./routes.js";
import { registerBackupCommands } from "./commands.js";

export type {
  VibePlugin, HostServices, BackupConfig, BackupRecord, BackupStatus,
  RestoreOptions, CustomS3Config, StorageTarget,
} from "./types.js";

export const vibePlugin: VibePlugin = {
  name: "backup",
  version: "1.0.0",
  description: "SQLite database backup/restore — back up agent databases to S3 or custom storage",
  tags: ["backend", "cli"],
  cliCommand: "backup",
  apiPrefix: "/api/backup",

  createRoutes(deps: PluginRouteDeps) {
    // If hostServices is available in deps (new agent versions), use it immediately
    if (deps.hostServices) setHostServices(deps.hostServices);
    return createBackupRoutes(deps);
  },

  async onServerStart(_app: Elysia, hostServices: HostServices) {
    setHostServices(hostServices);
    console.log("  Plugin 'backup' registered routes: /api/backup");
  },

  async onServerReady(_app: Elysia, hostServices: HostServices) {
    setHostServices(hostServices);
    hostServices.logger.info("backup", "Backup plugin ready");
  },

  async onServerStop() {
    const scheduler = getSchedulerRef();
    if (scheduler) scheduler.stop();
    console.log("  Plugin 'backup' stopped");
  },

  onCliSetup(program: Command) {
    registerBackupCommands(program);
  },
};

export default vibePlugin;
