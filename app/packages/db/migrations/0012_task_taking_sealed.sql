-- #921 left `agent_task_taking` (the one setting "When someone assigns a task to me") without the backstop every AI table that reaches a
-- workspace through its agent has (F-030): AI is always off in an encrypted workspace, and `encrypted-workspaces.test.ts` found the gap.
-- The setting names one of the person's agents, so a row for an agent of a sealed workspace is refused like the rest of the agent's tables.
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON public.agent_task_taking FOR EACH ROW EXECUTE FUNCTION public.sealed_workspace_no_ai();
