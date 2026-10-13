import { useId, useRef, useState, type FormEvent } from 'react';
import type { AgentQuestion } from '@flux/contracts';
import { AGENT_QUESTION_LIMITS } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button, Icon } from '../ui';
import { answerAgentQuestion } from './api';
import { rememberQuestion, useQuestion } from './questions';
import './question.css';

function failure(cause: unknown): string {
  if (cause instanceof NetworkError) return 'Flux can’t be reached right now. Nothing was sent; try again in a moment.';
  if (cause instanceof ApiError) {
    if (cause.code === 'QUESTION_ANSWERED') return 'This was answered a moment ago.';
    if (cause.code === 'QUESTION_NOT_FOR_YOU') return 'This question was asked of someone else.';
    if (cause.status === 403) return 'You can read this project but not write in it, so you can’t answer.';
  }
  return 'That didn’t send. Nothing changed; try again.';
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * An agent's question with ready-made answers (S14). Under the agent's message it adds one-tap answers for the person asked
 * and "Reply in your own words"; everyone else, and the asked person afterwards, sees the question and the answer. The reply
 * is that person's ordinary message in the same thread, so the card is never the only record. Renders nothing for a message
 * that carries no question.
 */
export function QuestionCard({ projectId, messageId, meId, writable }: { projectId: string; messageId: string; meId: string; writable: boolean }) {
  const question = useQuestion(projectId, messageId);
  if (!question) return null;
  return <Card question={question} meId={meId} writable={writable} />;
}

function Card({ question, meId, writable }: { question: AgentQuestion; meId: string; writable: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const labelId = useId();
  const mine = question.askedUserId === meId;
  const answered = question.answer;

  const send = async (key: string, command: { optionIndex: number } | { text: string }) => {
    if (busy) return;
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(key); setError('');
    try {
      rememberQuestion(await answerAgentQuestion(question.id, command, attempt.current.id));
      attempt.current = null;
      setTyping(false);
    } catch (cause) {
      setError(failure(cause));
      if (cause instanceof ApiError) attempt.current = null;
    } finally { setBusy(null); }
  };
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value) void send(`text:${value}`, { text: value });
  };

  return (
    <section className="qcard" aria-labelledby={labelId} data-question-id={question.id} data-state={answered ? 'answered' : 'open'}>
      <b className="qcard__q" id={labelId}>{question.question}</b>
      {answered ? (
        <p className="qcard__answer" role="status">
          <Icon name="check" size={14} />
          <span><span className="ui-vh">Answered: </span>{answered.text}</span>
          <span className="qcard__by">{answered.by.id === meId ? 'You' : answered.by.name} · <time dateTime={answered.at}>{time.format(new Date(answered.at))}</time></span>
        </p>
      ) : mine && writable ? (
        <>
          <div className="qcard__options" role="group" aria-label="Ready answers">
            {question.options.map((option, index) => (
              <Button key={option} variant="secondary" busy={busy === `option:${index}`} disabled={!!busy && busy !== `option:${index}`} onClick={() => void send(`option:${index}`, { optionIndex: index })}>{option}</Button>
            ))}
            {typing ? null : <Button variant="quiet" onClick={() => setTyping(true)} aria-expanded={false}>Reply in your own words</Button>}
          </div>
          {typing ? (
            <form className="qcard__own" onSubmit={submitText}>
              <label className="ui-vh" htmlFor={`${labelId}-own`}>Your answer</label>
              <input id={`${labelId}-own`} value={text} maxLength={AGENT_QUESTION_LIMITS.answer} autoFocus placeholder="Your answer" onChange={(event) => setText(event.target.value)} />
              <Button type="submit" variant="primary" disabled={!text.trim()} busy={!!busy && busy.startsWith('text:')}>Send</Button>
              <Button variant="quiet" onClick={() => { setTyping(false); setText(''); }}>Cancel</Button>
            </form>
          ) : null}
        </>
      ) : (
        <p className="qcard__waiting">{mine ? 'You can read this project but not write in it.' : 'Waiting for the person asked to answer.'}</p>
      )}
      {error ? <p className="qcard__error" role="alert">{error}</p> : null}
    </section>
  );
}
