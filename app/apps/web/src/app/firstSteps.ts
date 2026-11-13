import { ME_FIRST_STEPS_HIDE_PATH, ME_FIRST_STEPS_PATH, type FirstSteps } from '@flux/contracts';
import { request } from '../api/client';

/** Home's first-steps card (#1438): the steps left for the signed-in person, and Hide, for good on every device. */
export const getFirstSteps = (signal?: AbortSignal) => request<FirstSteps>(ME_FIRST_STEPS_PATH, { signal });
export const hideFirstSteps = () => request<void>(ME_FIRST_STEPS_HIDE_PATH, { method: 'POST', leavesReads: true });
