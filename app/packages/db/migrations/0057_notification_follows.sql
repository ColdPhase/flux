-- A person can follow or unfollow a thread from its header (#1249). A thread (a conversation) is followed, and its replies notify, when
-- the person started it, wrote in it, was mentioned or asked in it, or chose Follow; the row records only an explicit choice (or the
-- follow that a mention made), and a choice wins over those defaults until the person changes it. A person with no row follows by the
-- defaults, so nothing is converted for the threads that exist.
CREATE TABLE public.notification_follows (
    user_id text NOT NULL,
    conversation_id uuid NOT NULL,
    following boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.notification_follows
    ADD CONSTRAINT notification_follows_pkey PRIMARY KEY (user_id, conversation_id);
ALTER TABLE ONLY public.notification_follows
    ADD CONSTRAINT notification_follows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notification_follows
    ADD CONSTRAINT notification_follows_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.project_conversations(id) ON DELETE CASCADE;
CREATE INDEX notification_follows_conversation_idx ON public.notification_follows USING btree (conversation_id);
