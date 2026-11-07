import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project } from '@flux/contracts';
import { PeoplePicker } from '../people/PeoplePicker';
import { Button, Icon, Input } from '../ui';
import { SwitchRow } from '../ui/SwitchRow';
import '../app/settings.css';
import '../people/space.css';
import { useCompanyCandidates, useNewProject } from './newProject';

/**
 * A new space in one window (F-037, #874, S20): its name, the people (chosen from the company), an AI switch that starts on, and Create
 * space. You are its admin. There are no templates and no goal: every space starts with Conversation, Tasks, Map and Wiki. Every way
 * in (New › Space, Home, the Spaces list) opens this one form.
 */
export function NewSpaceForm({ initialName = '', onCancel, onCreated }: { initialName?: string; onCancel: () => void; onCreated: (project: Project) => void }) {
  const { space, allowed, busy, error, create } = useNewProject();
  const { candidates, loading, companyName } = useCompanyCandidates();
  const [name, setName] = useState(initialName);
  // The form says what is missing in its own words, like sign-in and sign-up, not with the browser's bubble (#763 FR-9).
  const [missing, setMissing] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [ai, setAi] = useState(true);
  // The window opens on its Name (the surface takes focus first; this runs after it).
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setMissing(true); return; }
    const project = await create(name, { ai, people: people.filter((id) => candidates.some((member) => member.userId === id)) });
    if (project) onCreated(project);
  }
  return (
    <form className="newspace" aria-labelledby="newspace-title" noValidate onSubmit={(event) => void submit(event)}>
      <div className="newspace__head">
        <h2 id="newspace-title">New space</h2>
        <button type="button" className="newspace__x" aria-label="Close" onClick={onCancel}><Icon name="x" size={18} /></button>
      </div>
      <Input ref={nameRef} label="Name" aria-label="Space name" placeholder="e.g. Volunteer sign-up app" value={name} onChange={(event) => { setName(event.target.value); setMissing(false); }}
        maxLength={200} error={missing ? 'Give the space a name.' : undefined} />
      <div className="newspace__field">
        <div className="newspace__label">People<span>You’re the admin of this space</span></div>
        {loading ? <p className="pick__none" role="status">Loading people…</p>
          : <PeoplePicker candidates={candidates} value={people} onChange={setPeople} disabled={busy} companyName={companyName} />}
      </div>
      <div className="newspace__switches">
        <SwitchRow label="AI" detail="Agents can work here, with each person’s own AI" checked={ai} onChange={setAi} disabled={busy} />
      </div>
      {!space ? <p role="alert" className="newspace__error">You’re not in a company on this Flux yet. Ask an admin for an invite link.</p>
        : !allowed ? <p role="alert" className="newspace__error">Guests can’t start spaces. Ask someone in {space.name} to add you to one.</p> : null}
      {error ? <p role="alert" className="newspace__error"><Icon name="alert" size={14} />{error}</p> : null}
      <div className="newspace__foot">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!allowed}>Create space</Button>
      </div>
    </form>
  );
}
