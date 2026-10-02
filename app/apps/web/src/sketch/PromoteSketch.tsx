import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import type { PromotionParticipants, PromotionPerson, PromotionTarget, SketchPromotionPreview } from '@flux/contracts';
import { ApiError } from '../api/client';
import { previewPromotion, promoteSketch } from '../api/sketches';
import { useShellData } from '../app/data';
import type { PromoteSketchView } from '../app/shellContext';
import { Avatar, Button, Icon, Input, Spinner, useToast } from '../ui';
import { firstName } from './format';
import '../people/people.css';

type Choice = { kind: 'new' } | { kind: 'existing'; projectId: string };

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Jo, Kai — only you two" or "You, Kai and Ari": the exact readers, the caller first. */
function audienceHeadline(people: PromotionPerson[], meId: string) {
  const humans = [...people.filter((p) => p.id === meId), ...people.filter((p) => p.id !== meId && p.kind === 'human')];
  const agents = people.filter((p) => p.kind === 'agent');
  const names = [...humans.map((p) => (p.id === meId ? 'You' : firstName(p.name))), ...agents.map((p) => p.name)];
  if (humans.length === 2 && !agents.length && humans[0]!.id === meId) return `${firstName(humans[1]!.name)} and you — only you two`;
  if (humans.length === 1 && !agents.length && humans[0]!.id === meId) return 'Only you';
  return joinNames(names);
}

/**
 * "Make it a project…" for a sketch in a direct message (#96, design principle 5). Before anything
 * is shared it shows, from the server's own access policy, exactly who could open the copy and
 * exactly what goes in and what stays in the DM. Confirming sends the preview's token: if the
 * audience or the sketch changed meanwhile, nothing is copied and the new preview is shown.
 * A new project is given to the DM's other people only when the person ticks "Also give … access",
 * unchecked by default (#188); the preview then names them before anything is created.
 */
