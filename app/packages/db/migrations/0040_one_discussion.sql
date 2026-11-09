-- #868: a task has one discussion. The agents' thread (a conversation of the "agents" space bound to a task) and the guard that capped its
-- agent messages are gone: agents write in the task's discussion like everyone else, and the per-conversation turn cap is a check in the
-- one append every message goes through (C-51), and a new version of an artifact a task cites no longer gives agents more messages, so the
-- artifact boundaries that did that go too. Which tasks a new version counts as use of, for the Undo of an unused task (#394, #238), is unchanged.
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted; any agents-space conversation of a development
-- database is deleted with its messages.

DROP TRIGGER agent_thread_agent_writes_closed ON public.project_messages;
DROP TRIGGER agent_thread_human_boundary ON public.project_messages;
DROP TRIGGER agent_thread_message_immutable ON public.project_messages;
DROP TRIGGER agent_thread_binding_immutable ON public.project_conversations;

DELETE FROM public.project_messages WHERE conversation_id IN (SELECT id FROM public.project_conversations WHERE space = 'agents');
DELETE FROM public.project_conversations WHERE space = 'agents';

DROP TABLE public.agent_thread_guard_events CASCADE;

DROP FUNCTION public.flux_agent_thread_human_boundary();
DROP FUNCTION public.flux_append_agent_thread_guard();
DROP FUNCTION public.flux_complete_agent_thread_guard();
DROP FUNCTION public.flux_guard_agent_thread_write();
DROP FUNCTION public.flux_keep_agent_thread_identity();

-- The artifact boundaries only replenished the turn budget of the guard above (a new version of something a task cites gave an agent five more
-- messages). With the budget gone they, their witness of canonical changes and the functions around them have no reader: the tasks that a
-- new version marks as used for the Undo of an unused task (#394, #553) are found by the repositories without them.
DROP TRIGGER artifact_pr_delta ON public.github_task_links;
DROP TRIGGER artifact_decision_delta ON public.project_decisions;
DROP TRIGGER artifact_file_delta ON public.project_files;
DROP TRIGGER artifact_material_delta ON public.project_material_versions;
DROP TRIGGER artifact_result_delta ON public.project_results;
DROP TRIGGER artifact_thought_delta ON public.sketch_thoughts;
DROP TABLE public.agent_thread_artifact_resets;
DROP TABLE public.agent_thread_artifact_mutations;
DROP FUNCTION public.flux_artifact_task_is_direct(uuid, public.agent_thread_artifact_boundaries);
DROP TABLE public.agent_thread_artifact_boundaries;
DROP FUNCTION public.flux_append_artifact_reset();
DROP FUNCTION public.flux_capture_artifact_mutation();
DROP FUNCTION public.flux_keep_agent_thread_guard();
DROP FUNCTION public.flux_protect_artifact_mutation();
DROP FUNCTION public.flux_verify_artifact_boundary();
DROP FUNCTION public.flux_artifact_xid_is_current(xid);

-- Every conversation is a people's conversation now.
DROP INDEX public.project_conversations_agent_work_idx;
ALTER TABLE public.project_conversations DROP CONSTRAINT project_conversations_agent_work_check;
ALTER TABLE public.project_conversations DROP CONSTRAINT project_conversations_agent_work_fk;
ALTER TABLE public.project_conversations DROP CONSTRAINT project_conversations_space_check;
ALTER TABLE public.project_conversations DROP COLUMN work_id, DROP COLUMN space;

-- The cap counts the agent messages written since a person last wrote. A line Flux itself writes for an in-app agent (its run report, its
-- question to another agent, the answer, a status line such as "Stopped by Maja") is bounded by the run and by TA-3 instead: it is marked
-- here, and the cap neither counts nor refuses it. Only an agent's line can be one.
ALTER TABLE public.project_messages ADD COLUMN by_flux boolean DEFAULT false NOT NULL;
ALTER TABLE public.project_messages ADD CONSTRAINT project_message_by_flux_agent CHECK (((NOT by_flux) OR (author_agent_id IS NOT NULL)));
