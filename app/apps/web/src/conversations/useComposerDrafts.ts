import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useComposerDraft, useComposerScope } from '../composer/draft';
import type { PaneCore } from './paneCore';

/**
 * The pane's two drafts (#264): the public one (a new root in the stream, a reply in a thread) and the private
 * prompt to the person's assistant, with which of them the field edits now ("asking"). What arrives from elsewhere
 * joins them here: `?ask=1`, and a thought cited on the map.
 */
export function useComposerDrafts({ me, project, conversation, composerId, writable, aiOff }: PaneCore) {
  const [asking, setAsking] = useState(false);
  // The stream's composer keeps the former new-conversation draft; each thread keeps its own reply draft.
  const publicComposer = useComposerDraft(me.user.id, project.id, conversation?.task ? `task:${conversation.task.workId}` : conversation ? `conversation:${conversation.id}` : 'new');
  const helperComposer = useComposerDraft(me.user.id, project.id, `helper:${conversation?.id ?? 'new'}`);
  if (aiOff && asking) setAsking(false);
  const composer = asking ? helperComposer : publicComposer;
  const location = useLocation();
  const navigate = useNavigate();
  // The assistant panel's Message arrives as ?ask=1 in a thread: ask mode opens once.
  const askParam = !aiOff && !!conversation && writable && new URLSearchParams(location.search).get('ask') === '1';
  const [askHandled, setAskHandled] = useState(false);
  if (askParam !== askHandled) { setAskHandled(askParam); if (askParam) setAsking(true); }
  useEffect(() => {
    if (!askParam) return;
    const params = new URLSearchParams(location.search);
    params.delete('ask');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, defaultShouldRevalidate: false, state: location.state });
    requestAnimationFrame(() => document.getElementById(composerId)?.focus());
  }, [askParam, location.search, location.pathname, location.hash, location.state, navigate, composerId]);
  // The field grows with what is written, up to its CSS cap, then scrolls (#266 PF-3).
  const draft = composer.draft.body;
  useLayoutEffect(() => {
    const field = document.getElementById(composerId);
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [draft, composerId]);
  return {
    asking, setAsking, publicComposer, helperComposer, composer, draft,
    captureScope: useComposerScope(publicComposer.key), captureHelperScope: useComposerScope(helperComposer.key),
    busy: publicComposer.sending, askBusy: helperComposer.sending,
  };
}
export type ComposerDrafts = ReturnType<typeof useComposerDrafts>;
