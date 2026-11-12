import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRevalidator } from 'react-router';
import { PICTURE_LIMITS, type Project, type SpaceIcon } from '@flux/contracts';
import { removeSpaceIcon, setSpaceEmoji, setSpacePicture } from '../project/api';
import { Button, Icon } from '../ui';
import { SpaceFace } from '../ui/SpaceFace';
import { photoProblem } from './photos';
import { problemText } from './api';

/** The picker's emoji (F-040, design README "Space icons"): 32 calm, common ones, in rows of 8. */
export const SPACE_EMOJI = [
  '🌱', '🌿', '🌻', '🍀', '🌊', '🔥', '⭐', '☀️',
  '🌙', '⚡', '💡', '🎯', '🚀', '🛠️', '📦', '📚',
  '📝', '📣', '💬', '🎨', '🎵', '📷', '🧪', '🔬',
  '💻', '📈', '💰', '🏠', '🏗️', '🚲', '☕', '❤️',
];

const KIND = (icon: SpaceIcon | null | undefined) => (icon?.emoji ? 'Emoji' : icon?.picture ? 'Picture' : 'Letter');
type Choice = { emoji: string } | { file: File; url: string } | { letter: true };

/**
 * The space's icon (F-040, #1227) as the second row of its Name card: the tile and its kind, and Change for the people who can rename
 * the space. Change opens in place: the emoji, Choose a picture… and Use the letter, the tile beside the name showing the choice,
 * and one Save icon.
 */
export function SpaceIconRow({ project, manager, companyName, onChanged }: {
  project: Project; manager: boolean; companyName: string; onChanged: (message: string) => void;
}) {
  const revalidator = useRevalidator();
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const pictureUrl = choice && 'url' in choice ? choice.url : null;
  useEffect(() => () => { if (pictureUrl) URL.revokeObjectURL(pictureUrl); }, [pictureUrl]);
  const close = () => { setOpen(false); setChoice(null); setProblem(''); requestAnimationFrame(() => changeRef.current?.focus({ preventScroll: true })); };
  async function pick(file: File | undefined) {
    if (!file) return;
    const found = await photoProblem(file, { bytes: PICTURE_LIMITS.spaceIconBytes, words: 'A space icon is at most 2 MB.' });
    if (found) { setChoice(null); setProblem(found); return; }
    setProblem('');
    setChoice({ file, url: URL.createObjectURL(file) });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!choice || busy) return;
    setBusy(true); setProblem('');
    try {
      if ('emoji' in choice) await setSpaceEmoji(project.id, choice.emoji);
      else if ('file' in choice) await setSpacePicture(project.id, choice.file);
      else await removeSpaceIcon(project.id);
      close();
      onChanged('letter' in choice ? `${project.name} shows its letter again.` : `${project.name} has a new icon.`);
      revalidator.revalidate();
    } catch (error) {
      setProblem(problemText(error, { workspace: companyName }) || 'The icon could not be saved. Try again.');
    } finally { setBusy(false); }
  }
  // The tile beside the name shows the choice before it is saved.
  const shown: SpaceIcon | null = !choice ? project.icon : 'emoji' in choice ? { emoji: choice.emoji } : null;
  return (
    <div className="spset__icon" data-space-icon="">
      <div className="sset-row spset__name">
        <span className="spset__tile" aria-hidden="true">
          {choice && 'url' in choice ? <img className="space-face space-face--pic" alt="" src={choice.url} /> : <SpaceFace name={project.name} icon={shown} size={28} />}
        </span>
        <span className="spset__icon-b"><b>Icon</b><span className="sset-row__s">{choice ? 'Not saved yet' : KIND(project.icon)}</span></span>
        {manager ? <Button ref={changeRef} variant="quiet" aria-expanded={open} aria-controls={open ? formId : undefined} aria-label={open ? 'Cancel the icon change' : `Change the icon of ${project.name}`}
          onClick={() => (open ? close() : setOpen(true))}>{open ? 'Cancel' : 'Change'}</Button> : null}
      </div>
      {open ? (
        <form id={formId} className="spset__icon-form" noValidate onSubmit={(event) => void save(event)}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
          <input ref={input} className="ui-vh" type="file" accept="image/png,image/jpeg,image/webp" tabIndex={-1} aria-hidden="true"
            onChange={(event) => { void pick(event.target.files?.[0]); event.target.value = ''; }} />
          <div className="spset__emoji" role="group" aria-label="Emoji">
            {SPACE_EMOJI.map((emoji) => {
              const on = !!choice && 'emoji' in choice && choice.emoji === emoji;
              return (
                <button key={emoji} type="button" className={`spset__emoji-b${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={emoji}
                  onClick={() => { setProblem(''); setChoice({ emoji }); }}>
                  <span className="spset__tile" aria-hidden="true">{emoji}</span>
                </button>
              );
            })}
          </div>
          {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
          <div className="details__actions">
            <Button variant="quiet" onClick={() => input.current?.click()}>Choose a picture…</Button>
            {project.icon ? <Button variant="quiet" aria-pressed={!!choice && 'letter' in choice} onClick={() => { setProblem(''); setChoice({ letter: true }); }}>Use the letter</Button> : null}
            {choice ? <Button type="submit" variant="primary" busy={busy}>Save icon</Button> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
