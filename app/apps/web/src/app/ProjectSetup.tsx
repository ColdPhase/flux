import { useState, type FormEvent } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import { Button, Input } from '../ui';
import { createProject, createWorkspace } from './conversation-api';
import { useShellData } from './data';
import { ApiError } from '../api/client';

export function ProjectSetup() {
  const { workspace } = useShellData();
  const [spaceName, setSpaceName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [createdSpace, setCreatedSpace] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!projectName.trim() || (!workspace && !createdSpace && !spaceName.trim()) || busy) return;
    setBusy(true); setError('');
    try {
      const space = workspace ?? createdSpace ?? await createWorkspace(spaceName.trim());
      if (!workspace && !createdSpace) setCreatedSpace(space);
      const project = await createProject(space.id, projectName.trim());
      revalidator.revalidate(); navigate(`/projects/${project.id}`);
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Could not create this project. Try again.'); }
    finally { setBusy(false); }
  }
  return <div className="pane-scroll"><div className="pane-in project-setup"><p className="project-convo__eyebrow">Start together</p><h2>New project</h2><p>A project has its own audience. Its conversation and materials stay with the people you give access to.</p><form onSubmit={(event) => void submit(event)}>{!workspace && !createdSpace ? <Input label="Your space" hint="A private starting place for your projects. You can invite people later." value={spaceName} onChange={(event) => setSpaceName(event.target.value)} required maxLength={200} /> : <p className="project-convo__muted">In {(workspace ?? createdSpace)?.name}</p>}<Input label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} required maxLength={200} />{error ? <p role="alert" className="project-convo__error">{error}</p> : null}<Button type="submit" variant="primary" busy={busy}>Create project</Button></form></div></div>;
}
