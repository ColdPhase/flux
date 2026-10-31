import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Icon, Input, Kreska, Option, Select } from '../ui';
import { useWorkspaceAi } from '../ai/workspaceAi';
import { TEMPLATES, useNewProject } from './newProject';

/** A new project in one step: what it is about and what to start from. People and agents come later (S20). */
export function ProjectSetup() {
  const [projectName, setProjectName] = useState('');
  // The form says what is missing in its own words, like sign-in and sign-up, not with the browser's bubble (#763 FR-9).
  const [missing, setMissing] = useState(false);
  const { space, spaceName, places, choose, audience, template, setTemplate, busy, error, create } = useNewProject();
  const navigate = useNavigate();
  // F-029 (#614): no mention of agents where the workspace's AI is off.
  const aiOff = useWorkspaceAi(space?.id).blocked;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!projectName.trim()) { setMissing(true); return; }
    const project = await create(projectName);
    // A new project is restricted; its "People" opens next, to add people (#188).
    if (project) navigate(`/projects/${project.id}?new=1&open=people`);
  }
  const cancel = () => navigate(-1);
  return (
    <div className="pane-scroll">
      <div className="pane-in project-new">
        <form className="project-new__card" aria-labelledby="project-new-title" noValidate onSubmit={(event) => void submit(event)}>
          <div className="project-new__head"><h2 id="project-new-title">New project</h2><span>{aiOff ? 'One step — invite people later' : 'One step — invite people and agents later'}</span></div>
          {/* Where it goes: named only, or "In … ▾" once the person may create projects in two workspaces (#763 PE-3). */}
          {places.length > 1 ? (
            <label className="project-new__space project-new__space--pick">
              <span>In {spaceName}</span><Icon name="chevron-down" size={12} />
              <Select aria-label="Workspace" value={space?.id ?? ''} onChange={(next) => choose(next)}>
                {places.map((item) => <Option key={item.id} value={item.id}>{item.name}</Option>)}
              </Select>
            </label>
          ) : <p className="project-new__space">In {spaceName}</p>}
          <Input label="What is it about?" value={projectName} onChange={(event) => { setProjectName(event.target.value); setMissing(false); }}
            maxLength={200} autoFocus error={missing ? 'Give the project a name.' : undefined} />
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
            <span>{audience}</span>
            <Button variant="secondary" onClick={cancel}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy}>Create project</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
