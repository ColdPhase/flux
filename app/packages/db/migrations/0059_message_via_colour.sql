-- An agent's answer shown to everyone (#1232): the message keeps the colour of the agent whose answer it is, next to the agent's name in `via`,
-- so every reader sees that agent's Kreska in its colour ("Hubert's Assistant"). Null on a message that was not an agent's answer, and on a
-- local client's post, whose `via` is the client's name ("Ada · via Claude Code"). The column may be empty: nothing already stored is lost.
ALTER TABLE public.project_messages ADD COLUMN via_colour text;
ALTER TABLE public.project_messages ADD CONSTRAINT project_messages_via_colour_check
  CHECK (via_colour IS NULL OR (via IS NOT NULL AND via_colour = ANY (ARRAY['ink'::text, 'clay'::text, 'ochre'::text, 'sage'::text, 'teal'::text, 'indigo'::text, 'plum'::text, 'rose'::text])));
ALTER TABLE public.dm_messages ADD COLUMN via_colour text;
ALTER TABLE public.dm_messages ADD CONSTRAINT dm_messages_via_colour_check
  CHECK (via_colour IS NULL OR (via IS NOT NULL AND via_colour = ANY (ARRAY['ink'::text, 'clay'::text, 'ochre'::text, 'sage'::text, 'teal'::text, 'indigo'::text, 'plum'::text, 'rose'::text])));

-- Messages posted before this change (#1232): an answer shown with Show everyone already has its agent's name in `via` and no colour. It reads as the
-- same agent message as a new one, with the default ink Kreska. A direct message's `via` is always such an answer; in a space's conversation a
-- local client's post (its `via` is the label of one of its owner's own client connections, never a server agent's) stays "via Claude Code".
UPDATE public.dm_messages SET via_colour = 'ink' WHERE via IS NOT NULL AND via_colour IS NULL;
UPDATE public.project_messages AS pm SET via_colour = 'ink'
 WHERE pm.via IS NOT NULL AND pm.via_colour IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.agent_connections AS k
      WHERE k.owner_user_id = pm.author_id AND k.compute_source <> 'owner_assistant'
        AND pm.via = left(regexp_replace(CASE k.client_designation WHEN 'codex' THEN 'Codex' WHEN 'claude_code' THEN 'Claude Code' ELSE k.name END, ' on this computer$', '', 'i'), 80));
