-- What needs you never leaves the Inbox because other notifications arrived (sweep-34 C1, docs/development/needs-you.md "What needs a
-- person"). The queue read the person's newest 100 notifications of any kind, so 101 ordinary direct messages pushed an unread question
-- and the mention done today out of it. It now reads the four reasons that can be its items (mention, question, invitation, assigned)
-- however old the rest are; this index holds only those rows, so the read never walks the person's ordinary notifications.
CREATE INDEX notifications_needs_idx ON public.notifications USING btree (user_id, created_at DESC, id DESC)
  WHERE in_inbox AND reason IN ('mention', 'question', 'invitation', 'assigned');
