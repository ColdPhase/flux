import type { FirstStep, FirstSteps } from '@flux/contracts';
import { COMPANY_NAME } from '../access/workspaces.js';
import type { FirstStepRows } from './ports.js';

export * from './ports.js';

const NONE: FirstSteps = { steps: [], joined: [], offerPush: false, everyoneSpaceId: null };

/** How long after joining the company a person is still a new person (founder direction, 2026-11-13, #1438): days from the membership's start. */
export const NEW_PERSON_DAYS = 30;
/** The card's rows at most. */
export const FIRST_STEP_ROWS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Home's first-steps card (founder decisions, Hubert, 2026-11-13, #1438; docs/design/final/README.md "Home"): the steps left for a new
 * person, by their company role. An owner or admin: name the company, invite people, connect AI. A member: write the first message, add a
 * photo (and, in the browser, notifications on this device, which rides along only while a step above is left). A new person is one who
 * joined the company in the last `NEW_PERSON_DAYS` days and still has a step left. A guest, someone outside the company, someone who joined
 * longer ago and a person who hid the card get none. The card is for good: the first time a new person has no step left it is marked done
 * in the same column as Hide (`rows.hide`), so it never returns, on any device, when a step becomes undone later. Each fact is read only for a
 * role that shows it. An owner or admin whose link was used also gets `joined`, one row per new person with no direct message with them yet ("Nia
 * joined · Say hello", #1438, #1424), in the place of "Invite people", which is done once a link was made; the card is still for the steps.
 */
export async function readFirstSteps(userId: string, rows: FirstStepRows, now = new Date()): Promise<FirstSteps> {
  const company = await rows.company(userId);
  if (!company || company.hidden || company.role === 'guest') return NONE;
  if (now.getTime() - company.joinedAt.getTime() > NEW_PERSON_DAYS * DAY_MS) return NONE;
  const steps: FirstStep[] = [];
  let joined: FirstSteps['joined'] = [];
  const admin = company.role === 'owner' || company.role === 'admin';
  if (admin) {
    const [invited, connected] = await Promise.all([rows.invitedAnyone(company.id), rows.aiConnected(userId)]);
    if (company.name === COMPANY_NAME) steps.push('name_company');
    if (!invited) steps.push('invite_people');
    else joined = await rows.joinedPeople(userId, company.id, FIRST_STEP_ROWS);
    if (!connected) steps.push('connect_ai');
  } else {
    const [wrote, photo] = await Promise.all([rows.wroteMessage(userId, company.id), rows.hasPhoto(userId)]);
    if (!wrote && company.everyoneSpaceId) steps.push('first_message');
    if (!photo) steps.push('photo');
  }
  // Nothing left: the card is done, for good. Push on this device alone never keeps or brings it back (it stays offered in Settings and by the one-time offer).
  if (!steps.length) { await rows.hide(userId, now); return { ...NONE, everyoneSpaceId: company.everyoneSpaceId }; }
  // The people who joined are a row beside a step that is left, never a reason for the card to stay or to come back.
  return { steps, joined, offerPush: !admin, everyoneSpaceId: company.everyoneSpaceId };
}

/** Hide: the card never shows again for this person, on any device. */
export async function hideFirstSteps(userId: string, rows: FirstStepRows, now = new Date()): Promise<void> {
  await rows.hide(userId, now);
}
