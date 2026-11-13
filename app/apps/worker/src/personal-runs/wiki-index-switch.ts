/**
 * The evaluation switch of #1381 (C-62): `FLUX_AI_BRIEF_WIKI_INDEX=on` puts an index of the space's Wiki pages (titles and first lines) in the brief of a run in
 * that space (variant B); off, the default, the brief says nothing of the Wiki's pages and the agent finds them with its tools (variant A). The evaluation harness
 * (#1295) names the variant instead: `FLUX_TEST_AI_VARIANT` is a list of variant names, `wiki-index` among them, test only like the
 * evaluation proxy switch (a test deployment: `FLUX_TEST_FAILURE_INJECTION=true`); a name this code does not know belongs to another change under evaluation and is
 * left alone. It is not a product setting: the variant that does not win is removed with the switch. Any other value of either variable stops the worker.
 */
export function wikiIndexSwitch(env: NodeJS.ProcessEnv): boolean {
  const value = env.FLUX_AI_BRIEF_WIKI_INDEX || 'off';
  if (value !== 'on' && value !== 'off') throw new Error('FLUX_AI_BRIEF_WIKI_INDEX must be on or off');
  const variants = (env.FLUX_TEST_AI_VARIANT ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (variants.length && env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_AI_VARIANT is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  return value === 'on' || variants.includes('wiki-index');
}
