import { useEffect, useState } from 'react';
import { Avatar, Button, Icon } from '../ui';
import { inviteToSession } from './api';
import { KIND_WORD, type Presentable } from './anchors';
import { DeviceButton } from './DeviceButton';
import { audienceOf } from './LiveEntry';
import type { LiveValue } from './LiveProvider';
import { canPublishScreen, type DiagnosticRow, type MediaPerson } from './media';

function presence(person: MediaPerson): string {
  const parts = [person.mic ? 'microphone on' : 'microphone off'];
  if (person.camera) parts.push('camera on');
  if (person.screen) parts.push('sharing a screen');
  if (person.quality === 'poor') parts.push('weak connection');
  if (person.quality === 'lost') parts.push('connection lost');
  return parts.join(' · ');
}

/**
 * Everything beyond the strip, on request: who is here and who can join, your devices and
 * their real state, quiet, measured connection details and what personal help does (not).
 */
export function LivePanel({ live, presentable, onShow, onClose }: { live: LiveValue; presentable: Presentable | null; onShow(): void; onClose(): void }) {
  const [invited, setInvited] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const [diagOpen, setDiagOpen] = useState(false);
  const people = live.media?.people ?? [];
  const inRoom = new Set(people.map((person) => person.userId));
  const absent = live.people.filter((person) => person.kind === 'human' && !inRoom.has(person.id) && person.id !== live.meId);
  const anchor = live.anchor!;

  const invite = async (userId: string) => {
    if (!live.session) return;
    setInvited((current) => ({ ...current, [userId]: 'sending' }));
    try { await inviteToSession(live.session.id, userId); setInvited((current) => ({ ...current, [userId]: 'sent' })); }
    catch { setInvited((current) => ({ ...current, [userId]: 'failed' })); }
  };

  return (
    <div className="lv-panel">
      <header className="lv-panel__head">
        <p className="lv-panel__k">Working together on this {KIND_WORD[anchor.context.type]}</p>
        <h2 className="lv-panel__t">{anchor.label}</h2>
        <p className="lv-panel__aud"><Icon name="lock" size={12} />{audienceOf(live.people, live.meId)} · the same people who can open it</p>
      </header>

      <section className="lv-panel__sec" aria-labelledby="lv-here">
        <h3 id="lv-here">Here now</h3>
        {live.media?.connection === 'connected' || live.media?.connection === 'reconnecting' ? (
          <ul className="lv-people">
            {people.map((person) => (
              <li key={person.userId} className={`lv-person${person.speaking ? ' is-speaking' : ''}`}>
                <Avatar name={person.local ? live.nameOf(live.meId) : live.nameOf(person.userId)} size="md" tone={person.local ? 'me' : 'neutral'} />
                <span className="lv-person__b"><b>{person.local ? 'You' : live.nameOf(person.userId)}</b><span>{person.local && live.quiet ? 'quiet: not sending or hearing' : presence(person)}</span></span>
                {person.speaking ? <span className="lv-person__speaking">speaking</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="lv-panel__text">Connecting to the media server…</p>}
        {absent.length ? (
          <>
            <h3 className="lv-panel__sub">Can join</h3>
            <ul className="lv-people">
              {absent.map((person) => (
                <li key={person.id} className="lv-person lv-person--absent">
                  <Avatar name={person.name} size="md" />
                  <span className="lv-person__b"><b>{person.name}</b><span>{invited[person.id] === 'sent' ? 'Invited · one quiet item in their inbox' : invited[person.id] === 'failed' ? 'Could not invite. They may no longer have access.' : 'Not in the session'}</span></span>
                  {invited[person.id] === 'sent' ? <Icon name="check" size={14} /> : (
                    <Button variant="quiet" busy={invited[person.id] === 'sending'} onClick={() => void invite(person.id)}>Invite</Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="lv-panel__sec" aria-labelledby="lv-you">
        <h3 id="lv-you">You</h3>
        <div className="lv-devices">
          <DeviceRow live={live} kind="mic" label="Microphone" />
          <DeviceRow live={live} kind="camera" label="Camera" />
          {canPublishScreen() ? <DeviceRow live={live} kind="screen" label="Share a window or screen" /> : (
            <p className="lv-panel__text lv-panel__note"><Icon name="screen" size={14} />This browser cannot share its screen. You can still see screens others share, and show Flux work with <b>Show this</b>.</p>
          )}
        </div>
        {presentable ? (
          <Button variant="secondary" icon="show" block onClick={onShow}>Show “{presentable.label}”</Button>
        ) : <p className="lv-panel__text">Open a task, result, doc or map in this project to show it here.</p>}
        <button type="button" role="switch" aria-checked={live.quiet} className="lv-switch" onClick={() => { live.setQuiet(!live.quiet); }}>
          <span className="lv-switch__track" aria-hidden="true"><span className="lv-switch__knob" /></span>
          <span className="lv-switch__b"><b>Work quietly</b><span>Stops your microphone, camera and screen and what you hear. You stay in the session and can return.</span></span>
        </button>
      </section>

      <section className="lv-panel__sec" aria-labelledby="lv-help">
        <h3 id="lv-help">Help and privacy</h3>
        <p className="lv-help"><Icon name="spark" size={14} /><span><b>Personal assistants</b> are not used in live sessions yet. No assistant hears the room or sees cameras and screens, and nobody can use your AI connection.</span></p>
        <p className="lv-help"><Icon name="mic-off" size={14} /><span><b>Audio notes</b> are not available. Nothing said here is recorded, transcribed or summarized.</span></p>
        <p className="lv-help"><Icon name="alert" size={14} /><span>On phones and tablets the browser may pause sound or camera when you switch apps or lock the screen. Drafts and saved work stay, and Flux reconnects when you come back.</span></p>
      </section>

      <section className="lv-panel__sec">
        <button type="button" className="lv-disclose" aria-expanded={diagOpen} onClick={() => setDiagOpen((open) => !open)}>
          <Icon name={diagOpen ? 'chevron-down' : 'chevron-right'} size={14} />Connection details
        </button>
        {diagOpen ? <Diagnostics live={live} /> : null}
      </section>

      <footer className="lv-panel__foot">
        <Button variant="quiet" onClick={onClose}>Close</Button>
        <Button variant="danger" icon="leave" onClick={() => { onClose(); void live.leave(); }}>Leave session</Button>
      </footer>
    </div>
  );
}

function DeviceRow({ live, kind, label }: { live: LiveValue; kind: 'mic' | 'camera' | 'screen'; label: string }) {
  const status = live.media?.devices[kind];
  return (
    <div className="lv-device">
      <DeviceButton kind={kind} live={live} compact />
      <span className="lv-device__b"><b>{label}</b><span>{status?.note ?? (status?.state === 'on' ? 'On and sent to everyone here' : status?.state === 'starting' ? 'Waiting for the browser…' : 'Off')}</span></span>
    </div>
  );
}

/** Measured values, refreshed every two seconds while open: resolution, frame rate, bitrate, loss. */
function Diagnostics({ live }: { live: LiveValue }) {
  const [rows, setRows] = useState<DiagnosticRow[] | null>(null);
  const diagnostics = live.diagnostics;
  const nameOf = live.nameOf;
  useEffect(() => {
    if (!diagnostics) return;
    let stopped = false;
    const tick = async () => {
      const next = await diagnostics(nameOf).catch(() => null);
      if (!stopped) setRows(next);
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [diagnostics, nameOf]);
  if (!rows) return <p className="lv-panel__text">Measuring…</p>;
  return (
    <div className="lv-diag" role="table" aria-label="Measured connection details">
      {rows.map((row, index) => (
        <div key={`${row.who}-${row.what}-${index}`} className="lv-diag__row" role="row">
          <span role="cell" className="lv-diag__who">{row.who}</span>
          <span role="cell" className="lv-diag__what">{row.what}</span>
          <span role="cell" className="lv-diag__v">{row.values.join(' · ')}</span>
          {row.warning ? <span role="cell" className="lv-diag__warn"><Icon name="alert" size={12} />{row.warning}</span> : null}
        </div>
      ))}
      <p className="lv-panel__text">Quality adjusts automatically to each person’s connection. Hidden videos are paused.</p>
    </div>
  );
}
