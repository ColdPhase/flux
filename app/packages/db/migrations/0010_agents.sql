-- #857 (F-036 AG-1): everything is an agent. Each of a person's agents has a name, saved instructions, its own model, its own
-- Kreska colour and a memory; the first is Assistant. Flux has no installations yet (founder, 2026-10-31): nothing is converted.

-- The AI setup of an agent is one row per agent: its rights connection (holding "What it may do"), the model it runs on, its
-- instructions and its colour. It replaces the person's one enablement and their one assistant per company, so there is no pause
-- switch, no "turn off" and no chosen assistant per company any more.
DROP TABLE public.personal_run_agents;
DROP TABLE public.personal_run_enablements;

ALTER TABLE public.assistant_settings DROP CONSTRAINT assistant_settings_pkey;
ALTER TABLE public.assistant_settings ADD CONSTRAINT assistant_settings_pkey PRIMARY KEY (agent_id);
ALTER TABLE public.assistant_settings
  ADD COLUMN instructions text DEFAULT '' NOT NULL,
  ADD COLUMN colour text DEFAULT 'ink' NOT NULL,
  -- `runtime`: the person's own Claude Code or Codex (a plan); `server`: their API key, `api_key_id`.
  ADD COLUMN engine text DEFAULT 'runtime' NOT NULL,
  ADD COLUMN api_key_id uuid,
  ADD COLUMN provider text DEFAULT 'anthropic' NOT NULL,
  ADD COLUMN model text;
ALTER TABLE public.assistant_settings
  ALTER COLUMN engine DROP DEFAULT,
  ALTER COLUMN provider DROP DEFAULT,
  ADD CONSTRAINT assistant_settings_instructions_check CHECK (char_length(instructions) <= 4000),
  ADD CONSTRAINT assistant_settings_colour_check CHECK (colour = ANY (ARRAY['ink', 'clay', 'ochre', 'sage', 'teal', 'indigo', 'plum', 'rose'])),
  ADD CONSTRAINT assistant_settings_engine_check CHECK (engine = ANY (ARRAY['server', 'runtime'])),
  ADD CONSTRAINT assistant_settings_provider_check CHECK (provider = ANY (ARRAY['anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible'])),
  ADD CONSTRAINT assistant_settings_model_check CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  ADD CONSTRAINT assistant_settings_key_check CHECK ((engine = 'server') = (api_key_id IS NOT NULL));
-- A person has several agents, each with its own rights connection: one connection per agent, not one per person.
DROP INDEX public.agent_connections_assistant_owner_idx;
CREATE UNIQUE INDEX agent_connections_assistant_agent_idx ON public.agent_connections USING btree (agent_id) WHERE (compute_source = 'owner_assistant'::text);
CREATE INDEX assistant_settings_owner_idx ON public.assistant_settings USING btree (owner_user_id, created_at, agent_id);

-- What an agent was told to remember (AG-1): only the owner's own message or edit adds an item, and only the owner reads it.
CREATE TABLE public.agent_memory_items (
    id uuid PRIMARY KEY,
    agent_id uuid NOT NULL REFERENCES public.assistant_settings(agent_id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    owner_user_id text NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
    body text NOT NULL,
    source text DEFAULT 'Added by you' NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_memory_items_body_check CHECK (char_length(body) BETWEEN 1 AND 500),
    CONSTRAINT agent_memory_items_source_check CHECK (char_length(source) BETWEEN 1 AND 160)
);
CREATE INDEX agent_memory_items_agent_idx ON public.agent_memory_items USING btree (agent_id, created_at, id);
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON public.agent_memory_items FOR EACH ROW EXECUTE FUNCTION public.sealed_workspace_no_ai();

-- The operations that store an idempotent response with no workspace (F-030): the assistant's enable, pause, resume and
-- agent choice go with the enablement; a person's agents have their own.
DELETE FROM public.idempotency_account_operations WHERE operation = ANY (ARRAY[
  'PATCH /api/v1/personal-assistant', 'POST /api/v1/personal-assistant', 'POST /api/v1/personal-assistant/pause',
  'POST /api/v1/personal-assistant/resume', 'PUT /api/v1/personal-assistant/agents']);
INSERT INTO public.idempotency_account_operations (operation) VALUES
  ('POST /api/v1/my-agents'),
  ('PATCH /api/v1/my-agents/:agentId'),
  ('DELETE /api/v1/my-agents/:agentId'),
  ('POST /api/v1/my-agents/:agentId/memory'),
  ('PATCH /api/v1/my-agents/:agentId/memory/:itemId'),
  ('DELETE /api/v1/my-agents/:agentId/memory/:itemId');
