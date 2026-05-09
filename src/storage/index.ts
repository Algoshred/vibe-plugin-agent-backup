import type {
  AgentHostServices,
  BackupConfig,
  StorageTarget,
} from "../types.js";
import { WspaceStorageTarget } from "./wspace-target.js";
import { CustomS3StorageTarget } from "./custom-s3-target.js";

export function createStorageTarget(
  config: BackupConfig,
  hostServices: AgentHostServices,
): StorageTarget {
  if (config.storageTarget === "custom-s3") {
    if (!config.customS3)
      throw new Error(
        "Custom S3 configuration is required when storageTarget is 'custom-s3'",
      );
    return new CustomS3StorageTarget(config.customS3);
  }
  return new WspaceStorageTarget(hostServices);
}
