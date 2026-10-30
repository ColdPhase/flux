import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Input, Kreska } from '../ui';
import { useWorkspaceAi } from '../ai/workspaceAi';
import { NEW_PROJECT_AUDIENCE, TEMPLATES, useNewProject } from './newProject';

/** A new project in one step: what it is about and what to start from. People and agents come later (S20). */
export function ProjectSetup() {
  const [projectName, setProjectName] = useState('');
  const { space, spaceName, setSpaceName, template, setTemplate, busy, error, create } = useNewProject();
  const navigate = useNavigate();
  // F-029 (#614): no mention of agents where the workspace's AI is off.
  const aiOff = useWorkspaceAi(space?.id).blocked;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const project = await create(projectName);
    // A new project is restricted; its "People" opens next, to add people (#188).
    if (project) navigate(`/projects/${project.id}?new=1&open=people`);
  }
  const cancel = () => navigate(-1);
  return (
    <div className="pane-scroll">
      <div className="pane-in project-new">
        <form className="project-new__card" aria-labelledby="project-new-title" onSubmit={(event) => void submit(event)}>
          <div className="project-new__head"><h2 id="project-new-title">New project</h2><span>{aiOff ? 'One step — invite people later' : 'One step — invite people and agents later'}</span></div>
          {!space
            ? <Input label="Your space" hint="A private starting place for your projects. You can invite people once your project exists." value={spaceName} onChange={(event) => setSpaceName(event.target.value)} required maxLength={200} />
            : <p className="project-new__space">In {space.name}</p>}
          <Input label="What is it about?" value={projectName} onChange={(event) => setProjectName(event.target.value)} required maxLength={200} autoFocus={!!space} />
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
            {aiOff ? <span>You’ll start with <b>Conversation</b> and <b>Tasks</b>. Map and Wiki appear the first time you need them, for example when someone sketches a thought.</span>
              : <span data-ai-surface="project-setup-agents">You’ll start with <b>Conversation</b> and <b>Tasks</b>. Map, Wiki and Agents appear the first time you need them, for example when someone sketches a thought or connects an agent.</span>}
          </p>
          {error ? <p role="alert" className="project-convo__error">{error}</p> : null}
          <div className="project-new__foot">
            <span>{NEW_PROJECT_AUDIENCE}</span>
            <Button variant="secondary" onClick={cancel}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy}>Create project</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
