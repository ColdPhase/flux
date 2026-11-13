import type { FirstStep, FirstSteps } from '@flux/contracts';
import { COMPANY_NAME } from '../access/workspaces.js';
import type { FirstStepRows } from './ports.js';

export * from './ports.js';

const NONE: FirstSteps = { steps: [], offerPush: false, everyoneSpaceId: null };

/**
 * Home's first-steps card (founder decisions, Hubert, 2026-11-13, #1438; docs/design/final/README.md "Home"): the steps left for this
 * person, by their company role. An owner or admin: name the company, invite people, connect AI. A member: write the first message, add a
 * photo (and, in the browser, notifications on this device). A guest, someone outside the company and a person who hid the card get none.
 * Each fact is read only for a role that shows it.
 */
export async function readFirstSteps(userId: string, rows: FirstStepRows): Promise<FirstSteps> {
  const company = await rows.company(userId);
  if (!company || company.hidden || company.role === 'guest') return NONE;
  const steps: FirstStep[] = [];
  if (company.role === 'owner' || company.role === 'admin') {
    const [invited, connected] = await Promise.all([rows.invitedAnyone(company.id), rows.aiConnected(userId)]);
    if (company.name === COMPANY_NAME) steps.push('name_company');
    if (!invited) steps.push('invite_people');
    if (!connected) steps.push('connect_ai');
    return { steps, offerPush: false, everyoneSpaceId: company.everyoneSpaceId };
  }
  const [wrote, photo] = await Promise.all([rows.wroteMessage(userId, company.id), rows.hasPhoto(userId)]);
  if (!wrote && company.everyoneSpaceId) steps.push('first_message');
  if (!photo) steps.push('photo');
  return { steps, offerPush: true, everyoneSpaceId: company.everyoneSpaceId };
}

export async function hideFirstSteps(userId: string, rows: FirstStepRows, now = new Date()): Promise<void> {
  await rows.hide(userId, now);
}
