-- Private drafts ("Your notes") go (#947, follow-up to #866): the `drafts` API, its table and versions, the summary jobs, the
-- `draft` search kind, a thought's `draft` placement and a material's source draft. Their notes became thoughts on My map.
-- There is no existing data to keep.

-- A material no longer names the draft it was published from; its key and check go with the columns.
ALTER TABLE public.project_material_versions DROP COLUMN source_draft_id, DROP COLUMN source_draft_version;

-- A thought no longer shows a placed object.
ALTER TABLE public.sketch_thoughts DROP COLUMN placement_type, DROP COLUMN placement_id;

-- Search and notifications no longer know a draft.
DELETE FROM public.search_documents WHERE kind = 'draft';
ALTER TABLE public.search_documents DROP CONSTRAINT search_documents_kind_check;
ALTER TABLE public.search_documents ADD CONSTRAINT search_documents_kind_check
  CHECK (kind IN ('project', 'message', 'dm_message', 'material', 'doc', 'work', 'decision', 'result', 'sketch', 'thought', 'person'));
DELETE FROM public.notifications WHERE source_type = 'draft';
ALTER TABLE public.notifications DROP CONSTRAINT notifications_source_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_source_type_check
  CHECK (source_type IN ('workspace', 'project', 'dm'));

-- The tables, with their triggers, and the functions the triggers called.
DROP TABLE public.draft_results, public.draft_versions, public.drafts;
DROP FUNCTION public.preserve_draft_version();
DROP FUNCTION public.search_index_draft();

-- The words the event record had for a draft.
DELETE FROM public.event_data_keys WHERE key IN ('draft', 'draftId');
