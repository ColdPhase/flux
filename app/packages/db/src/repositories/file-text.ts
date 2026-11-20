import { sql } from 'drizzle-orm';
import type { Database } from '../handles.js';

/**
 * The rows of the text inside files (C-63, #1382, migration 0072). `file_text_jobs` holds the files the worker has yet to read; the text itself
 * is rows of `search_documents` (kind `file`, `object_id` the file, `version` the part from 1, and part 0 the file's name), so one table serves
 * search, the embeddings and the agents' read. A file of an encrypted space never has a job or a row (the trigger and the claim both check). A file sent in a
 * direct message (C-64 (3), #1590, migration 0109) has the same rows with the conversation as its audience (`dm:<id>`), and is read the same way.
 */
export const FILE_TEXT_CHANNEL = 'flux_file_text';

/** A file the worker is to read. */
export interface FileTextJob { fileId: string; workspaceId: string; name: string; size: number; attempts: number }

/** One part of a file's text, as the chunker made it. */
export interface FileTextPart { part: number; page: number | null; text: string }

/** The picture of one page of a PDF without text (C-69, #1557): a PNG within the bounds of migration 0103. */
export interface FilePagePicture { page: number; width: number; height: number; png: Buffer }
/** What the worker's read found besides text: a PDF without text, and its pages' pictures. */
export interface FileTextRead { pictures: readonly FilePagePicture[]; noText: boolean;
  /** C-70: OCR read this file, and kept its text (`text`) or found nothing confident (`none`); absent when OCR did not read it. */
  ocr?: 'text' | 'none' }

/** What a person or an agent may be told about the text of a file. */
export interface FileTextLocated {
  fileId: string; workspaceId: string; projectId: string; conversationId: string; messageId: string; name: string; size: number;
  /** The pages of a PDF, when the bytes said at upload. */
  pages: number | null;
  /** Whether the worker has yet to read it (or is about to try again). */
  pending: boolean;
  /** C-69: a PDF the worker read and found no text in; its pages' pictures are `pictures`. */
  noText: boolean;
  /** C-70: its text was read by OCR, from a scan's pages or from a picture. */
  ocr: boolean;
}

/** A file sent in a direct message (C-64 (3), #1590): its conversation and the message it was sent with, in place of a space's project and conversation. */
export type DmFileLocated = Omit<FileTextLocated, 'projectId' | 'conversationId'> & { dmId: string };

