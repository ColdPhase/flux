import { useEffect, useState } from 'react';
import type { LiveCallLine } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { Avatar, AuthorFace, Button } from '../ui';
import { callLines } from './api';
import { LIVE_CHANGED_EVENT, useLive } from './LiveProvider';
import { useJoinCall } from './useJoinCall';

/**
 * The calls of a space's conversation, or of one task's discussion (F-041 point 6). Read when the conversation opens and again when a
 * call of the space starts, changes its people or ends (`project.live_changed.v1`); no timer reads them (#862).
 */
export function useCallLines(projectId: string, taskId: string | null = null): LiveCallLine[] {
  const { capability, meId } = useLive();
  const enabled = capability === 'configured';
  const [tick, setTick] = useState(0);
  const key = `${meId}:${projectId}:${taskId ?? ''}`;
  const [lines, setLines] = useState<{ key: string; items: LiveCallLine[] }>({ key, items: [] });
  useStreamEvents(meId, (event) => { if (enabled && event.kind === LIVE_CHANGED_EVENT && event.objectId === projectId) setTick((n) => n + 1); },
    () => { if (enabled) setTick((n) => n + 1); });
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    callLines(projectId, taskId, controller.signal).then((page) => setLines({ key, items: page.items }), () => undefined);
    return () => controller.abort();
  }, [enabled, key, projectId, taskId, tick]);
  return lines.key === key ? lines.items : [];
}

const minutes = (from: string, to: number) => Math.max(1, Math.round((to - Date.parse(from)) / 60_000));
const first = (name: string) => name.trim().split(/\s+/)[0] || name;
function list(names: string[]) {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The words of a call's line without its starter's name (F-041): what a task's activity says after "Hubert". */
export function callWords(line: LiveCallLine, nameOf: (userId: string) => string, now: number): { named: boolean; text: string } {
  const others = line.joinedBy.filter((userId) => userId !== line.startedBy);
  if (line.endedAt === null) {
    const count = line.inCall?.length ?? 0;
    return { named: true, text: `started a call${count ? ` · ${count} ${count === 1 ? 'person' : 'people'}` : ''} · ${minutes(line.startedAt, now)} min` };
  }
  if (!others.length) return { named: true, text: 'called · nobody joined' };
  const people = [...new Set([line.startedBy, ...line.joinedBy])].map((userId) => first(nameOf(userId)));
  return { named: false, text: `Call · ${minutes(line.startedAt, Date.parse(line.endedAt))} min · ${list(people)}` };
}

/** The time a running call has lasted, read again every half minute (no request). */
export function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * One call as a line of the conversation (F-041 point 6), in the style of a task update: "Hubert started a call · 2 people · 4 min · Join",
 * then "Call · 12 min · Hubert, Maurycy", or "Hubert called · nobody joined". It is an event, not a message: no reply, reaction or notice.
 */
export function CallLineItem({ line, projectId, nameOf, meId, clock, title }: {
  line: LiveCallLine; projectId: string; nameOf: (userId: string) => string; meId: string; clock: (iso: string) => string; title: (iso: string) => string;
}) {
  const live = useLive();
  const join = useJoinCall();
  const running = line.endedAt === null;
  const now = useNow(running);
  const starter = nameOf(line.startedBy);
  const mine = line.startedBy === meId;
  const here = live.session?.id === line.id && live.phase !== 'idle' && live.phase !== 'ended';
  const inCall = running ? line.inCall ?? [] : [];
  const words = callWords(line, nameOf, now);
  return (
    <li className="convo-notice convo-notice--update convo-call" id={`call-${line.id}`} data-call={running ? 'on' : 'over'}>
      <AuthorFace kind="human" id={line.startedBy} name={starter} mine={mine} />
      <div className="convo-notice__body">
        <p className="convo-notice__meta">
          {words.named ? <strong>{starter}{mine ? ' · you' : ''}</strong> : null}
          <span className="convo-notice__what">{words.text}</span>
          {inCall.length ? <span className="lv-faces convo-call__faces" aria-hidden="true">{inCall.slice(0, 3).map((userId) => <Avatar key={userId} id={userId} name={nameOf(userId)} size="sm" />)}</span> : null}
          {running && !here && (line.inCall === null || line.inCall.length > 0) ? <Button variant="secondary" className="convo-call__join" onClick={() => void join({ projectId, sessionId: line.id })}>Join</Button> : null}
          <time dateTime={line.startedAt} title={title(line.startedAt)}>{clock(line.startedAt)}</time>
        </p>
      </div>
    </li>
  );
}
