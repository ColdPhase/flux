import { takeAsk } from '../agent-tasks/ask.js';
import { addressChain, defangedAddresses, holdsAddress, privateFragmentIn, privateTextIndex, withoutPrivateAddresses, type KeptPrivateText, type PrivateTextIndex } from './web-addresses.js';

/**
 * What a run writes as text, cleaned before it is stored (#1143, #1149, C-30): each web address in it that carries private Flux text the run
 * read, or that is too long to be read, becomes `[address left out]`; an address may keep a link's text only as that link or after it, never
 * by its site's path rule. One cleaner per commit, used inside the commit's transaction while the run's kept text still exists, on the
 * answer's final text (after its source marks and its `<schedule>` block are taken out, before Flux appends its sources), on the schedule's
 * instruction that block prepares (the request of every run of it), and on the `<ask>` question decoded from its JSON (the answering run's
 * request), which is stored again as JSON. The kept text is read only when a text holds an address.
 */
export interface AnswerCleaner {
  /** One text, any web address in it that carries private text left out. */
  clean(text: string): Promise<string>;
  /** The answer's final text: as `clean`, and the `<ask>` block's fields decoded, cleaned and written back as JSON. */
  cleanAnswer(text: string): Promise<string>;
  /**
   * The addresses of the sources Flux lists under the answer, as the stored answer may hold them (#1149); the owner still reads where the
   * agent went, and no later run takes one as a link someone wrote that the writing run could not have opened as one:
   * - `read`, a page Flux requested: defanged when the run could open it only by its site's path rule; one reached through a redirect of a
   *   person's link stays a link, as it was read;
   * - `cited`, a result the provider's search returned: defanged unless what a run writes may hold it, as for a query.
   */
  listed: { read(address: string): Promise<string>; cited(address: string): Promise<string> };
}

export function answerCleaner(keptTexts: () => Promise<KeptPrivateText[]>): AnswerCleaner {
  let index: Promise<PrivateTextIndex> | null = null;
  const clean = async (text: string) => {
    if (!text || !holdsAddress(text)) return text;
    index ??= keptTexts().then((texts) => privateTextIndex(texts));
    return (await withoutPrivateAddresses(text, await index)).text;
  };
  return {
    clean,
    listed: {
      async read(address: string) {
        if (!holdsAddress(address)) return address;
        index ??= keptTexts().then((texts) => privateTextIndex(texts));
        const kept = await index;
        // Only what the site's path rule alone let it read: a read's rules let it open, a writer's do not.
        if (await privateFragmentIn(address, kept).catch(() => 'too long')) return address;
        return (await privateFragmentIn(address, kept, addressChain(), { sameSitePaths: false }).catch(() => 'too long')) ? defangedAddresses(address) : address;
      },
      async cited(address: string) {
        return (await clean(address)) === address ? address : defangedAddresses(address);
      },
    },
    async cleanAnswer(text: string) {
      const cleaned = await clean(text);
      const start = cleaned.indexOf('<ask>');
      const end = start < 0 ? -1 : cleaned.indexOf('</ask>', start);
      if (end < 0) return cleaned;
      // The question is read from the block's JSON: an escape (`https:\/\/…`, `/`) is an address only once decoded, so it is decoded,
      // cleaned and written back. A block that is no well-formed question asks nothing (`takeAsk`), and its text is left as cleaned.
      const { ask } = takeAsk(cleaned);
      if (!ask) return cleaned;
      const block = { agent: await clean(ask.agent), ...(ask.owner ? { owner: await clean(ask.owner) } : {}), question: await clean(ask.question) };
      return `${cleaned.slice(0, start)}<ask>${JSON.stringify(block)}</ask>${cleaned.slice(end + '</ask>'.length)}`;
    },
  };
}