export function fileTextRows(db: Database) {
  return {
    /**
     * The next file to read, leased for `leaseMs` (a worker that dies leaves its job to be claimed again once the lease is over), or null.
     * A job whose file is gone, no longer published or in an encrypted space is dropped here; one tried `maxAttempts` times is left alone
     * (see `giveUp`).
     */
    async claim(leaseMs: number, maxAttempts: number): Promise<FileTextJob | null> {
      for (;;) {
        const job = await db.transaction(async (tx) => {
          const claimed = (await tx.execute(sql`WITH next AS (
              SELECT j.file_id FROM file_text_jobs j
              WHERE j.attempts < ${maxAttempts} AND (j.claimed_at IS NULL OR j.claimed_at < now() - make_interval(secs => ${leaseMs / 1000}))
              ORDER BY j.queued_at, j.file_id LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE file_text_jobs j SET claimed_at = now(), attempts = j.attempts + 1 FROM next WHERE j.file_id = next.file_id
            RETURNING j.file_id::text AS file_id, j.attempts`)).rows[0] as { file_id: string; attempts: number } | undefined;
          if (!claimed) return 'none' as const;
          const file = (await tx.execute(sql`SELECT f.workspace_id::text AS workspace_id, f.name, f.size FROM project_files f
            WHERE f.id = ${claimed.file_id}::uuid AND f.state = 'ready' AND f.published_at IS NOT NULL AND (f.message_id IS NOT NULL OR f.dm_message_id IS NOT NULL OR f.run_id IS NOT NULL)
              AND f.size IS NOT NULL AND NOT workspace_sealed(f.workspace_id)`)).rows[0] as { workspace_id: string; name: string; size: number } | undefined;
          if (!file) {
            await tx.execute(sql`DELETE FROM file_text_jobs WHERE file_id = ${claimed.file_id}::uuid`);
            return 'gone' as const;
          }
          return { fileId: claimed.file_id, workspaceId: file.workspace_id, name: file.name, size: file.size, attempts: claimed.attempts };
        });
        if (job === 'none') return null;
        if (job !== 'gone') return job;
      }
    },

    /** Drops the jobs that were tried `maxAttempts` times and whose lease is over; their files keep their name row and no text. */
    async giveUp(leaseMs: number, maxAttempts: number): Promise<string[]> {
      const gone = await db.execute(sql`DELETE FROM file_text_jobs WHERE attempts >= ${maxAttempts}
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${leaseMs / 1000})) RETURNING file_id::text AS file_id`);
      const ids = gone.rows.map((row) => (row as { file_id: string }).file_id);
      // A file OCR could not read three times is not queued for OCR again (C-70): its state says it was tried.
      if (ids.length) await db.execute(sql`UPDATE project_files SET ocr_state = 'none' WHERE id = ANY(${sql.param(ids)}::uuid[]) AND ocr_state IS NULL`);
      return ids;
    },

    /**
     * C-70 (#1575), only while OCR is on: queues at most `limit` files OCR has yet to read, newest first (the pictures people sent to a space,
     * a direct message or a chat, and PDFs read without text), when none is queued already. A large install's earlier files are read a batch at a time.
     */
    async queueOcr(limit: number): Promise<number> {
      const queued = await db.execute(sql`INSERT INTO file_text_jobs (file_id)
        SELECT f.id FROM project_files f
        WHERE f.ocr_state IS NULL AND f.published_at IS NOT NULL AND f.poster_of IS NULL
          AND (file_ocr_picture(f.name) OR (f.no_text AND lower(f.name) ~ '[.]pdf$'))
          AND f.state = 'ready' AND f.size IS NOT NULL AND (f.message_id IS NOT NULL OR f.dm_message_id IS NOT NULL OR (f.agent_id IS NOT NULL AND f.run_id IS NOT NULL))
          AND NOT workspace_sealed(f.workspace_id)
          AND NOT EXISTS (SELECT 1 FROM file_text_jobs j WHERE j.file_id = f.id)
        ORDER BY f.published_at DESC LIMIT ${limit}
        ON CONFLICT DO NOTHING`);
      return queued.rowCount ?? 0;
    },

    /** Whether any job is waiting for its lease to end (when to look again after a failure), in milliseconds from now; null when none is. */
    async nextRetryIn(leaseMs: number, maxAttempts: number): Promise<number | null> {
      const row = (await db.execute(sql`SELECT greatest(0, extract(epoch FROM (min(j.claimed_at) + make_interval(secs => ${leaseMs / 1000}) - now())) * 1000)::bigint AS ms
        FROM file_text_jobs j WHERE j.claimed_at IS NOT NULL AND j.attempts < ${maxAttempts}`)).rows[0] as { ms: string | null } | undefined;
      return row?.ms == null ? null : Number(row.ms);
    },

    /**
     * Replaces the text rows of a file with these parts and ends its job, in one transaction that holds the file's row (share): a file deleted
     * in the meantime has no row to lock, and one being deleted waits for this write. False when the file is gone or was never indexable.
     */
    async store(fileId: string, parts: readonly FileTextPart[], read: FileTextRead = { pictures: [], noText: false }): Promise<boolean> {
      // A PDF without text (C-69, #1557): its mark and its pages' pictures, replaced with its text in the same transaction.
      const keepRead = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        await tx.execute(sql`UPDATE project_files SET no_text = ${read.noText} WHERE id = ${fileId}::uuid AND no_text IS DISTINCT FROM ${read.noText}`);
        if (read.ocr) await tx.execute(sql`UPDATE project_files SET ocr_state = ${read.ocr} WHERE id = ${fileId}::uuid`);
        await tx.execute(sql`DELETE FROM file_page_pictures WHERE file_id = ${fileId}::uuid`);
        for (const picture of read.pictures) await tx.execute(sql`INSERT INTO file_page_pictures (file_id, page, width, height, png)
          VALUES (${fileId}::uuid, ${picture.page}, ${picture.width}, ${picture.height}, ${picture.png})`);
      };
      return db.transaction(async (tx) => {
        // A file of an agent's chat (#1438, C-64): its text is kept for that chat's runs only, never as a search row.
        const chat = (await tx.execute(sql`SELECT f.workspace_id::text AS workspace_id, f.agent_id::text AS agent_id FROM project_files f
            WHERE f.id = ${fileId}::uuid AND f.agent_id IS NOT NULL AND f.run_id IS NOT NULL AND f.state = 'ready' AND NOT workspace_sealed(f.workspace_id) FOR SHARE OF f`)).rows[0] as
          { workspace_id: string; agent_id: string } | undefined;
        if (chat) {
          await tx.execute(sql`DELETE FROM agent_chat_file_text WHERE file_id = ${fileId}::uuid`);
          if (parts.length) {
            const payload = JSON.stringify(parts.map((part) => ({ part: part.part, page: part.page, text: part.text })));
            await tx.execute(sql`INSERT INTO agent_chat_file_text (file_id, part, workspace_id, agent_id, page, body)
              SELECT ${fileId}::uuid, (p->>'part')::int, ${chat.workspace_id}::uuid, ${chat.agent_id}::uuid, (p->>'page')::int, p->>'text'
              FROM jsonb_array_elements(${payload}::jsonb) p`);
          }
          await keepRead(tx);
          await tx.execute(sql`DELETE FROM file_text_jobs WHERE file_id = ${fileId}::uuid`);
          return true;
        }
        // A space's file is audienced by its space (`project:<id>`, its conversation the parent); a direct message's (C-64 (3)) by its conversation
        // (`dm:<id>`, no space), the audience of the conversation's messages.
        const file = (await tx.execute(sql`SELECT f.workspace_id::text AS workspace_id, f.project_id::text AS project_id, f.dm_id::text AS dm_id, f.name, f.published_at::text AS at,
              f.uploader_id, f.uploader_agent_id::text AS agent_id, coalesce(m.conversation_id, f.dm_id)::text AS conversation_id
            FROM project_files f LEFT JOIN project_messages m ON m.id = f.message_id
            WHERE f.id = ${fileId}::uuid AND f.state = 'ready' AND f.published_at IS NOT NULL AND (m.id IS NOT NULL OR f.dm_message_id IS NOT NULL)
              AND NOT workspace_sealed(f.workspace_id) FOR SHARE OF f`)).rows[0] as
          { workspace_id: string; project_id: string | null; dm_id: string | null; name: string; at: string; uploader_id: string | null; agent_id: string | null; conversation_id: string } | undefined;
        if (!file) return false;
        const audience = file.dm_id !== null ? `dm:${file.dm_id}` : `project:${file.project_id}`;
        await tx.execute(sql`DELETE FROM search_documents WHERE kind = 'file' AND object_id = ${fileId} AND version >= 1`);
        if (parts.length) {
          const payload = JSON.stringify(parts.map((part) => ({ part: part.part, page: part.page, text: part.text })));
          await tx.execute(sql`INSERT INTO search_documents (doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, version, page, status, title, body,
              author_kind, author_id, at, sealed)
            SELECT 'file:' || ${fileId} || ':' || (p->>'part'), 'file', ${file.workspace_id}::uuid, ${audience}, ${file.project_id}::uuid, ${fileId},
              ${file.conversation_id}::uuid, (p->>'part')::int, (p->>'page')::int, NULL, ${file.name}, p->>'text',
              ${file.uploader_id !== null ? 'human' : 'agent'}, ${file.uploader_id ?? file.agent_id}, ${file.at}::timestamptz, false
            FROM jsonb_array_elements(${payload}::jsonb) p
            ON CONFLICT (doc_key) DO UPDATE SET page = EXCLUDED.page, title = EXCLUDED.title, body = EXCLUDED.body, at = EXCLUDED.at`);
        }
        await keepRead(tx);
        await tx.execute(sql`DELETE FROM file_text_jobs WHERE file_id = ${fileId}::uuid`);
        return true;
      });
    },

    /** A file of a space, as an agent or the preview asks for it: null when it is not a published file of a plain space in this company. */
    async locate(workspaceId: string, fileId: string): Promise<FileTextLocated | null> {
      const row = (await db.execute(sql`SELECT f.id::text AS file_id, f.workspace_id::text AS workspace_id, f.project_id::text AS project_id, m.conversation_id::text AS conversation_id,
            m.id::text AS message_id, f.name, f.size, f.page_count AS pages, f.no_text, f.ocr_state = 'text' AS ocr, EXISTS (SELECT 1 FROM file_text_jobs j WHERE j.file_id = f.id) AS pending
          FROM project_files f JOIN project_messages m ON m.id = f.message_id
          WHERE f.id = ${fileId}::uuid AND f.workspace_id = ${workspaceId}::uuid AND f.state = 'ready' AND f.published_at IS NOT NULL AND f.size IS NOT NULL
            AND NOT workspace_sealed(f.workspace_id)`)).rows[0] as
        { file_id: string; workspace_id: string; project_id: string; conversation_id: string; message_id: string; name: string; size: number; pages: number | null; pending: boolean; no_text: boolean; ocr: boolean | null } | undefined;
      return row ? { fileId: row.file_id, workspaceId: row.workspace_id, projectId: row.project_id, conversationId: row.conversation_id, messageId: row.message_id,
        name: row.name, size: row.size, pages: row.pages, pending: row.pending, noText: row.no_text, ocr: row.ocr === true } : null;
    },

    /**
     * A file its owner sent in an agent's private chat (#1438, C-64), as that chat's run asks for it: null when it is not a sent file of a chat
     * in this company. Who may read it is the caller's to decide (`reachesChatFile`).
     */
    async locateChat(workspaceId: string, fileId: string): Promise<(Omit<FileTextLocated, 'projectId' | 'conversationId' | 'messageId'> & { agentId: string; runId: string; uploaderId: string | null }) | null> {
      const row = (await db.execute(sql`SELECT f.id::text AS file_id, f.workspace_id::text AS workspace_id, f.agent_id::text AS agent_id, f.run_id::text AS run_id,
            f.uploader_id, f.name, f.size, f.page_count AS pages, f.no_text, f.ocr_state = 'text' AS ocr, EXISTS (SELECT 1 FROM file_text_jobs j WHERE j.file_id = f.id) AS pending
          FROM project_files f
          WHERE f.id = ${fileId}::uuid AND f.workspace_id = ${workspaceId}::uuid AND f.agent_id IS NOT NULL AND f.run_id IS NOT NULL AND f.state = 'ready'
            AND f.published_at IS NOT NULL AND f.size IS NOT NULL AND NOT workspace_sealed(f.workspace_id)`)).rows[0] as
        { file_id: string; workspace_id: string; agent_id: string; run_id: string; uploader_id: string | null; name: string; size: number; pages: number | null; pending: boolean; no_text: boolean; ocr: boolean | null } | undefined;
      return row ? { fileId: row.file_id, workspaceId: row.workspace_id, agentId: row.agent_id, runId: row.run_id, uploaderId: row.uploader_id, name: row.name, size: row.size,
        pages: row.pages, pending: row.pending, noText: row.no_text, ocr: row.ocr === true } : null;
    },

    /**
     * A file sent in a direct message (C-64 (3), #1590), as a run in that conversation asks for it: null when it is not a published file of a conversation
     * of this company (a plain workspace's). Who may read it is the caller's to decide: only a run of that conversation whose owner is one of its people now.
     */
    async locateDm(workspaceId: string, fileId: string): Promise<DmFileLocated | null> {
      const row = (await db.execute(sql`SELECT f.id::text AS file_id, f.workspace_id::text AS workspace_id, f.dm_id::text AS dm_id, f.dm_message_id::text AS message_id,
            f.name, f.size, f.page_count AS pages, f.no_text, f.ocr_state = 'text' AS ocr, EXISTS (SELECT 1 FROM file_text_jobs j WHERE j.file_id = f.id) AS pending
          FROM project_files f
          WHERE f.id = ${fileId}::uuid AND f.workspace_id = ${workspaceId}::uuid AND f.dm_id IS NOT NULL AND f.dm_message_id IS NOT NULL AND f.state = 'ready'
            AND f.published_at IS NOT NULL AND f.size IS NOT NULL AND f.poster_of IS NULL AND NOT workspace_sealed(f.workspace_id)`)).rows[0] as
        { file_id: string; workspace_id: string; dm_id: string; message_id: string; name: string; size: number; pages: number | null; pending: boolean; no_text: boolean; ocr: boolean | null } | undefined;
      return row ? { fileId: row.file_id, workspaceId: row.workspace_id, dmId: row.dm_id, messageId: row.message_id, name: row.name, size: row.size, pages: row.pages,
        pending: row.pending, noText: row.no_text, ocr: row.ocr === true } : null;
    },

    /** The text of a chat's file (C-64), the parts joined in order, and how many there are. */
    async chatText(fileId: string): Promise<{ text: string; parts: number }> {
      return (await db.execute(sql`SELECT coalesce(string_agg(body, '' ORDER BY part), '') AS text, count(*)::int AS parts
        FROM agent_chat_file_text WHERE file_id = ${fileId}::uuid`)).rows[0] as { text: string; parts: number };
    },

    /** The pages' pictures of a PDF without text (C-69) in page order, `skip` of them skipped and at most `limit` read, and how many it has in all. */
    async pictures(fileId: string, skip: number, limit: number): Promise<{ total: number; pictures: FilePagePicture[] }> {
      const total = (await db.execute(sql`SELECT count(*)::int AS n FROM file_page_pictures WHERE file_id = ${fileId}::uuid`)).rows[0] as { n: number };
      const rows = (await db.execute(sql`SELECT page, width, height, png FROM file_page_pictures WHERE file_id = ${fileId}::uuid
        ORDER BY page OFFSET ${skip} LIMIT ${limit}`)).rows as unknown as FilePagePicture[];
      return { total: total.n, pictures: rows };
    },

    /** One page's picture of a PDF without text (C-69), for `flux_view_image` with a page (C-70); null when it has none. */
    async picture(fileId: string, page: number): Promise<FilePagePicture | null> {
      const [row] = (await db.execute(sql`SELECT page, width, height, png FROM file_page_pictures WHERE file_id = ${fileId}::uuid AND page = ${page}`)).rows as unknown as FilePagePicture[];
      return row ?? null;
    },

    /** The parts of a file's text with their pages, in order (C-70: OCR text is read with its page numbers); a chat's file from its own rows. */
    async pagedParts(fileId: string, chat: boolean): Promise<{ page: number | null; text: string }[]> {
      const rows = chat
        ? await db.execute(sql`SELECT page, body FROM agent_chat_file_text WHERE file_id = ${fileId}::uuid ORDER BY part`)
        : await db.execute(sql`SELECT page, body FROM search_documents WHERE kind = 'file' AND object_id = ${fileId} AND version >= 1 ORDER BY version`);
      return (rows.rows as { page: number | null; body: string }[]).map((row) => ({ page: row.page, text: row.body }));
    },

    /** The text of a file, the parts joined in order, and how many there are. Empty text and 0 parts when none was read. */
    async text(fileId: string): Promise<{ text: string; parts: number }> {
      const row = (await db.execute(sql`SELECT coalesce(string_agg(body, '' ORDER BY version), '') AS text, count(*)::int AS parts
        FROM search_documents WHERE kind = 'file' AND object_id = ${fileId} AND version >= 1`)).rows[0] as { text: string; parts: number };
      return row;
    },
  };
}
