import { useState, type FormEvent } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import { Button, Input } from '../ui';
import { createProject, createWorkspace } from './conversation-api';
import { useShellData } from './data';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';

export function ProjectSetup() {
  const { workspace } = useShellData();
  const [spaceName, setSpaceName] = useState('');
  const [projectName, setProjectName] = useState('');
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
      const projectIntent = `project:${space.id}:${projectName.trim()}`;
      const project = await createProject(space.id, projectName.trim(), intents.keyFor(projectIntent));
      intents.settle(projectIntent);
      revalidator.revalidate();
      // A new project is restricted; its "Who can see this" opens next, to add people (#188).
      navigate(`/projects/${project.id}?new=1&open=people`);
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Could not create this project. Try again.'); }
    finally { setBusy(false); }
  }
  return <div className="pane-scroll"><div className="pane-in project-setup"><p className="project-convo__eyebrow">Start together</p><h2>New project</h2><p>A new project is restricted: only you and the workspace’s owners and admins can see it. Next, choose who else can in its <b>Who can see this</b>.</p><form onSubmit={(event) => void submit(event)}>{!workspace && !createdSpace ? <Input label="Your space" hint="A private starting place for your projects. You can invite people once your project exists." value={spaceName} onChange={(event) => setSpaceName(event.target.value)} required maxLength={200} /> : <p className="project-convo__muted">In {(workspace ?? createdSpace)?.name}</p>}<Input label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} required maxLength={200} />{error ? <p role="alert" className="project-convo__error">{error}</p> : null}<Button type="submit" variant="primary" busy={busy}>Create project</Button></form></div></div>;
}
