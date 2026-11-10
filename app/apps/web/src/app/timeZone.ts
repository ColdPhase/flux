import { ME_TIME_ZONE_PATH, type MeResponse, type SetTimeZone } from '@flux/contracts';
import { request } from '../api/client';

// A person's own time zone is their browser's (#1168, C-57): the shell saves it on them when it is another one, so the schedules they ask
// their agents for run at the hour they meant and their agents' clock reads like the screen. There is no setting.

/** This browser's IANA zone; UTC when it names none. */
export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

let saving: string | null = null;

/** Saves this browser's zone on the signed-in person when they hold another: once per person and zone on a page, and a failure tries on the next read. */
export function keepTimeZone(me: MeResponse) {
  const zone = browserZone();
  const key = `${me.user.id} ${zone}`;
  if (me.user.timeZone === zone || saving === key) return;
  saving = key;
  // Saving it changes nothing another read shows: kept reads stay.
  void request<null>(ME_TIME_ZONE_PATH, { method: 'PUT', body: { timeZone: zone } satisfies SetTimeZone, leavesReads: true })
    .catch(() => { if (saving === key) saving = null; });
}
