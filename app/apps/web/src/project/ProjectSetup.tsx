import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Input, Kreska } from '../ui';
import { useNewProject } from './newProject';

/** A new space in one step (F-037): its name. Every space starts with Conversation, Tasks, Map and Wiki; people come next. */
export function ProjectSetup() {
  const [projectName, setProjectName] = useState('');
  // The form says what is missing in its own words, like sign-in and sign-up, not with the browser's bubble (#763 FR-9).
  const [missing, setMissing] = useState(false);
  const { space, allowed, audience, busy, error, create } = useNewProject();
  const navigate = useNavigate();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!projectName.trim()) { setMissing(true); return; }
    const project = await create(projectName);
    // Only its creator is in a new space; its people open next, to add others (#188).
    if (project) navigate(`/projects/${project.id}?new=1&open=people`);
  }
  const cancel = () => navigate(-1);
  return (
    <div className="pane-scroll">
      <div className="pane-in project-new">
        <form className="project-new__card" aria-labelledby="project-new-title" noValidate onSubmit={(event) => void submit(event)}>
          <div className="project-new__head"><h2 id="project-new-title">New space</h2><span>One step — add people next</span></div>
          <Input label="Space name" placeholder="e.g. Volunteer sign-up app" value={projectName} onChange={(event) => { setProjectName(event.target.value); setMissing(false); }}
            maxLength={200} autoFocus error={missing ? 'Give the space a name.' : undefined} />
          <p className="project-new__note">
            <Kreska size={40} expression="hello" />
            <span>Every space starts with <b>Conversation</b>, <b>Tasks</b>, <b>Map</b> and <b>Wiki</b>.</span>
          </p>
          {!space ? <p role="alert" className="project-convo__error">You’re not in a company on this Flux yet. Ask an admin for an invite link.</p>
            : !allowed ? <p role="alert" className="project-convo__error">Guests can’t start spaces. Ask someone in {space.name} to add you to one.</p> : null}
          {error ? <p role="alert" className="project-convo__error">{error}</p> : null}
          <div className="project-new__foot">
            <span>{audience}</span>
            <Button variant="secondary" onClick={cancel}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!allowed}>Create space</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
