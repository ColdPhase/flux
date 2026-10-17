import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { PersonalAssistantStatus } from '@flux/contracts';
import { useSmallMoments } from '../app/smallMoments';
import { Button, Kreska, agentHue } from '../ui';
import { getAssistantStatus } from './api';

// Home's one set-up card (F-027 AST-10 Journey 1, step 1): shown until the assistant is set up or the person
// says "Not now". It promises a plan only where subscription sign-in is on for this Flux.

const key = (userId: string) => `flux.meet-assistant.${userId}`;
export const meetAssistantDismissed = (userId: string) => { try { return localStorage.getItem(key(userId)) === '1'; } catch { return false; } };

export function MeetAssistantCard({ userId }: { userId: string }) {
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [hidden, setHidden] = useState(() => meetAssistantDismissed(userId));
  const moments = useSmallMoments();
  useEffect(() => {
    if (hidden) return;
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then(setStatus, () => undefined);
    return () => controller.abort();
  }, [hidden]);
  if (hidden || !status || status.enablement || (status.setup.provider === 'off' && status.setup.runtime.state === 'off')) return null;
  const plan = status.setup.runtime.state !== 'off';
  return (
    <section className="home__card home__meet" aria-labelledby="home-meet">
      {moments ? <Kreska size={32} hue={agentHue(`assistant:${userId}`)} /> : null}
      <div className="home__meet-b">
        <h3 id="home-meet" className="home__t">Meet your assistant</h3>
        <p className="home__sub">{plan ? 'It works inside Flux with the Claude or ChatGPT plan you already have.' : 'It works inside Flux with your AI account.'}</p>
      </div>
      <div className="home__meet-a">
        <Link className="ui-btn ui-btn--primary" to="/settings/assistant">Set up</Link>
        <Button variant="quiet" onClick={() => { try { localStorage.setItem(key(userId), '1'); } catch { /* shown again next time */ } setHidden(true); }}>Not now</Button>
      </div>
    </section>
  );
}
