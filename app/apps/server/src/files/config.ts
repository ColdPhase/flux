import { FILE_LIMITS } from '@flux/contracts';

/**
 * Stored files (C-61, #1352): the operator's cap for one video, `FLUX_VIDEO_MAX_MIB` (1 to 1,024 MiB, 200 by default). Every other file
 * stays at 5 MiB, and a video of an encrypted space is an ordinary file. A stored size is a 32-bit integer, which is why 1,024 is the top.
 */
export interface FilesConfig {
  /** The most bytes one video of a plain space may have. */
  videoBytes: number;
}

export function loadFilesConfig(env: NodeJS.ProcessEnv): FilesConfig {
  const value = env.FLUX_VIDEO_MAX_MIB?.trim();
  if (!value) return { videoBytes: FILE_LIMITS.videoBytes };
  const mib = Number(value);
  if (!/^\d{1,4}$/.test(value) || mib < 1 || mib > FILE_LIMITS.videoMaxMib)
    throw new Error(`FLUX_VIDEO_MAX_MIB must be a whole number of MiB from 1 to ${FILE_LIMITS.videoMaxMib}`);
  return { videoBytes: mib * 1024 * 1024 };
}
