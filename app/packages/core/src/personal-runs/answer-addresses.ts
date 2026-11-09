import type { PersonalRunUnitOfWork } from './ports.js';
import { privateTextIndex, withoutPrivateAddresses, writtenAddresses } from './web-addresses.js';

/**
 * A run's answer as it is stored (#1143, C-30): each web address in it that carries private Flux text the run read is replaced by
 * `[address left out]`, the rest stays. Everything that comes of the answer is cleaned with it, since each is read from the stored answer:
 * the private chat's earlier turns, "Continue", a schedule's message, a task's report line, an `<ask>` question and a Show everyone post. Run
 * before the commit's transaction, after the run's last tool call: the run keeps no more text by then. An answer with no address costs nothing.
 */
export async function answerWithoutPrivateAddresses(uow: PersonalRunUnitOfWork, runId: string, text: string): Promise<string> {
  if (!writtenAddresses(text).length) return text;
  const texts = await uow.run((ports) => ports.runs.privateTexts(runId));
  if (!texts.length) return text;
  return (await withoutPrivateAddresses(text, await privateTextIndex(texts))).text;
}
