import { FILE_LIMITS } from '@flux/contracts';

/**
 * Stored files (C-61, #1352, #1549): the operator's caps for one file, `FLUX_FILE_MAX_MIB` (1 to 1,024 MiB, 25 by default), and for one video,
 * `FLUX_VIDEO_MAX_MIB` (1 to 1,024 MiB, 200 by default), of a plain space, a direct message or an agent chat. A picture and every file of an
 * encrypted space stay at 5 MiB, and a video of an encrypted space is an ordinary file. A stored size is a 32-bit integer, which is why 1,024 is
 * the top.
 */
export interface FilesConfig {
  /** The most bytes one file other than a video may have. */
  fileBytes: number;
  /** The most bytes one video of a plain space may have. */
  videoBytes: number;
}

function mibSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, top: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const mib = Number(value);
  if (!/^\d{1,4}$/.test(value) || mib < 1 || mib > top) throw new Error(`${name} must be a whole number of MiB from 1 to ${top}`);
  return mib * 1024 * 1024;
}

export function loadFilesConfig(env: NodeJS.ProcessEnv): FilesConfig {
  return {
    fileBytes: mibSetting(env, 'FLUX_FILE_MAX_MIB', FILE_LIMITS.fileBytes, FILE_LIMITS.fileMaxMib),
    videoBytes: mibSetting(env, 'FLUX_VIDEO_MAX_MIB', FILE_LIMITS.videoBytes, FILE_LIMITS.videoMaxMib),
  };
}
