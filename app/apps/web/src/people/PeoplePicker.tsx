import { useId, useMemo, useState } from 'react';
import type { WorkspaceMember } from '@flux/contracts';
import { Avatar, Button, Icon } from '../ui';
import './space.css';

/**
 * People chosen from the company (F-037, #874): the chosen ones are one-line chips in a field, and "Add people" opens the company's
 * list under it to tick more. Used by New space and by Space settings, so a person is picked the same way in both. In the settings
 * page one "Add people" button already opened it, so `listOnly` shows the list itself, with its search, and nothing else.
 */
export function PeoplePicker({ candidates, value, onChange, disabled = false, companyName, listOnly = false }: {
  candidates: WorkspaceMember[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; companyName: string; listOnly?: boolean;
}) {
  const [expanded, setOpen] = useState(false);
  const open = listOnly || expanded;
  const [filter, setFilter] = useState('');
  const listId = useId();
  const chosen = candidates.filter((member) => value.includes(member.userId));
  const shown = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return candidates.filter((member) => !text || member.name.toLowerCase().includes(text) || member.email.toLowerCase().includes(text));
  }, [candidates, filter]);
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((item) => item !== id));
  return (
    <div className="pick" data-people-picker="">
      {listOnly ? null : <div className="pick__field">
        {chosen.length ? (
          <ul className="pick__chips" aria-label="Chosen people">
            {chosen.map((member) => (
              <li className="pick__chip" key={member.userId}>
                <Avatar name={member.name} id={member.userId} size="sm" />
                <span className="pick__name">{member.name}</span>
                <button type="button" className="pick__x" aria-label={`Remove ${member.name}`} disabled={disabled} onClick={() => toggle(member.userId, false)}><Icon name="x" size={12} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <Button variant="quiet" size="sm" icon="plus" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => setOpen((on) => !on)}>Add people</Button>
      </div>}
      {open ? (
        <div className="pick__list" id={listId} role="group" aria-label={`People in ${companyName}`}>
          {candidates.length > 6 ? <input className="ui-input pick__filter" type="search" aria-label="Search people" placeholder="Search by name or address" value={filter} onChange={(event) => setFilter(event.target.value)} /> : null}
          {candidates.length ? (
            <ul>
              {shown.map((member) => (
                <li key={member.userId}>
                  <label className="pick__row">
                    <input type="checkbox" checked={value.includes(member.userId)} disabled={disabled} onChange={(event) => toggle(member.userId, event.target.checked)} />
                    <Avatar name={member.name} id={member.userId} size="md" />
                    <span className="pick__who"><b>{member.name}{member.role === 'guest' ? ' (guest)' : ''}</b><span>{member.email}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          ) : <p className="pick__none">There is nobody else in the company yet.</p>}
          {candidates.length && !shown.length ? <p className="pick__none">Nobody matches.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
