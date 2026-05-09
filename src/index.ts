import type { VibePlugin, HostServices } from "@vibecontrols/plugin-sdk";
import {
  createLifecycleHooks,
  TelemetryEmitter,
  BoundLogger,
} from "@vibecontrols/plugin-sdk";
import type { Command } from "commander";
import type { AgentHostServices, PluginRouteDeps } from "./types.js";
import {
  createBackupRoutes,
  setHostServices,
  getSchedulerRef,
} from "./routes.js";
import { registerBackupCommands } from "./commands.js";

export type {
  BackupConfig,
  BackupRecord,
  BackupStatus,
  RestoreOptions,
  CustomS3Config,
  StorageTarget,
} from "./types.js";

const PLUGIN_NAME = "backup";
const PLUGIN_VERSION = "1.0.0";

const lifecycle = createLifecycleHooks({
  name: PLUGIN_NAME,
  telemetryEventName: `${PLUGIN_NAME}.ready`,
  onInit: (hostServices: HostServices) => {
    // Agent injects the richer AgentHostServices at runtime (storage/list/
    // workspaceQuery/etc); SDK's HostServices is the structural minimum.
    setHostServices(hostServices as unknown as AgentHostServices);
    const log = new BoundLogger(hostServices.logger, PLUGIN_NAME);
    log.info("Backup plugin ready");
    new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION, hostServices).emitReady();
  },
  onShutdown: () => {
    const scheduler = getSchedulerRef();
    if (scheduler) scheduler.stop();
  },
});

/**
 * Plugin shape: extends SDK's `VibePlugin` with the agent-specific
 * `createRoutes(deps)` signature. The SDK's `VibePlugin.createRoutes`
 * is intentionally `() => unknown` (loosest contract); the agent host
 * passes a `PluginRouteDeps` argument at runtime.
 */
type BackupVibePlugin = Omit<VibePlugin, "createRoutes"> & {
  createRoutes: (deps: PluginRouteDeps) => unknown;
};

export const vibePlugin: BackupVibePlugin = {
  capabilities: {
    storage: "rw",
    subprocess: true,
    audit: true,
    telemetry: true,
  },
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "Agent storage backup/restore — back up Skalex-backed agent state to S3 or custom storage",
  tags: ["backend", "cli"],
  cliCommand: "backup",
  apiPrefix: "/api/backup",

  createRoutes: (deps: PluginRouteDeps) => {
    if (deps.hostServices) setHostServices(deps.hostServices);
    return createBackupRoutes(deps);
  },

  onServerStart: lifecycle.onServerStart,
  onServerStop: lifecycle.onServerStop,

  onCliSetup: (program: unknown) => {
    registerBackupCommands(program as Command);
  },
};

export default vibePlugin;
