-- A guest's space admin roles are held, not lost (personas-35, coordinator decision 2026-11-16). Becoming a guest ends a person's space admin
-- roles, as before; each grant it changed is marked, and becoming a member (or an admin or owner) again gives those roles back, as their agents
-- and keys come back (AG-2, C-50). So the 10 s Undo of a role change, which picks the old role again, restores everything the change removed.
ALTER TABLE public.project_grants ADD COLUMN admin_held boolean NOT NULL DEFAULT false;
