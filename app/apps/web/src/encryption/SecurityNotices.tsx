import { useEffect, useState } from 'react';
import type { InboxItem } from '@flux/contracts';
import { Button, Icon } from '../ui';
import { useStreamEvents } from '../api/stream';
import { INBOX_CHANGED, announceInboxChange, getInbox, markInboxRead } from '../notifications/api';

const at = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The Inbox's security notices about encrypted spaces (F-030, #655): "Ben now has an unlock password for Garden club", "Garden club's
 * encryption keys were changed outside Flux", "… key change can't finish". They are Inbox-only notifications (`reason: 'security'`,
 * no body, no link; never pushed or e-mailed), so the Inbox is the one place they are read. Each stays until the person marks it
 * read with **Got it**, which also takes it out of the Inbox count.
 */
export function SecurityNotices({ userId }: { userId: string }) {
  const [notices, setNotices] = useState<InboxItem[]>([]);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getInbox(controller.signal, 100).then((answer) => {
      if (!controller.signal.aborted) setNotices(answer.items.filter((item) => item.reason === 'security' && !item.readAt));
    }, () => { /* the queue above says when the Inbox cannot load */ });
    return () => controller.abort();
  }, [userId, again]);
  useEffect(() => {
    const refresh = () => setAgain((n) => n + 1);
    window.addEventListener(INBOX_CHANGED, refresh);
    return () => window.removeEventListener(INBOX_CHANGED, refresh);
  }, []);
  // A notice is written with the event that causes it (a password set, keys changed, a key change that stalls).
  useStreamEvents(userId, (event) => { if (event.kind.startsWith('workspace.')) setAgain((n) => n + 1); }, () => setAgain((n) => n + 1));

  if (!notices.length) return null;
  const dismiss = (id: string) => {
    setNotices((list) => list.filter((item) => item.id !== id));
    void markInboxRead(id).then(announceInboxChange, () => setAgain((n) => n + 1));
  };
  return (
    <section className="security-notices" aria-labelledby="security-notices-h" data-security-notices="">
      <h2 id="security-notices-h">About your encrypted spaces</h2>
      <ul>
        {notices.map((notice) => (
          <li key={notice.id} data-security-notice={notice.id}>
            <Icon name="lock" size={14} />
            <div className="security-notices__text">
              <p>{notice.title}</p>
              <time dateTime={notice.createdAt}>{at.format(new Date(notice.createdAt))}</time>
            </div>
            <Button variant="quiet" onClick={() => dismiss(notice.id)} aria-label={`Got it: ${notice.title}`}>Got it</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
