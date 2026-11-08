-- #874, #848 (F-037, F-030): an encrypted space is an encrypted workspace that holds exactly one space and belongs to the company. The
-- link says which company it hides behind, so the company's owners and admins can see that it exists and delete it (they hold no key and
-- are not in it), so adding a person to it is limited to the company's people, and so leaving the company ends a person's place in it.
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted. A workspace made without a company (the test
-- deployment's fixture creation) has no link and behaves as before.
ALTER TABLE public.workspaces ADD COLUMN company_workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX workspaces_company_workspace_idx ON public.workspaces (company_workspace_id) WHERE company_workspace_id IS NOT NULL;
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_company_workspace_check
  CHECK (company_workspace_id IS NULL OR (encrypted AND company_workspace_id <> id));

-- The company is never itself an encrypted space (review of #976): a member of an encrypted space who named its workspace as "the
-- company" would make a space the company's admins cannot see or delete, and keep it after leaving the company. A workspace's encryption
-- cannot change (workspace_encryption_immutable), so checking the link when it is written is enough.
CREATE FUNCTION public.workspace_company_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_workspace_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspaces parent WHERE parent.id = NEW.company_workspace_id AND parent.encrypted) THEN
    RAISE EXCEPTION 'An encrypted space belongs to the company, never to another encrypted space' USING ERRCODE = 'FX409', HINT = 'ENCRYPTED_SPACE_COMPANY_ONLY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_company_link_guard BEFORE INSERT OR UPDATE OF company_workspace_id ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.workspace_company_link_guard();
