import { useState, type FormEvent } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import type { ProjectTemplate } from '@flux/contracts';
import { Button, Input, Kreska } from '../ui';
import { createProject, createWorkspace } from './conversation-api';
import { useShellData } from './data';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';

/** What a project can start from (F-026 S20). Conversation is always there; the second line says what else. */
const TEMPLATES: { id: ProjectTemplate; name: string; has: string }[] = [
  { id: 'build', name: 'Build something', has: 'Conversation + Tasks' },
  { id: 'research', name: 'Research', has: 'Conversation + Wiki' },
  { id: 'event', name: 'Plan an event', has: 'Conversation + Tasks' },
  { id: 'blank', name: 'Blank', has: 'Conversation only' },
];

/** A new project in one step: what it is about and what to start from. People and agents come later (S20). */
export function ProjectSetup() {
  const { workspace } = useShellData();
  const [spaceName, setSpaceName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [template, setTemplate] = useState<ProjectTemplate>('build');
  const [createdSpace, setCreatedSpace] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const intents = useIntentKeys();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!projectName.trim() || (!workspace && !createdSpace && !spaceName.trim()) || busy) return;
    setBusy(true); setError('');
    try {
      const spaceIntent = `workspace:${spaceName.trim()}`;
      const space = workspace ?? createdSpace ?? await createWorkspace(spaceName.trim(), intents.keyFor(spaceIntent));
      if (!workspace && !createdSpace) { setCreatedSpace(space); intents.settle(spaceIntent); }
      const projectIntent = `project:${space.id}:${projectName.trim()}:${template}`;
      const project = await createProject(space.id, projectName.trim(), template, intents.keyFor(projectIntent));
      intents.settle(projectIntent);
      revalidator.revalidate();
      // A new project is restricted; its "Who can see this" opens next, to add people (#188).
      navigate(`/projects/${project.id}?new=1&open=people`);
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Could not create this project. Try again.'); }
    finally { setBusy(false); }
  }
  const cancel = () => navigate(-1);
  return (
    <div className="pane-scroll">
      <div className="pane-in project-new">
        <form className="project-new__card" aria-labelledby="project-new-title" onSubmit={(event) => void submit(event)}>
          <div className="project-new__head"><h2 id="project-new-title">New project</h2><span>One step — invite people and agents later</span></div>
          {!workspace && !createdSpace
            ? <Input label="Your space" hint="A private starting place for your projects. You can invite people once your project exists." value={spaceName} onChange={(event) => setSpaceName(event.target.value)} required maxLength={200} />
            : <p className="project-new__space">In {(workspace ?? createdSpace)?.name}</p>}
          <Input label="What is it about?" value={projectName} onChange={(event) => setProjectName(event.target.value)} required maxLength={200} autoFocus={!!workspace || !!createdSpace} />
          <fieldset className="project-new__templates">
            <legend>Start from</legend>
            <div className="project-new__grid">
              {TEMPLATES.map((item) => (
                <label key={item.id} className="project-new__template">
                  <input type="radio" name="template" value={item.id} checked={template === item.id} onChange={() => setTemplate(item.id)} />
                  <b>{item.name}</b><span>{item.has}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="project-new__note">
            <Kreska size={40} expression="hello" />
            <span>You’ll start with <b>Conversation</b> and <b>Tasks</b>. Map, Wiki and Agents appear the first time you need them, for example when someone sketches a thought or connects an agent.</span>
          </p>
          {error ? <p role="alert" className="project-convo__error">{error}</p> : null}
          <div className="project-new__foot">
            <span>Only you can see it until you invite someone</span>
            <Button variant="secondary" onClick={cancel}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy}>Create project</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
