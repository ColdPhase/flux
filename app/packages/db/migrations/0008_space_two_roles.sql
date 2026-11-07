-- F-037, #903: a space has two roles, Member (`contributor`) and Admin (`manager`). Read-only people (`viewer`) and an explicit
-- deny (`denied`) are gone. Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.
ALTER TABLE public.project_grants DROP CONSTRAINT project_grants_role_check;
ALTER TABLE public.project_grants ADD CONSTRAINT project_grants_role_check
  CHECK (role = ANY (ARRAY['manager'::text, 'contributor'::text]));

-- An encrypted workspace's events hold registered words only; no event names `viewer` any more.
DELETE FROM public.event_data_tokens WHERE token = 'viewer';
