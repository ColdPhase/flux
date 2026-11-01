import { redirect, type LoaderFunctionArgs } from 'react-router';
import { getMessagePlace } from './api';

/**
 * `/projects/:projectId/messages/:messageId` (CW-2): opens the message in its thread. A thought keeps only the id of the
 * message it came from, so its "Open message" comes here. A message the reader cannot open lands on the project.
 */
export async function messageLoader({ params, request }: LoaderFunctionArgs) {
  const projectId = params.projectId!, messageId = params.messageId!;
  try {
    const place = await getMessagePlace(projectId, messageId, request.signal);
    return redirect(`/projects/${projectId}/conversations/${place.conversationId}#message-${messageId}`);
  } catch {
    return redirect(`/projects/${projectId}`);
  }
}
