import type { McpPermissionSettings } from './api';
import { CoworkHostActions } from './CoworkHostActions';

/** Live server facts are deliberately separate from native activation. A label or ACK cannot make work ready. */
export function ConnectionSetup({ settings, known }: { settings: McpPermissionSettings; known: boolean }) {
  const configured = settings.entries.some((entry) => entry.configured);
  const projects = settings.projects.filter((project) => project.selected);
  const needsWrite = settings.connection.scopes.some((scope) => scope !== 'flux.context.read');
  const usableProject = projects.some((project) => needsWrite ? project.writable : project.readable);
  const title = !known ? 'Connection state needs refreshing'
    : !configured || !projects.length ? 'Permissions are off'
      : !usableProject ? 'Project access is unavailable'
        : !settings.setup.authorizationRecorded ? 'Authorization needed'
          : settings.setup.session ? 'Connected · start work from your client'
            : 'Signed in · start work from your client';
  return <section className="connection__setup" aria-label="Connection setup">
    <h2>{title}</h2>
    {!known ? <p>Reload saved permissions to check the current connection.</p>
      : !configured || !projects.length ? <p>New project work is unavailable. Turn on the permissions and projects you want to allow, then save.</p>
        : !usableProject ? <p>Your agent no longer has the project access this selection needs. Check its project role or remove the unavailable selection.</p>
          : !settings.setup.authorizationRecorded ? <p>This saved selection has no current client authorization. Authorize it when your client opens Flux.</p>
            : settings.setup.session ? <p>The session is valid until <time dateTime={settings.setup.session.expiresAt}>{new Date(settings.setup.session.expiresAt).toLocaleString()}</time>. It doesn’t show whether the client is working.</p>
              : <p>Your client has signed in to this connection.</p>}
    <p>Flux can’t see whether your client is open. Start or resume work on a selected project from your client.</p>
    {projects.map((project) => <CoworkHostActions key={project.id} connectionId={settings.connection.id} projectId={project.id} client={settings.connection.clientDesignation} />)}
  </section>;
}
