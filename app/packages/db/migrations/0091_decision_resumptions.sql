-- Accept works at once, and its Undo takes the acceptance back (founder decision, Hubert, 2026-11-15, round 8, #1424;
-- docs/development/work-decisions.md "Accept at once, and Undo takes it back"). Accepting a decision resumes the tasks that waited for it;
-- the accept keeps here which tasks it resumed and the version each had right after, so its Undo puts exactly those back to Blocked, and
-- only while none of them changed since (a changed one rests on the acceptance, and the acceptance stays), with the reason each waited
-- with (`blocker`, sealed in an encrypted space as the task's own blocker is). A row goes with its decision or its task.
-- Works on data left by v0.2.0: a new table, nothing to convert (an acceptance made before it has no Undo to take).
CREATE TABLE public.project_decision_resumptions (
    decision_id uuid NOT NULL,
    work_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    version integer NOT NULL,
    blocker text,
    CONSTRAINT project_decision_resumptions_pkey PRIMARY KEY (decision_id, work_id),
    CONSTRAINT project_decision_resumptions_decision_fkey FOREIGN KEY (workspace_id, project_id, decision_id)
        REFERENCES public.project_decisions(workspace_id, project_id, id) ON DELETE CASCADE,
    CONSTRAINT project_decision_resumptions_work_fkey FOREIGN KEY (workspace_id, project_id, work_id)
        REFERENCES public.project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX project_decision_resumptions_work_idx ON public.project_decision_resumptions (work_id);
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON public.project_decision_resumptions FOR EACH ROW
    WHEN (public.workspace_sealed(new.workspace_id)) EXECUTE FUNCTION public.flux_sealed_backstop('workspace_id', 'blocker');
