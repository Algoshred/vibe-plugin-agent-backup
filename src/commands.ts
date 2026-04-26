import type { Command } from "commander";

const AGENT_BASE_URL = process.env.VIBE_AGENT_URL ?? "http://localhost:3005";
const API_KEY = process.env.VIBE_AGENT_API_KEY ?? "";

async function apiFetch(urlPath: string, options?: RequestInit): Promise<Response> {
  return fetch(`${AGENT_BASE_URL}${urlPath}`, {
    ...options,
    headers: { "Content-Type": "application/json", "x-agent-api-key": API_KEY, ...options?.headers },
  });
}

export function registerBackupCommands(program: Command): void {
  const backup = program.command("backup").description("Agent storage backup & restore");

  backup.command("run").description("Trigger a manual backup").option("--force", "Skip change detection")
    .action(async (opts: { force?: boolean }) => {
      const res = await apiFetch(`/api/backup/run?force=${opts.force ? "true" : "false"}`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        const b = data.backup;
        if (b.error === "Skipped: no changes") console.log("No changes detected. Use --force to back up anyway.");
        else console.log(`Backup completed: ${b.id}\n  Size: ${(b.dbSizeBytes / 1024).toFixed(1)} KB\n  Path: ${b.storagePath}\n  Duration: ${b.durationMs}ms`);
      } else console.error("Backup failed:", data.error || JSON.stringify(data));
    });

  backup.command("restore <backupId>").description("Restore database from a backup").option("--dry-run", "Validate only")
    .action(async (backupId: string, opts: { dryRun?: boolean }) => {
      const res = await apiFetch("/api/backup/restore", { method: "POST", body: JSON.stringify({ backupId, dryRun: opts.dryRun ?? false }) });
      const data = await res.json();
      console.log(data.success ? data.message : `Restore failed: ${data.message}`);
      if (data.preRestorePath) console.log(`  Safety backup: ${data.preRestorePath}`);
    });

  backup.command("list").description("List available backups").option("--limit <n>", "Limit results", "20")
    .action(async (opts: { limit: string }) => {
      const res = await apiFetch(`/api/backup/list?limit=${opts.limit}`);
      const data = await res.json();
      if (data.ok && data.backups.length > 0) {
        console.log(`Backups (${data.total} total):\n`);
        for (const b of data.backups) console.log(`  ${b.id}\n    Date: ${new Date(b.timestamp).toLocaleString()}  Size: ${(b.dbSizeBytes / 1024).toFixed(1)} KB  Target: ${b.storageTarget}\n`);
      } else console.log("No backups found.");
    });

  backup.command("config").description("Show or update configuration").argument("[action]").argument("[key]").argument("[value]")
    .action(async (action?: string, key?: string, value?: string) => {
      if (!action || action === "show") { const res = await apiFetch("/api/backup/config"); console.log(JSON.stringify((await res.json()).config, null, 2)); return; }
      if (action === "set" && key && value) {
        let parsed: unknown = value;
        if (value === "true") parsed = true; else if (value === "false") parsed = false; else if (!isNaN(Number(value))) parsed = Number(value);
        const res = await apiFetch("/api/backup/config", { method: "PUT", body: JSON.stringify({ [key]: parsed }) });
        if ((await res.json()).ok) console.log(`Updated ${key} = ${value}`);
      } else console.log("Usage: vibe backup config [show | set <key> <value>]");
    });

  backup.command("status").description("Show scheduler status").action(async () => {
    const res = await apiFetch("/api/backup/status");
    const s = (await res.json()).status;
    console.log(`Backup status:\n  Enabled: ${s.enabled}\n  Scheduler: ${s.schedulerRunning ? "running" : "stopped"}\n  Target: ${s.storageTarget}\n  Total: ${s.totalBackups}\n  Last: ${s.lastBackupTime ?? "never"}\n  Next: ${s.nextScheduledBackup ?? "n/a"}`);
  });

  backup.command("test").description("Test storage connection").action(async () => {
    const res = await apiFetch("/api/backup/test-connection", { method: "POST" });
    const data = await res.json();
    console.log(data.ok ? `Connection OK: ${data.message}` : `Connection failed: ${data.message}`);
  });
}
