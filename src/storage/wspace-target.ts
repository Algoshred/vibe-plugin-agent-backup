import { readFileSync, writeFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { BoundLogger } from "@vibecontrols/plugin-sdk";
import type { AgentHostServices, StorageTarget } from "../types.js";

const LOG_SOURCE = "backup:wspace-target";
const BACKUP_FOLDER_HIERARCHY = ["backups", "vibecontrols", "agents"];

interface FolderResult {
  id: string;
  name: string;
  path: string;
}

export class WspaceStorageTarget implements StorageTarget {
  private hostServices: AgentHostServices;
  private log: BoundLogger;
  private folderCache = new Map<string, string>();

  constructor(hostServices: AgentHostServices) {
    this.hostServices = hostServices;
    this.log = new BoundLogger(hostServices.logger, LOG_SOURCE);
  }

  private async ensureFolderHierarchy(agentName: string): Promise<string> {
    const folders = [...BACKUP_FOLDER_HIERARCHY, agentName];
    let parentFolderId: string | undefined;

    for (const folderName of folders) {
      const cacheKey = parentFolderId
        ? `${parentFolderId}/${folderName}`
        : folderName;
      if (this.folderCache.has(cacheKey)) {
        parentFolderId = this.folderCache.get(cacheKey)!;
        continue;
      }

      const findResult = await this.hostServices.workspaceQuery<{
        getFoldersInFolder: {
          folders: Array<{ id: string; name: string; path: string }>;
        };
      }>(
        `query($folderId:ID,$pagination:PaginationInput){getFoldersInFolder(folderId:$folderId,pagination:$pagination){folders{id name path}}}`,
        { folderId: parentFolderId ?? null, pagination: { limit: 100 } },
      );

      const existing = findResult.data?.getFoldersInFolder?.folders?.find(
        (f) => f.name === folderName,
      );
      if (existing) {
        this.folderCache.set(cacheKey, existing.id);
        parentFolderId = existing.id;
        continue;
      }

      const createResult = await this.hostServices.workspaceQuery<{
        createFolder: FolderResult;
      }>(
        `mutation($input:CreateFolderInput!){createFolder(input:$input){id name path}}`,
        {
          input: {
            name: folderName,
            parentFolderId: parentFolderId ?? null,
            visibility: "WORKSPACE",
          },
        },
      );

      if (createResult.errors?.length)
        throw new Error(
          `Failed to create folder '${folderName}': ${createResult.errors[0].message}`,
        );
      const created = createResult.data!.createFolder;
      this.folderCache.set(cacheKey, created.id);
      parentFolderId = created.id;
    }
    return parentFolderId!;
  }

  async upload(
    filePath: string,
    agentName: string,
    timestamp: string,
  ): Promise<{ storagePath: string; fileId?: string }> {
    if (!this.hostServices.isGatewayConfigured())
      throw new Error(
        "Gateway is not configured. Use 'vibe setup' to configure gateway auth, or switch to custom-s3 storage target.",
      );

    const folderId = await this.ensureFolderHierarchy(agentName);
    this.log.info(`Backup folder ready: ${folderId}`);

    const fileName = `agent-${timestamp}.vcbackup`;
    const fileBuffer = readFileSync(filePath);
    const fileSize = statSync(filePath).size;

    const initiateResult = await this.hostServices.workspaceQuery<{
      initiateUpload: { session: { id: string }; uploadUrl: string };
    }>(
      `mutation($input:InitiateUploadInput!){initiateUpload(input:$input){session{id}uploadUrl}}`,
      {
        input: {
          folderId,
          fileName,
          fileSize: fileSize.toString(),
          mimeType: "application/octet-stream",
          extension: "vcbackup",
        },
      },
    );

    if (initiateResult.errors?.length)
      throw new Error(
        `Failed to initiate upload: ${initiateResult.errors[0].message}`,
      );
    const { session, uploadUrl } = initiateResult.data!.initiateUpload;

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      body: fileBuffer,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!putResponse.ok)
      throw new Error(
        `S3 upload failed: ${putResponse.status} ${putResponse.statusText}`,
      );

    const completeResult = await this.hostServices.workspaceQuery<{
      completeUpload: {
        fileId: string;
        file: { id: string; name: string; size: string };
      };
    }>(
      `mutation($input:CompleteUploadInput!){completeUpload(input:$input){fileId file{id name size}}}`,
      { input: { sessionId: session.id, folderId } },
    );

    if (completeResult.errors?.length)
      throw new Error(
        `Failed to complete upload: ${completeResult.errors[0].message}`,
      );
    const fileId = completeResult.data!.completeUpload.fileId;
    this.log.info(`Backup uploaded: fileId=${fileId}`);
    return {
      storagePath: `backups/vibecontrols/agents/${agentName}/${fileName}`,
      fileId,
    };
  }

  async download(storagePath: string, targetPath: string): Promise<void> {
    if (!this.hostServices.isGatewayConfigured())
      throw new Error("Gateway is not configured.");
    const fileName = basename(storagePath);
    const agentName = storagePath.split("/").slice(-2, -1)[0];
    const folderId = await this.ensureFolderHierarchy(agentName);

    const filesResult = await this.hostServices.workspaceQuery<{
      getFilesInFolder: { files: Array<{ id: string; name: string }> };
    }>(
      `query($folderId:ID,$pagination:PaginationInput){getFilesInFolder(folderId:$folderId,pagination:$pagination){files{id name}}}`,
      { folderId, pagination: { limit: 200 } },
    );

    const file = filesResult.data?.getFilesInFolder?.files?.find(
      (f) => f.name === fileName,
    );
    if (!file) throw new Error(`Backup file not found: ${fileName}`);

    const urlResult = await this.hostServices.workspaceQuery<{
      getFileDownloadUrl: string;
    }>(
      `query($id:ID!,$expiresIn:Int){getFileDownloadUrl(id:$id,expiresIn:$expiresIn)}`,
      { id: file.id, expiresIn: 3600 },
    );
    if (urlResult.errors?.length)
      throw new Error(
        `Failed to get download URL: ${urlResult.errors[0].message}`,
      );

    const response = await fetch(urlResult.data!.getFileDownloadUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    writeFileSync(targetPath, Buffer.from(await response.arrayBuffer()));
  }

  async delete(storagePath: string, fileId?: string): Promise<void> {
    if (!this.hostServices.isGatewayConfigured())
      throw new Error("Gateway is not configured.");
    if (!fileId) {
      const fileName = basename(storagePath);
      const agentName = storagePath.split("/").slice(-2, -1)[0];
      const folderId = await this.ensureFolderHierarchy(agentName);
      const filesResult = await this.hostServices.workspaceQuery<{
        getFilesInFolder: { files: Array<{ id: string; name: string }> };
      }>(
        `query($folderId:ID,$pagination:PaginationInput){getFilesInFolder(folderId:$folderId,pagination:$pagination){files{id name}}}`,
        { folderId, pagination: { limit: 200 } },
      );
      const file = filesResult.data?.getFilesInFolder?.files?.find(
        (f) => f.name === fileName,
      );
      if (!file) return;
      fileId = file.id;
    }
    await this.hostServices.workspaceQuery(
      `mutation($id:ID!){deleteFile(id:$id)}`,
      { id: fileId },
    );
  }

  async list(
    agentName: string,
  ): Promise<Array<{ path: string; size: number; lastModified: string }>> {
    if (!this.hostServices.isGatewayConfigured()) return [];
    try {
      const folderId = await this.ensureFolderHierarchy(agentName);
      const filesResult = await this.hostServices.workspaceQuery<{
        getFilesInFolder: {
          files: Array<{
            id: string;
            name: string;
            size: string;
            createdAt: string;
          }>;
        };
      }>(
        `query($folderId:ID,$pagination:PaginationInput){getFilesInFolder(folderId:$folderId,pagination:$pagination){files{id name size createdAt}}}`,
        { folderId, pagination: { limit: 200 } },
      );
      return (filesResult.data?.getFilesInFolder?.files ?? [])
        .filter((f) => f.name.endsWith(".vcbackup"))
        .map((f) => ({
          path: `backups/vibecontrols/agents/${agentName}/${f.name}`,
          size: parseInt(f.size, 10) || 0,
          lastModified: f.createdAt,
        }))
        .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    } catch {
      return [];
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.hostServices.isGatewayConfigured())
      return {
        ok: false,
        message: "Gateway is not configured. Run 'vibe setup' first.",
      };
    try {
      // wspace-files-svc StorageUsage exposes `filesCount` (and `foldersCount`),
      // not `fileCount`. Querying the wrong name fails composition at the
      // gateway with "Cannot query field 'fileCount' on type 'StorageUsage'".
      const result = await this.hostServices.workspaceQuery<{
        getStorageUsage: { totalSize: string; filesCount: number };
      }>(`query{getStorageUsage{totalSize filesCount}}`);
      if (result.errors?.length)
        return { ok: false, message: result.errors[0].message };
      return { ok: true, message: "Connected to workspace files service" };
    } catch (err) {
      return {
        ok: false,
        message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
