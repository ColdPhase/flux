-- Accounts and password resets by link (#1471; docs/development/access-policy.md#password-reset-links-1471). Number 0082 was assigned by
-- the coordinator; 0078–0081 belong to other changes of v0.2.1, so the gap is expected and FLUX_SCHEMA_VERSION is the highest file present.
--
-- A reset link's token is a Better Auth `reset-password:` verification value, which Better Auth keeps only as the SHA-256 (base64url) of
-- its identifier. This table records each link (for whom, by whom, how, when it was used or stopped working) by that same hash, so a
-- link used, or a newer one, can end the account's other links. It never holds the token. Works on data left by v0.2.0: a new table.
CREATE TABLE public.password_reset_links (
    id uuid NOT NULL,
    user_id text NOT NULL,
    verification_identifier text NOT NULL,
    via text NOT NULL,
    made_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    stopped_at timestamp with time zone,
    CONSTRAINT password_reset_links_pkey PRIMARY KEY (id),
    CONSTRAINT password_reset_links_identifier_key UNIQUE (verification_identifier),
    CONSTRAINT password_reset_links_via_check CHECK (via = ANY (ARRAY['settings'::text, 'command'::text, 'email'::text])),
    CONSTRAINT password_reset_links_maker_check CHECK (via = 'settings' OR made_by IS NULL),
    CONSTRAINT password_reset_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE,
    CONSTRAINT password_reset_links_made_by_fkey FOREIGN KEY (made_by) REFERENCES public.auth_users(id) ON DELETE SET NULL
);

CREATE INDEX password_reset_links_open_idx ON public.password_reset_links (user_id) WHERE used_at IS NULL AND stopped_at IS NULL;

-- `FLUX_SIGNUP=verified` is gone (#1471): no account waits for its address to be verified before it may sign in.
ALTER TABLE public.auth_users DROP COLUMN verification_required;
