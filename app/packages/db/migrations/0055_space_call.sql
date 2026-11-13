-- A call of the space (F-041, #1223 point 1, #1230): a call started from a space's conversation belongs to the space ("Call in <space>"),
-- not to the message that happened to be newest. Such a session names no conversation, task, map or page: at most one of them is set.
-- Sessions left by v0.2.0 all name exactly one, so they stay valid.
ALTER TABLE public.live_sessions DROP CONSTRAINT live_sessions_check;
ALTER TABLE public.live_sessions ADD CONSTRAINT live_sessions_check CHECK (num_nonnulls(conversation_id, work_id, sketch_id, doc_id) <= 1);
