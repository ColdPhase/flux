import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { PersonalAssistantStatus } from '@flux/contracts';
import { useSmallMoments } from '../app/smallMoments';
import { Button, Kreska, agentHue } from '../ui';
import { useAllAiBlocked } from '../ai/workspaceAi';
import { getAssistantStatus } from './api';

// Home's one set-up card (F-027 AST-10 Journey 1, step 1): shown until the assistant is set up or the person
// says "Not now". It promises a plan only where subscription sign-in is on for this Flux.

const key = (userId: string) => `flux.meet-assistant.${userId}`;
export const meetAssistantDismissed = (userId: string) => { try { return localStorage.getItem(key(userId)) === '1'; } catch { return false; } };

export function MeetAssistantCard({ userId }: { userId: string }) {
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [hidden, setHidden] = useState(() => meetAssistantDismissed(userId));
  const moments = useSmallMoments();
  const allOff = useAllAiBlocked();
  useEffect(() => {
    if (hidden || allOff) return;
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then(setStatus, () => undefined);
    return () => controller.abort();
  }, [hidden, allOff]);
  if (hidden || allOff || !status || status.enablement || (status.setup.provider === 'off' && status.setup.runtime.state === 'off')) return null;
  const plan = status.setup.runtime.state !== 'off';
  return (
    <section className="home__card home__meet" aria-labelledby="home-meet" data-ai-surface="meet-assistant">
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

// Three suggestions for this place, shown only where the assistant is a member, until it has been used three times (Journey 1 step 5).
const usesKey = (userId: string) => `flux.assistant-uses.${userId}`;
export const assistantUses = (userId: string) => { try { return Number(localStorage.getItem(usesKey(userId))) || 0; } catch { return 0; } };
export const noteAssistantUse = (userId: string) => { try { localStorage.setItem(usesKey(userId), String(assistantUses(userId) + 1)); } catch { /* shown again */ } };
const SUGGESTIONS = ['Catch me up', 'Turn this thread into tasks', 'Tidy this project\'s tasks'];

export function AssistantSuggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="assistant-suggestions" role="group" aria-label="Suggestions for your assistant" data-ai-surface="assistant-suggestions">
      {SUGGESTIONS.map((text) => <button key={text} type="button" className="assistant-suggestions__chip" onClick={() => onPick(text)}>{text}</button>)}
    </div>
  );
}
