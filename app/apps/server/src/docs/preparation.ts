import { editingDocContextCharge } from '../editing/context-charge.js';
import { ServiceUnavailableError } from '@flux/core';
import { apiNativeEditingAdmission, type EditingHTTPAdmission } from '../editing/http-admission.js';
import { apiEditingOutputBudget, EditingOutputError, type EditingOutputBudget } from '../editing/output.js';
const admissions = apiNativeEditingAdmission;
/** Reserve immutable raw/context before queuing; retain the shared owner through outer SQL settlement. */
export async function prepareDocWrite(context: unknown, budget: EditingOutputBudget = apiEditingOutputBudget,
  admission: EditingHTTPAdmission = admissions) {
  if (budget !== apiEditingOutputBudget && admission === admissions) throw new Error('A custom doc budget requires its matching admission');
  let releaseInput = () => {};
  try {
    releaseInput = budget.reserve(editingDocContextCharge(context));
    const owner = await admission.admitOwned(0);
    try { owner.reserve(2 * 1024 * 1024); }
    catch (error) { owner.release(); throw error; }
    const mapped = <T>(action: () => T): T => {
      try { return action(); }
      catch (error) {
        if (error instanceof EditingOutputError) throw new ServiceUnavailableError('The shared document preparation capacity is busy', error.code);
        throw error;
      }
    };
    return { memory: { reserve: (bytes: number) => mapped(() => owner.reserve(bytes)),
      temporary: (bytes: number) => mapped(() => owner.temporary(bytes)) },
      release() { owner.release(); releaseInput(); } };
  } catch (error) { releaseInput(); if (error instanceof EditingOutputError) throw new ServiceUnavailableError('The shared document preparation capacity is busy', error.code); throw error; }
}
