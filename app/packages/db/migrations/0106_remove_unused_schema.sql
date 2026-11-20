-- #1552 (C-68): what the first schema-vs-code check (app/tests/app/schema-in-use.test.ts) found that the application no longer uses.
-- - `agent_thread_guard_sequence`: the order of the task-thread receipts (#152). Migration 0040 dropped their table, functions and
--   triggers, and left this sequence behind; nothing reads or advances it.
-- - The search kinds `result` and `draft` (results were removed in 0044, private drafts in 0028): nothing writes either kind.
-- v0.2.1 data: a sequence holds no rows. A search row of a removed kind cannot exist (their writers and triggers are gone); any that a
-- database still holds would name an object that no longer exists, so it is deleted rather than refused by the new check.
DROP SEQUENCE IF EXISTS public.agent_thread_guard_sequence;

DELETE FROM public.search_documents WHERE kind IN ('result', 'draft');
ALTER TABLE public.search_documents DROP CONSTRAINT search_documents_kind_check;
ALTER TABLE public.search_documents ADD CONSTRAINT search_documents_kind_check CHECK (kind = ANY (ARRAY['project'::text, 'message'::text,
  'dm_message'::text, 'material'::text, 'doc'::text, 'work'::text, 'decision'::text, 'sketch'::text, 'thought'::text, 'person'::text, 'file'::text]));
