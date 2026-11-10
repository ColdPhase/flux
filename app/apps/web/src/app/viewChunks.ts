/**
 * The code of a project's other views (#863 rule 2, 6). The router keeps the old route until the new one's code and reads are here,
 * so the code of Tasks, the Map and the Wiki is fetched while the browser is idle inside a project (or on the first press):
 * a switch then waits only for its reads. Each module is imported here once, by the routes and by the preload alike, so a switch
 * shares the download instead of asking for it a second time. A failed download is forgotten, so the next ask tries again.
 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () => (loading ??= load().catch((error: unknown) => { loading = undefined; throw error; }));
}

export const tasksPage = once(() => import('../work/ProjectTasks'));
/** A space's conversation and the sign-in pages (#1178): out of the first visit's code, fetched when matched or, inside the app, when idle. */
export const conversationPage = once(() => import('../conversations/ProjectConversation'));
export const authPages = once(() => import('../auth/pages'));
export const mapPage = once(() => import('../project/ProjectViews'));
export const wikiPage = once(() => import('../docs/Wiki'));
export const docViewsPage = once(() => import('../docs/DocViews'));

export function preloadProjectViews(): Promise<unknown> {
  return Promise.all([tasksPage(), mapPage(), wikiPage(), docViewsPage()]);
}