export function PromoteSketch({ view, dmTitle, onBack }: { view: PromoteSketchView; dmTitle: string | null; onBack: () => void }) {
  const { me } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [preview, setPreview] = useState<SketchPromotionPreview | null>(null);
  // The choice whose preview is on screen; while another one loads, the old one stays dimmed.
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState(view.title);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const audienceId = useId();
  const [reload, setReload] = useState(0);
  // Off by default: nobody joins the project unless the person chooses it (#188).
  const [alsoGrant, setAlsoGrant] = useState(false);
  const mode: PromotionParticipants = alsoGrant ? 'grant' : 'none';
  const choose = (next: Choice) => { setChoice(next); setAlsoGrant(false); };

  // One preview per choice: none (the server proposes one), a new project, or one existing project.
  const choiceKey = !choice ? '' : choice.kind === 'new' ? 'new' : choice.projectId;
  useEffect(() => {
    const controller = new AbortController();
    const requested: Choice | null = !choiceKey ? null : choiceKey === 'new' ? { kind: 'new' } : { kind: 'existing', projectId: choiceKey };
    previewPromotion(view.sketchId, requested, mode, controller.signal).then((next) => {
      const nextKey = !next.target ? '' : next.target.kind === 'new' ? 'new' : next.target.projectId;
      setPreview(next); setProblem(''); setShownKey(`${nextKey}:${mode}:${reload}`);
      if (!requested && next.target) setChoice(next.target.kind === 'new' ? { kind: 'new' } : { kind: 'existing', projectId: next.target.projectId });
    }, (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setShownKey(`${choiceKey}:${mode}:${reload}`);
      setProblem(error instanceof ApiError && error.status === 409 ? error.message
        : error instanceof ApiError && error.status === 404 ? 'This sketch isn’t available any more.'
          : 'The preview couldn’t be loaded. Nothing was shared.');
    });
    return () => controller.abort();
  }, [view.sketchId, choiceKey, mode, reload]);
  const loading = shownKey !== `${choiceKey}:${mode}:${reload}` && !(choiceKey === '' && shownKey?.endsWith(`:${mode}:${reload}`));

  const target: PromotionTarget | null = !preview?.target ? null
    : preview.target.kind === 'new' ? { kind: 'new', name: name.trim() } : { kind: 'existing', projectId: preview.target.projectId };
  const projectName = preview?.target?.kind === 'existing' ? preview.target.projectName : name.trim();

  async function confirm() {
    if (!preview || !target || busy || loading) return;
    if (target.kind === 'new' && !target.name) { setNotice('Give the project a name first.'); return; }
    const signature = JSON.stringify([target, preview.token, mode]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setNotice('');
    try {
      const promoted = await promoteSketch(view.sketchId, target, preview.token, mode, attempt.current.key);
      attempt.current = null;
      onBack();
      revalidator.revalidate();
      const joined = target.kind === 'new' && alsoGrant && invited.length ? ` ${joinNames(invited.map((p) => firstName(p.name)))} can open it too.` : '';
      toast({ message: `${promoted.project.name} now has a copy of “${view.title}”.${joined} The conversation stays private.` });
      navigate(`/projects/${promoted.project.id}/map/${promoted.sketch.id}`);
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.code === 'PROMOTION_CHANGED') {
        const fresh = (error.body as { preview?: SketchPromotionPreview } | null)?.preview;
        if (fresh) setPreview(fresh);
        setNotice('Who can see it, or what goes in, changed just now. Check the preview again, then confirm.');
        return;
      }
      if (error instanceof ApiError && (error.status === 409 || error.status === 403)) { setNotice(error.message); return; }
      setNotice('It couldn’t be copied yet. Nothing was shared; try again.');
    }
  }

  const from = dmTitle ? `From your conversation with ${dmTitle}` : 'From a direct message';
  const people = preview?.audience ?? [];
  const managers = people.filter((p) => p.reason === 'manager' && p.id !== me.user.id);
  // The DM's other people a new project could also be given to: exactly who the checkbox names.
  const invited = preview?.target?.kind !== 'new' ? []
    : alsoGrant ? people.filter((p) => p.reason === 'participant' && p.id !== me.user.id) : preview.leftOut;
  const shown = [...people.filter((p) => p.id === me.user.id), ...people.filter((p) => p.id !== me.user.id)].slice(0, 4);

  return (
    <div className="details promote" aria-busy={loading || undefined}>
      <button type="button" className="details__back" aria-label="Back to Details" onClick={onBack}><Icon name="chevron-left" size={14} />Details</button>
      <p className="details__eyebrow promote__eyebrow"><Icon name="lock" size={12} />{from}</p>
      <h3 className="details__title">Make a project from this sketch</h3>
      <p className="details__lead">A copy of “{view.title}” goes into a project. The sketch here and the conversation stay as they are.</p>

      {problem ? <p className="promote__problem" role="alert"><Icon name="alert" size={13} />{problem}<button type="button" onClick={() => setReload((n) => n + 1)}>Try again</button></p> : null}
      {!preview && !problem ? <div className="promote__loading"><Spinner label="Working out who could see it" /></div> : null}

      {preview ? (
        <div className={`promote__body${loading ? ' is-loading' : ''}`}>
          {preview.canCreateProject && preview.projects.length ? (
            <div className="seg promote__seg" role="radiogroup" aria-label="Where the copy goes">
              <button type="button" role="radio" className="seg__b" aria-checked={choice?.kind === 'new'} onClick={() => choose({ kind: 'new' })}>New project</button>
              <button type="button" role="radio" className="seg__b" aria-checked={choice?.kind === 'existing'}
                onClick={() => choose({ kind: 'existing', projectId: preview.target?.kind === 'existing' ? preview.target.projectId : preview.projects[0]!.id })}>Existing project</button>
            </div>
          ) : null}
          {preview.target?.kind === 'new' ? (
            <Input label="Name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} autoComplete="off" />
          ) : null}
          {preview.target?.kind === 'existing' ? (
            <label className="promote__field">
              <span>Project</span>
              <select value={preview.target.projectId} onChange={(event) => choose({ kind: 'existing', projectId: event.target.value })}>
                {preview.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
          ) : null}
          {!preview.canCreateProject && preview.target ? <p className="promote__hint">Only workspace owners and admins create projects, so the copy goes into a project you can change.</p> : null}
          {!preview.target ? (
            <p className="promote__problem" role="status"><Icon name="lock" size={13} />There’s no project here you can change, and only workspace owners and admins create projects. Ask one of them to make a project for you.</p>
          ) : (
            <>
              <section className="details__sec" aria-labelledby={audienceId}>
                <h4 id={audienceId}>Who can see it</h4>
                <div className="promote__aud">
                  <span className="promote__faces" aria-hidden="true">
                    {shown.map((person) => <Avatar key={person.id} name={person.name} size="md" tone={person.id === me.user.id ? 'me' : 'neutral'} />)}
                  </span>
                  <span>
                    <b>{audienceHeadline(people, me.user.id)}</b>
                    <span className="promote__why">
                      {preview.target.kind === 'new'
                        ? `${managers.length ? `${joinNames(managers.map((p) => firstName(p.name)))} ${managers.length === 1 ? 'manages' : 'manage'} every project in this workspace, so they can open it too. ` : ''}${alsoGrant && invited.length ? `${joinNames(invited.map((p) => firstName(p.name)))} ${invited.length === 1 ? 'is' : 'are'} added because you chose to. Nobody else is.` : managers.length ? 'Nobody else is added.' : 'Nobody else is added. Other people in the workspace see nothing, not even that it exists.'}`
                        : `Everyone who can open ${preview.target.projectName} can open the copy.`}
                    </span>
                    {preview.leftOut.length ? (
                      <span className="promote__why promote__left"><Icon name="alert" size={12} />{preview.target.kind === 'new'
                        ? `${joinNames(preview.leftOut.map((p) => firstName(p.name)))} won’t see it unless you also give them access.`
                        : `${joinNames(preview.leftOut.map((p) => firstName(p.name)))} ${preview.leftOut.length === 1 ? 'isn’t' : 'aren’t'} in ${projectName}, so they won’t see the copy.`}</span>
                    ) : null}
                  </span>
                </div>
                {people.length > 4 ? <p className="promote__all">{people.map((p) => (p.id === me.user.id ? 'You' : p.name)).join(', ')}</p> : null}
                {invited.length ? (
                  <label className="promote__grant">
                    <input type="checkbox" checked={alsoGrant} onChange={(event) => setAlsoGrant(event.target.checked)} aria-labelledby={`${audienceId}-grant-l`} aria-describedby={`${audienceId}-grant`} />
                    <span>
                      <b id={`${audienceId}-grant-l`}>Also give {joinNames(invited.map((p) => firstName(p.name)))} access</b>
                      <span id={`${audienceId}-grant`}>{joinNames(invited.map((p) => p.name))} can then read and write in the new project. Nobody else is added.</span>
                    </span>
                  </label>
                ) : null}
              </section>
              <section className="details__sec" aria-label="What goes in">
                <h4>What goes in</h4>
                <ul className="promote__inc">
                  <li><Icon name="check" size={14} /><span>The sketch <b>“{view.title}”</b> · {plural(preview.content.thoughts, 'thought', 'thoughts')}{preview.content.links ? `, with their ${plural(preview.content.links, 'link', 'links')}` : ''}</span></li>
                  {preview.content.fromMessages ? <li><Icon name="check" size={14} /><span>{plural(preview.content.fromMessages, 'thought', 'thoughts')} started from messages keep who wrote them and when</span></li> : null}
                </ul>
              </section>
              <section className="details__sec" aria-label="What stays in the conversation">
                <h4>What stays in the conversation</h4>
                <ul className="promote__inc">
                  <li><Icon name="lock" size={14} /><span>{preview.staysInDm.messages ? `The other ${plural(preview.staysInDm.messages, 'message', 'messages')} of the conversation` : 'The conversation itself'}, and everything written there later. Nothing is synced to the project.</span></li>
                </ul>
              </section>
              {notice ? <p className="promote__notice" role="alert"><Icon name="alert" size={13} />{notice}</p> : null}
              <div className="details__actions promote__acts">
                <Button variant="primary" busy={busy} aria-disabled={loading || undefined} onClick={() => void confirm()}>
                  {preview.target.kind === 'new' ? 'Create project' : `Copy into ${preview.target.projectName}`}
                </Button>
                <Button variant="quiet" onClick={onBack}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
