-- A decision has one discussion (founder decision, Hubert, 2026-11-15, #1424; docs/development/work-decisions.md "A decision's
-- discussion"): Discuss starts a thread on the decision's card in the space's conversation, and the decision's panel shows the same
-- thread. As a task's discussion (project_task_discussions), the first message written about the decision creates one ordinary
-- conversation of the space and binds it here, to its sequence-1 root, in the same transaction; every later message is a reply in it.
-- Ids only (an encrypted space seals the messages, not this row); a row goes with its decision, its conversation or its root.
-- Works on data left by v0.2.0: a new table, nothing to convert (no decision has a discussion yet).
CREATE TABLE public.project_decision_discussions (
    decision_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    root_message_id uuid NOT NULL,
    root_sequence integer DEFAULT 1 NOT NULL,
    CONSTRAINT project_decision_discussions_pkey PRIMARY KEY (decision_id),
    CONSTRAINT project_decision_discussions_conversation_id_key UNIQUE (conversation_id),
    CONSTRAINT project_decision_discussions_root_message_id_key UNIQUE (root_message_id),
    CONSTRAINT project_decision_discussions_root_sequence_check CHECK (root_sequence = 1),
    CONSTRAINT project_decision_discussions_decision_fkey FOREIGN KEY (workspace_id, project_id, decision_id)
        REFERENCES public.project_decisions(workspace_id, project_id, id) ON DELETE CASCADE,
    CONSTRAINT project_decision_discussions_conversation_fkey FOREIGN KEY (workspace_id, project_id, conversation_id)
        REFERENCES public.project_conversations(workspace_id, project_id, id) ON DELETE CASCADE,
    CONSTRAINT project_decision_discussions_root_fkey FOREIGN KEY (conversation_id, root_message_id, root_sequence)
        REFERENCES public.project_messages(conversation_id, id, sequence) ON DELETE CASCADE
);
