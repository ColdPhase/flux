-- The order of a person's Spaces list (#1250, v0.2.1): one row per person and space they moved, `position` counting from 0 among the
-- rows the person has. A space without a row (a new one, or one the person never moved) goes after the ordered ones, in the order the
-- spaces were made in; Everyone is never stored, it is always first. The order is the person's own and is the same on every device.
CREATE TABLE public.space_order (
    user_id text NOT NULL,
    project_id uuid NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT space_order_pkey PRIMARY KEY (user_id, project_id),
    CONSTRAINT space_order_position_check CHECK (("position" >= 0)),
    CONSTRAINT space_order_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE,
    CONSTRAINT space_order_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE
);
CREATE INDEX space_order_project_idx ON public.space_order USING btree (project_id);
