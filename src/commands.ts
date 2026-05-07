import type { Command } from "commander";
import {
  runMultimode,
  pickOutputMode,
  maybePrintJson,
  type OutputFlags,
} from "./utils/multimode.js";
import {
  interactiveTable,
  interactiveDetail,
  type TableRow,
} from "./utils/interactive.js";

const AGENT_BASE_URL = process.env.VIBE_AGENT_URL ?? "http://localhost:3005";
const API_KEY = process.env.VIBE_AGENT_API_KEY ?? "";

async function apiFetch(urlPath: string, options?: RequestInit): Promise<Response> {
  return fetch(`${AGENT_BASE_URL}${urlPath}`, {
    ...options,
    headers: { "Content-Type": "application/json", "x-agent-api-key": API_KEY, ...options?.headers },
  });
}

/** Redact obvious secret-shaped fields recursively for JSON output. */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(token|secret|password|apikey|api_key)/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

interface BackupRecord {
  id: string;
  timestamp: string | number;
  dbSizeBytes: number;
  storageTarget: string;
  [k: string]: unknown;
}

export function registerBackupCommands(program: Command): void {
  const backup = program.command("backup").description("Agent storage backup & restore");

  backup
    .command("run")
    .description("Trigger a manual backup")
    .option("--force", "Skip change detection")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async (opts: { force?: boolean } & OutputFlags) => {
      const res = await apiFetch(`/api/backup/run?force=${opts.force ? "true" : "false"}`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; backup?: Record<string, unknown>; error?: unknown };
      if (maybePrintJson(opts, { ok: !!data.ok, action: "run", result: redactSecrets(data) })) return;
      if (data.ok) {
        const b = data.backup as Record<string, unknown> | undefined;
        if (b && b.error === "Skipped: no changes")
          console.log("No changes detected. Use --force to back up anyway.");
        else if (b)
          console.log(
            `Backup completed: ${b.id}\n  Size: ${(Number(b.dbSizeBytes) / 1024).toFixed(1)} KB\n  Path: ${b.storagePath}\n  Duration: ${b.durationMs}ms`,
          );
      } else console.error("Backup failed:", data.error || JSON.stringify(data));
    });

  backup
    .command("restore <backupId>")
    .description("Restore database from a backup")
    .option("--dry-run", "Validate only")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async (backupId: string, opts: { dryRun?: boolean } & OutputFlags) => {
      const res = await apiFetch("/api/backup/restore", {
        method: "POST",
        body: JSON.stringify({ backupId, dryRun: opts.dryRun ?? false }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        preRestorePath?: string;
      };
      if (maybePrintJson(opts, { ok: !!data.success, action: "restore", backupId, result: redactSecrets(data) })) return;
      console.log(data.success ? data.message : `Restore failed: ${data.message}`);
      if (data.preRestorePath) console.log(`  Safety backup: ${data.preRestorePath}`);
    });

  backup
    .command("list")
    .description("List available backups")
    .option("--limit <n>", "Limit results", "20")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async (opts: { limit: string } & OutputFlags) => {
      await runMultimode<{ ok: boolean; total: number; backups: BackupRecord[] }>({
        mode: pickOutputMode(opts),
        fetchData: async () => {
          const res = await apiFetch(`/api/backup/list?limit=${opts.limit}`);
          return (await res.json()) as { ok: boolean; total: number; backups: BackupRecord[] };
        },
        plain: (data) => {
          if (data.ok && data.backups.length > 0) {
            console.log(`Backups (${data.total} total):\n`);
            for (const b of data.backups)
              console.log(
                `  ${b.id}\n    Date: ${new Date(b.timestamp).toLocaleString()}  Size: ${(b.dbSizeBytes / 1024).toFixed(1)} KB  Target: ${b.storageTarget}\n`,
              );
          } else console.log("No backups found.");
        },
        interactive: async (data) => {
          if (!data.ok || data.backups.length === 0) {
            await interactiveDetail({
              title: "backups",
              body: "No backups found.",
            });
            return;
          }
          const rows: TableRow[] = data.backups.map((b) => ({
            id: b.id,
            label: b.id,
            hint: `${(b.dbSizeBytes / 1024).toFixed(1)} KB`,
            detail: [
              `id:        ${b.id}`,
              `date:      ${new Date(b.timestamp).toLocaleString()}`,
              `size:      ${(b.dbSizeBytes / 1024).toFixed(1)} KB`,
              `target:    ${b.storageTarget}`,
            ].join("\n"),
          }));
          await interactiveTable({
            title: `backups — ${data.total} total`,
            rows,
          });
        },
        json: (data) => redactSecrets(data),
      });
    });

  backup
    .command("config")
    .description("Show or update configuration")
    .argument("[action]")
    .argument("[key]")
    .argument("[value]")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async (action: string | undefined, key: string | undefined, value: string | undefined, opts: OutputFlags) => {
      if (!action || action === "show") {
        await runMultimode<{ config: Record<string, unknown> }>({
          mode: pickOutputMode(opts),
          fetchData: async () => {
            const res = await apiFetch("/api/backup/config");
            return (await res.json()) as { config: Record<string, unknown> };
          },
          plain: (data) => {
            console.log(JSON.stringify(data.config, null, 2));
          },
          interactive: async (data) => {
            await interactiveDetail({
              title: "backup config",
              body: JSON.stringify(redactSecrets(data.config), null, 2),
            });
          },
          json: (data) => redactSecrets(data),
        });
        return;
      }
      if (action === "set" && key && value) {
        let parsed: unknown = value;
        if (value === "true") parsed = true;
        else if (value === "false") parsed = false;
        else if (!isNaN(Number(value))) parsed = Number(value);
        const res = await apiFetch("/api/backup/config", {
          method: "PUT",
          body: JSON.stringify({ [key]: parsed }),
        });
        const data = (await res.json()) as { ok?: boolean };
        if (maybePrintJson(opts, { ok: !!data.ok, action: "config-set", key, value: parsed })) return;
        if (data.ok) console.log(`Updated ${key} = ${value}`);
      } else console.log("Usage: vibe backup config [show | set <key> <value>]");
    });

  backup
    .command("status")
    .description("Show scheduler status")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async (opts: OutputFlags) => {
      await runMultimode<{ status: Record<string, unknown> }>({
        mode: pickOutputMode(opts),
        fetchData: async () => {
          const res = await apiFetch("/api/backup/status");
          return (await res.json()) as { status: Record<string, unknown> };
        },
        plain: (data) => {
          const s = data.status;
          console.log(
            `Backup status:\n  Enabled: ${s.enabled}\n  Scheduler: ${s.schedulerRunning ? "running" : "stopped"}\n  Target: ${s.storageTarget}\n  Total: ${s.totalBackups}\n  Last: ${s.lastBackupTime ?? "never"}\n  Next: ${s.nextScheduledBackup ?? "n/a"}`,
          );
        },
        interactive: async (data) => {
          const s = data.status;
          await interactiveDetail({
            title: "backup status",
            body: [
              `Enabled:    ${s.enabled}`,
              `Scheduler:  ${s.schedulerRunning ? "running" : "stopped"}`,
              `Target:     ${s.storageTarget}`,
              `Total:      ${s.totalBackups}`,
              `Last:       ${s.lastBackupTime ?? "never"}`,
              `Next:       ${s.nextScheduledBackup ?? "n/a"}`,
            ].join("\n"),
          });
        },
        json: (data) => redactSecrets(data),
      });
    });

  backup
    .command("test")
    .description("Test storage connection")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async (opts: OutputFlags) => {
      await runMultimode<{ ok: boolean; message: string }>({
        mode: pickOutputMode(opts),
        fetchData: async () => {
          const res = await apiFetch("/api/backup/test-connection", { method: "POST" });
          return (await res.json()) as { ok: boolean; message: string };
        },
        plain: (data) => {
          console.log(data.ok ? `Connection OK: ${data.message}` : `Connection failed: ${data.message}`);
        },
        interactive: async (data) => {
          await interactiveDetail({
            title: "backup test",
            body: data.ok ? `Connection OK\n${data.message}` : `Connection failed\n${data.message}`,
          });
        },
        json: (data) => redactSecrets(data),
      });
    });
}
