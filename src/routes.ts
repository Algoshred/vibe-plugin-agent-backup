import { Elysia, t } from "elysia";
import { BoundLogger } from "@vibecontrols/plugin-sdk";
import type {
  AgentHostServices,
  BackupRecord,
  PluginRouteDeps,
} from "./types.js";
import { BackupService } from "./backup-service.js";
import { BackupScheduler } from "./scheduler.js";

let backupService: BackupService | null = null;
let scheduler: BackupScheduler | null = null;
let hostServicesRef: AgentHostServices | null = null;

export function setHostServices(hs: AgentHostServices): void {
  hostServicesRef = hs;
}

function ensureInit(deps: PluginRouteDeps): {
  svc: BackupService;
  sched: BackupScheduler;
} {
  if (!backupService && hostServicesRef) {
    backupService = new BackupService(hostServicesRef, deps);
    scheduler = new BackupScheduler(hostServicesRef, backupService);
    const hs = hostServicesRef;
    backupService.getConfig().then((config) => {
      if (config.enabled && scheduler) {
        scheduler.start(config.scheduleIntervalMs);
        new BoundLogger(hs.logger, "backup").info("Scheduler auto-started");
      }
    });
  }
  if (!backupService || !scheduler)
    throw new Error("Backup plugin not initialized.");
  return { svc: backupService, sched: scheduler };
}

export function getSchedulerRef(): BackupScheduler | null {
  return scheduler;
}

export function createBackupRoutes(deps: PluginRouteDeps) {
  return new Elysia()
    .get("/config", async () => {
      const { svc } = ensureInit(deps);
      return { ok: true, config: await svc.getConfig() };
    })
    .put(
      "/config",
      async ({ body }) => {
        const { svc, sched } = ensureInit(deps);
        const config = await svc.setConfig(body);
        if (config.enabled) sched.restart(config.scheduleIntervalMs);
        else sched.stop();
        return { ok: true, config };
      },
      {
        body: t.Object({
          enabled: t.Optional(t.Boolean()),
          scheduleIntervalMs: t.Optional(t.Number()),
          changeOnlyBackup: t.Optional(t.Boolean()),
          storageTarget: t.Optional(
            t.Union([t.Literal("wspace"), t.Literal("custom-s3")]),
          ),
          customS3: t.Optional(
            t.Object({
              endpoint: t.String(),
              bucket: t.String(),
              region: t.String(),
              accessKeyId: t.String(),
              secretAccessKey: t.String(),
              pathPrefix: t.Optional(t.String()),
              forcePathStyle: t.Optional(t.Boolean()),
            }),
          ),
          retentionDays: t.Optional(t.Number()),
          maxBackups: t.Optional(t.Number()),
        }),
      },
    )
    .post(
      "/run",
      async ({ query }) => {
        const { svc } = ensureInit(deps);
        return {
          ok: true,
          backup: await svc.runBackup(query.force === "true"),
        };
      },
      { query: t.Object({ force: t.Optional(t.String()) }) },
    )
    .post(
      "/restore",
      async ({ body }) => {
        const { svc } = ensureInit(deps);
        // This agent serves exactly one workspace; the svc already enforced
        // the caller is in it. So our own workspaceId IS the caller's — pass
        // it so restore rejects a backup stamped with a different workspace.
        let callerWorkspaceId: string | undefined;
        try {
          callerWorkspaceId =
            (await hostServicesRef?.getWorkspaceId()) ?? undefined;
        } catch {
          /* best-effort */
        }
        return svc.restore({
          backupId: body.backupId,
          dryRun: body.dryRun ?? false,
          callerWorkspaceId,
          // Restore-to-any-agent: the platform passes the SOURCE agent's record
          // when restoring a backup taken on a different (same-workspace) agent.
          inlineRecord: body.inlineRecord as BackupRecord | undefined,
        });
      },
      {
        body: t.Object({
          backupId: t.String(),
          dryRun: t.Optional(t.Boolean()),
          inlineRecord: t.Optional(t.Unknown()),
        }),
      },
    )
    .get(
      "/list",
      async ({ query }) => {
        const { svc } = ensureInit(deps);
        const limit = query.limit ? parseInt(query.limit, 10) : undefined;
        const backups = await svc.listBackups(limit);
        return { ok: true, backups, total: backups.length };
      },
      { query: t.Object({ limit: t.Optional(t.String()) }) },
    )
    .get("/list/:id", async ({ params }) => {
      const { svc } = ensureInit(deps);
      const record = await svc.getBackupRecord(params.id);
      return record
        ? { ok: true, backup: record }
        : { ok: false, error: "Backup not found" };
    })
    .delete("/backups/:id", async ({ params }) => {
      const { svc } = ensureInit(deps);
      const deleted = await svc.deleteBackup(params.id);
      return { ok: deleted, message: deleted ? "Deleted" : "Not found" };
    })
    .get("/status", async () => {
      const { svc, sched } = ensureInit(deps);
      return { ok: true, status: await svc.getStatus(sched.isRunning) };
    })
    .post("/test-connection", async () => {
      const { svc } = ensureInit(deps);
      return svc.testConnection();
    });
}
