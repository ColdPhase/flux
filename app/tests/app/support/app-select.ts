import { expect, type Locator } from 'playwright/test';

// Driving the app's own select (apps/web/src/ui/Select.tsx, #695) the way a person does: open it, pick an option.
// It is a combobox button that opens a listbox, so the native selectOption / inputValue / option locators do not apply.

// An open select and its list carry the same accessible name, so a bare getByLabel finds both while the list is open;
// the control comes first in the page, so `.first()` is the control.
const listboxOf = async (select: Locator): Promise<Locator> => {
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  return select.page().locator(`[id="${await select.getAttribute('aria-controls')}"]`);
};

/** Waits until the list has left (it fades for a moment), so a getByLabel finds one element again. */
const closed = async (select: Locator, box: Locator): Promise<void> => {
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await expect(box).toHaveCount(0);
};

export type OptionChoice = string | { label: string } | { value: string };

/** Opens `select` and picks an option: a bare string matches a value, else a label; `{ label }` and `{ value }` are exact. */
export async function chooseOption(control: Locator, option: OptionChoice): Promise<void> {
  const select = control.first();
  await select.click();
  const box = await listboxOf(select);
  const byValue = (value: string) => box.locator(`[role="option"][data-value="${value}"]`);
  const byLabel = (label: string) => box.getByRole('option', { name: label, exact: true });
  const target = typeof option === 'string' ? byValue(option).or(byLabel(option)).first()
    : 'label' in option ? byLabel(option.label) : byValue(option.value);
  await target.click();
  await closed(select, box);
}

/** The value the select shows now. */
export async function selectedValue(select: Locator): Promise<string> {
  return (await select.first().getAttribute('data-value')) ?? '';
}

/** The values of every option, read with the list open and closed again. */
export async function optionValues(control: Locator): Promise<string[]> {
  const select = control.first();
  await select.click();
  const box = await listboxOf(select);
  const values = await box.locator('[role="option"]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.value ?? ''));
  await select.press('Escape');
  await closed(select, box);
  return values;
}
