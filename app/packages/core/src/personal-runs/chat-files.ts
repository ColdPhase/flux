import type { MessageFile } from '@flux/contracts';
import type { PersonalRunPorts, RunRecord } from './ports.js';

/**
 * The files a request in an agent's chat carries (#1438, C-64): its own, or for a retry those of the run it retries (a retry sends none of its
 * own), followed back a few runs at most. Empty outside a chat.
 */
export async function chatFilesOf(ports: PersonalRunPorts, record: Pick<RunRecord, 'id' | 'projectId' | 'dmId' | 'retryOfRunId' | 'attachmentCount' | 'ownerUserId'>): Promise<MessageFile[]> {
  if (record.projectId !== null || record.dmId !== null || !record.attachmentCount || !ports.runs.runFiles) return [];
  let run: Pick<RunRecord, 'id' | 'retryOfRunId' | 'ownerUserId'> | null = record;
  for (let step = 0; run && step < 10; step += 1) {
    const files = (await ports.runs.runFiles([run.id])).get(run.id);
    if (files?.length) return files;
    const earlier: RunRecord | null = run.retryOfRunId ? await ports.runs.findRun(run.retryOfRunId) : null;
    run = earlier && earlier.ownerUserId === record.ownerUserId ? earlier : null;
  }
  return [];
}
