import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Icon, Spinner } from '../ui';
import { getConversation, listConversations } from '../app/conversation-api';
import { lastAskedConversation } from './lastAsked';
import './assistant.css';

// "In which conversation?" (F-027 AST-10 Journey 2 step 9, AST-10.10): ⌘K "Ask my assistant…" outside a conversation never
// leads nowhere. It lists the conversation the person last asked in first, then the newest of the project in view (or of the
// project they last asked in), and opens the one picked with the assistant ready to be asked.

interface Place { projectId: string; conversationId: string; title: string; project: string; last: boolean }
const first = (body: string) => (body.split('\n')[0] ?? '').trim() || 'Conversation';

export function AskWhere({ userId, projectId, projects, onOpen, onBack }: {
  userId: string; projectId: string | undefined; projects: { id: string; name: string }[]; onOpen: () => void; onBack: () => void;
}) {
  const navigate = useNavigate();
  const [places, setPlaces] = useState<Place[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const named = (id: string) => projects.find((project) => project.id === id)?.name ?? 'Project';
    (async () => {
      const found: Place[] = [];
      const last = lastAskedConversation(userId);
      // Only a project the list names (the caller leaves out those whose workspace has AI off, F-029).
      if (last && projects.some((project) => project.id === last.projectId)) {
        try {
          const conversation = await getConversation(last.conversationId, controller.signal);
          found.push({ projectId: last.projectId, conversationId: last.conversationId, title: first(conversation.firstMessageBody), project: named(last.projectId), last: true });
        } catch { /* gone or no longer readable: it is simply not offered */ }
      }
      const where = projectId ?? last?.projectId ?? projects[0]?.id;
      if (where) {
        try {
          for (const item of (await listConversations(where, controller.signal)).items.slice(0, 6)) {
            if (!found.some((place) => place.conversationId === item.id)) found.push({ projectId: where, conversationId: item.id, title: first(item.firstMessageBody), project: named(where), last: false });
          }
        } catch { /* the list below says there is nothing to pick */ }
      }
      if (!controller.signal.aborted) setPlaces(found.slice(0, 6));
    })();
    return () => controller.abort();
  }, [userId, projectId, projects]);
  return (
    <div className="aset-where" role="group" aria-label="In which conversation?">
      <h3 className="aset-where__h">In which conversation?</h3>
      {places === null ? <p role="status"><Spinner label="Loading conversations" /></p> : places.length ? (
        <ul className="aset-where__list">
          {places.map((place, index) => (
            <li key={place.conversationId}>
              <button type="button" className="aset-where__item" autoFocus={index === 0} onClick={() => { onOpen(); navigate({ pathname: `/projects/${place.projectId}/conversations/${place.conversationId}`, search: '?ask=1' }); }}>
                <Icon name="chat" size={15} />
                <span className="aset-where__t">{place.title}</span>
                <small className="aset-where__s">{place.last ? 'Last used' : place.project}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="aset-where__none">There is no conversation to ask in yet. Start one in a project, then ask from there.</p>}
      <Button variant="quiet" onClick={onBack}>Back</Button>
    </div>
  );
}
