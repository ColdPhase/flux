import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { expect } from 'playwright/test';
import { PERSONAL_RUN_CONSENT_VERSION, type AssistantAnswer, type AssistantProposal, type AssistantRun, type Conversation, type Page as NativePage, type Project, type WorkItem } from '@flux/contracts';
import { pool } from '../support/db.js';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from '../support/people.js';

// Native sessions/commands, real worker + real Anthropic adapter against the local
// scripted mock. No real-provider/device/billing acceptance. Direct DB deletion
// below preserves constraints and models a genuinely missing historical citation.
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const origin = new URL(process.env.FLUX_PUBLIC_ORIGIN!);
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});
proxy.on('upgrade', (request, socket, head) => {
  const target = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    target.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) target.write(head);
    target.pipe(socket); socket.pipe(target);
  });
  target.on('error', () => { target.destroy(); socket.destroy(); });
  socket.on('error', () => { target.destroy(); socket.destroy(); });
});


let browser: Browser;
const contexts: BrowserContext[] = [];
let manager: Person, owner: Person, writer: Person, viewer: Person;
let place: Project, thread: Conversation;
let agentId: string;
const tasks: WorkItem[] = [];
const answers: AssistantAnswer[] = [];
let proposal: AssistantProposal;
let target: WorkItem;
const referenceReads: string[][] = [];
const collectionReads: string[] = [];
const pageErrors: string[] = [];
const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
async function post<T>(who: Person, path: string, body: unknown, status = 201): Promise<T> {
  return expectStatus(await who.browser.request('POST', path, { body }), status) as T;
}
async function patchTask(item: WorkItem, body: Record<string, unknown>) {
  return expectStatus(await manager.browser.request('PATCH', `/api/v1/work/${item.id}`, { body: { ...body, clientCommandId: randomUUID() }, headers: { 'if-match': `"${item.version}"` } }), 200) as WorkItem;
}
async function script(text: string) {
  const response = await fetch('http://anthropic-mock:8090/__script', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, output_tokens: 90 }) });
  assert.equal(response.status, 200);
}
async function answer(prompt: string) {
  const run = await post<AssistantRun>(manager, `/api/v1/conversations/${thread.id}/assistant-runs`, { prompt, kind: 'ask', clientRunId: randomUUID() }, 202);
  let completed: AssistantRun | null = null;
  await expect.poll(async () => {
    completed = expectStatus(await manager.browser.request('GET', `/api/v1/assistant-runs/${run.id}`), 200) as AssistantRun;
    return completed.status;
  }, { timeout: 30_000 }).toBe('completed');
  const page = expectStatus(await manager.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers?limit=100`), 200) as NativePage<AssistantAnswer>;
  return page.items.find((item) => item.runId === run.id)!;
}
async function signedIn(who: Person, width = 1440, height = 900) {
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height } });
  contexts.push(context);
  const signed = await context.request.post('/api/auth/sign-in/email', { data: { email: who.email, password }, headers: { origin: origin.origin } });
  assert.equal(signed.status(), 200, await signed.text());
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const url = new URL(request.url());
    if (url.pathname.endsWith('/work-reference-rows')) referenceReads.push(url.searchParams.get('objects')!.split(','));
    if (/\/api\/v1\/projects\/[^/]+\/(work|decisions|results)$/.test(url.pathname)) collectionReads.push(url.pathname);
  });
  return page;
}
const conversationPath = () => `/projects/${place.id}/conversations/${thread.id}`;
async function open(who: Person, width = 1440, height = 900) {
  const page = await signedIn(who, width, height);
  await page.goto(conversationPath());
  await expect(page.locator('.thread__pane')).toBeVisible();
  return page;
}
async function capture(page: Page, name: string) {
  if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `${name}.png`) }); }
}
const referencePattern = '**/api/v1/projects/*/work-reference-rows?*';
before(async () => {
  await new Promise<void>((resolve) => proxy.listen(Number(origin.port || 80), origin.hostname, resolve));
  browser = await chromium.launch();
  [manager, owner, writer, viewer] = await Promise.all(['Reference manager', 'Task owner', 'Another writer', 'Reference viewer'].map(person));
  const ws = await workspace(manager, 'Native reference studio');
  for (const member of [owner, writer, viewer]) await addMember(manager, ws.id, member, 'member');
  place = await project(manager, ws.id, 'Measured citations', 'restricted');
  await grant(manager, place.id, owner, 'contributor'); await grant(manager, place.id, writer, 'contributor'); await grant(manager, place.id, viewer, 'viewer');
  agentId = (await post<{id:string}>(manager, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Reference analyst', owner: 'self' })).id;
  await post(manager, `/api/v1/projects/${place.id}/grants`, { principal: {kind:'agent',id:agentId}, role:'viewer' });
  await post(manager, '/api/v1/personal-assistant', {consentVersion:PERSONAL_RUN_CONSENT_VERSION,agentId,dailyCapCents:1000});
  thread = await post<Conversation>(manager, `/api/v1/projects/${place.id}/conversations`, {body:'Measured native references',clientMessageId:randomUUID()});
});
after(async () => {
  for (const context of contexts) await context.close();
  await browser?.close(); proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

test('120 immutable native citations remain linked beyond a single metadata window', {timeout:180_000}, async () => {
  await script('Measured work references: {works}');
  for (let group=0;group<6;group++) {
    const batch: WorkItem[] = [];
    for (let n=0;n<20;n++) {
      const item = await post<WorkItem>(manager, `/api/v1/projects/${place.id}/work`, { title:`Native citation ${String(group*20+n+1).padStart(3,'0')}`,owner:{kind:'human',id:owner.id},clientCommandId:randomUUID() });
      tasks.push(item);batch.push(item);
    }
    const committed = await answer(`Cite every measured task in batch${group+1}`);
    assert.equal(committed.sources.length,20);
    assert.ok(committed.sources.every((source)=>source.type==='work' && source.revision===1));
    answers.push(committed);
    for (const item of batch) await patchTask(item,{status:'done'});
  }
  assert.equal(new Set(answers.flatMap((item)=>item.sources.map((source)=>source.id))).size,120);
  const page = await open(owner,1440,5000);
  await expect(page.locator('.assistant-cite[data-native-ref]')).toHaveCount(120);
  await expect.poll(()=>referenceReads.some((batch)=>batch.length===100)).toBe(true);
  for (const index of [0,60,119]) {
    const task=tasks[index]!;
    const cite=page.locator(`[data-native-ref="work:${task.id}"].assistant-cite`);
    await cite.focus();
    await expect(cite).toHaveAttribute('aria-label',new RegExp(task.title));
    await cite.click();
    const panel=page.getByRole('complementary',{name:'Details'});
    await expect(panel).toContainText(task.title);
    await page.getByRole('button',{name:'Close details'}).click();
  }
  const changed=await patchTask({...tasks[0]!,version:2},{title:'Native citation001 refreshed'});
  assert.equal(changed.version,3);
  const first=page.locator(`[data-native-ref="work:${changed.id}"].assistant-cite`);
  await first.focus();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(first).toHaveAttribute('aria-label',/Native citation001 refreshed/);
  const persisted=expectStatus(await manager.browser.request('GET',`/api/v1/conversations/${thread.id}/assistant-answers?limit=100`),200) as NativePage<AssistantAnswer>;
  const original=persisted.items.find((item)=>item.runId===answers[0]!.runId)!;
  assert.deepEqual(original.sources,answers[0]!.sources,'current row versions never rewrite committed citation revisions');
  assert.equal(collectionReads.length,0);
  assert.ok(referenceReads.every((batch)=>batch.length>0 && batch.length<=100));
  await capture(page,'references-tall-120');
});

test('genuinely missing historical citation is isolated from valid rows; phone links and private draft survive', {timeout:45_000},async()=>{
  // The native schema permits this unreferenced task deletion; no FK is disabled.
  // Proposals retain a scoped task FK, so this is historical-citation evidence only.
  const missing=tasks[118]!,valid=tasks[119]!;
  const result=await pool.query('DELETE FROM project_work_items WHERE id=$1',[missing.id]);
  assert.equal(result.rowCount,1);
  const page=await open(owner,390,844);
  await page.locator('#thread-composer').fill('Private draft beside native citations');
  const missingLink=page.locator(`.assistant-cite[data-native-ref="work:${missing.id}"]`);
  const validLink=page.locator(`.assistant-cite[data-native-ref="work:${valid.id}"]`);
  await missingLink.scrollIntoViewIfNeeded();await missingLink.focus();
  await expect(missingLink).toHaveAttribute('aria-label',/in this project/);
  await validLink.focus();await expect(validLink).toHaveAttribute('aria-label',new RegExp(valid.title));
  const selected=expectStatus(await owner.browser.request('GET',`/api/v1/projects/${place.id}/work-reference-rows?objects=work:${missing.id},work:${valid.id}`),200) as {items:{id:string}[],unavailable:{id:string}[]};
  assert.deepEqual(selected.items.map((row)=>row.id),[valid.id]);assert.deepEqual(selected.unavailable.map((row)=>row.id),[missing.id]);
  await validLink.click();await expect(page.getByRole('dialog',{name:'Details'})).toContainText(valid.title);
  await page.getByRole('button',{name:'Close details'}).click();
  await expect(page.locator('#thread-composer')).toHaveValue('Private draft beside native citations');
  // Every part of a >100-source history stays reachable at the real phone layout.
  for (const index of [0,60,119]) {
    const current=expectStatus(await owner.browser.request('GET',`/api/v1/work/${tasks[index]!.id}`),200) as WorkItem;
    const link=page.locator(`.assistant-cite[data-native-ref="work:${current.id}"]`);
    await link.scrollIntoViewIfNeeded();await link.focus();
    await expect(link).toHaveAttribute('aria-label',new RegExp(current.title));
    await link.click();await expect(page.getByRole('dialog',{name:'Details'})).toContainText(current.title);
    await page.getByRole('button',{name:'Close details'}).click();
    await expect(page.locator('#thread-composer')).toHaveValue('Private draft beside native citations');
  }

  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await capture(page,'references-phone-native-mixed');
});

test('proposal authority distinguishes loading, failed read, owned, manager, viewer, unowned and real agent owner', {timeout:90_000},async()=>{
  target=await post<WorkItem>(manager,`/api/v1/projects/${place.id}/work`,{title:'Validate the measured range',owner:{kind:'human',id:owner.id},clientCommandId:randomUUID()});
  await script('Fact: measured range {works}. <proposal>{{"fact":"Measured range","interpretation":"Validate it","title":"Range proposal","finding":"positive","evidence":"Native measurements","finishes":"{work}"}}</proposal>');
  const committed=await answer('Draft a result for the range');
  proposal=expectStatus(await manager.browser.request('GET',`/api/v1/assistant-proposals/${committed.proposalId}`),200) as AssistantProposal;
  const nonowner=await open(writer);
  const card=nonowner.locator('.assistant-proposal').last();
  await card.scrollIntoViewIfNeeded();await expect(card).toContainText('waits for someone who can decide it');
  await expect(card.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
  await expect(card.getByRole('button',{name:'Dismiss',exact:true})).toHaveCount(0);
  const denied=await writer.browser.request('POST',`/api/v1/assistant-proposals/${proposal.id}/accept`,{body:{expectedVersion:proposal.version}});assert.equal(denied.status,403);
  const readonly=await open(viewer);const readonlyCard=readonly.locator('.assistant-proposal').last();await readonlyCard.scrollIntoViewIfNeeded();
  await expect(readonlyCard).toContainText('waits for someone who can decide it');await expect(readonlyCard.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
  const mine=await open(owner);const mineCard=mine.locator('.assistant-proposal').last();await mineCard.scrollIntoViewIfNeeded();await expect(mineCard.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  await mine.locator('#thread-composer').fill('Keep the private reply during a required read failure');
  await mine.route(referencePattern,(route)=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'WORK_READ_UNAVAILABLE',error:'Injected required read failure'})}));
  await mine.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(mineCard).toContainText('Couldn’t check the linked task');
  await expect(mineCard.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
  await expect(mineCard.getByRole('button',{name:'Dismiss',exact:true})).toHaveCount(0);
  await expect(mine.locator('#thread-composer')).toHaveValue('Keep the private reply during a required read failure');
  await capture(mine,'references-proposal-read-failed');
  await mine.unroute(referencePattern);await mine.getByRole('button',{name:'Refresh task references',exact:true}).click();
  await expect(mineCard.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  target=await patchTask(target,{owner:null});await nonowner.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  target=await patchTask(target,{owner:{kind:'agent',id:agentId}});await nonowner.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  target=await patchTask(target,{owner:{kind:'human',id:owner.id}});await nonowner.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(card.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
  const managerPage=await open(manager);const managerCard=managerPage.locator('.assistant-proposal').last();await managerCard.scrollIntoViewIfNeeded();await expect(managerCard.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  // Unavailable proposal target rendering only: scoped native FK prevents deleting
  // this actual target. The native final command authority remains independently checked.
  await managerPage.route(referencePattern,async(route)=>{
    const response=await route.fetch();const value=await response.json();
    value.items=value.items.filter((row:{id:string})=>row.id!==target.id);value.unavailable.push({kind:'work',id:target.id});
    await route.fulfill({response,json:value});
  });
  await managerPage.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(managerCard).toContainText('linked task is unavailable');
  await expect(managerCard.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
  await expect(managerCard.getByRole('button',{name:'Dismiss',exact:true})).toBeVisible();
  await capture(managerPage,'references-proposal-unavailable-rendering-only');
  await managerPage.unroute(referencePattern);await managerCard.getByRole('button',{name:'Refresh linked task'}).click();
  await expect(managerCard.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
});

test('required metadata retry preserves lost-response command UUID, native reply identity and answer reading anchor', {timeout:60_000},async()=>{
  const page=await open(owner,390,844);
  const card=page.locator('.assistant-proposal').last();await card.scrollIntoViewIfNeeded();await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  const replyText='One native reply despite lost response and metadata retry';
  const sends:string[]=[];
  const replies=`**/api/v1/conversations/${thread.id}/messages`;
  let first=true;
  await page.route(replies,async(route)=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    sends.push(route.request().postDataJSON().clientMessageId as string);
    if(first){first=false;const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed');}else await route.continue();
  });
  await page.locator('#thread-composer').fill(replyText);await page.getByRole('button',{name:'Send reply',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry send',exact:true})).toBeVisible();
  // The thread's reply draft (#195 shared composer) keeps the unconfirmed command's one UUID.
  const storageKey=`flux:composer:${owner.id}:${place.id}:conversation:${thread.id}`;
  const pending=await page.evaluate((key)=>JSON.parse(localStorage.getItem(key)!),storageKey);
  assert.equal(pending.commandId,sends[0]);assert.equal(pending.unconfirmed,true);
  await page.route(referencePattern,(route)=>route.fulfill({status:503,contentType:'application/json',body:'{"code":"WORK_READ_UNAVAILABLE","error":"Injected required read failure"}'}));
  // The committed reply may arrive over WS after its response was lost. Keep a
  // real citation focused so that arrival/viewport movement cannot retire the
  // required metadata selector before the injected failure is observed.
  const anchor=page.locator(`[data-answer-run="${answers[2]!.runId}"]`);
  await anchor.scrollIntoViewIfNeeded();await anchor.locator('[data-native-ref]').first().focus();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button',{name:'Refresh task references',exact:true})).toBeVisible();
  await page.waitForTimeout(250);
  const before=await anchor.evaluate((row)=>row.getBoundingClientRect().top);
  // The reply that arrives and the failure notice must not pull the reader away from the answer.
  const view=await page.locator('.thread__feed').evaluate((pane)=>{const box=pane.getBoundingClientRect();return {top:box.top,bottom:box.bottom};});
  assert.ok(before>=view.top-2&&before<view.bottom,`reader still sees the answer before refresh: ${before} not in ${view.top}–${view.bottom}`);
  await page.unroute(referencePattern);await page.getByRole('button',{name:'Refresh task references',exact:true}).click();
  await expect(page.locator('.thread__pane')).toHaveAttribute('data-references-phase','ready');
  await expect(page.locator('#thread-composer')).toHaveValue(replyText);
  const after=await anchor.evaluate((row)=>row.getBoundingClientRect().top);
  assert.ok(Math.abs(after-before)<=2,`reader retains answer anchor:${before}→${after}`);
  const retained=await page.evaluate((key)=>JSON.parse(localStorage.getItem(key)!),storageKey);
  assert.equal(retained.commandId,pending.commandId);
  await page.getByRole('button',{name:'Retry send',exact:true}).click();await expect(page.locator('#thread-composer')).toHaveValue('');
  assert.deepEqual(sends,[pending.commandId,pending.commandId]);
  const canonical=expectStatus(await owner.browser.request('GET',`/api/v1/conversations/${thread.id}`),200) as Conversation;
  const matches=canonical.messages.filter((message)=>message.body===replyText);assert.equal(matches.length,1);assert.equal(matches[0]!.authorId,owner.id);
  await capture(page,'references-phone-retry-reader');
  assert.equal(collectionReads.length,0);assert.ok(referenceReads.every((batch)=>batch.length>0&&batch.length<=100));assert.deepEqual(pageErrors,[]);
  if(evidence)writeFileSync(join(evidence,'native-reference-observation.json'),JSON.stringify({runtime:process.env.FLUX_GIT_COMMIT,immutableNativeSources:120,metadataBatchSizes:referenceReads.map((batch)=>batch.length),fullCollectionReads:collectionReads.length,nativeMissingHistoricalCitation:true,proposalUnavailableRenderingOnly:true,replyCount:matches.length,reusedCommandUUID:sends[0]===sends[1],answerAnchorDelta:after-before},null,2));
});


test('a reader scroll whose event has not arrived yet is kept when message work refreshes', {timeout:60_000},async()=>{
  // Scroll events arrive with a later frame. Model a frame that has not come yet: the feed's
  // scroll events are held while the reader moves to an earlier answer and work refreshes.
  const page=await open(owner,390,844);
  const convo=page.locator('.thread__pane');
  await expect(convo).toHaveAttribute('data-references-phase','ready');await expect(convo).toHaveAttribute('data-associations-phase','ready');
  const anchor=page.locator(`[data-answer-run="${answers[2]!.runId}"]`);
  const observed=await convo.getAttribute('data-references-observed-at');
  const before=await anchor.evaluate((row)=>{
    const w=window as unknown as {__heldScroll:boolean};w.__heldScroll=true;
    window.addEventListener('scroll',(event)=>{if(w.__heldScroll&&event.target instanceof Element&&event.target.classList.contains('thread__feed'))event.stopImmediatePropagation();},true);
    row.scrollIntoView({block:'center'});(row.querySelector('[data-native-ref]') as HTMLElement).focus({preventScroll:true});
    window.dispatchEvent(new Event('focus'));
    return row.getBoundingClientRect().top;
  });
  await expect.poll(()=>convo.getAttribute('data-references-observed-at')).not.toBe(observed);
  await expect(convo).toHaveAttribute('data-references-phase','ready');await page.waitForTimeout(250);
  const held=await anchor.evaluate((row)=>row.getBoundingClientRect().top);
  assert.ok(Math.abs(held-before)<=2,`reader keeps the answer while its scroll event is pending:${before}→${held}`);
  await page.evaluate(()=>{(window as unknown as {__heldScroll:boolean}).__heldScroll=false;});
  await page.evaluate(()=>new Promise((done)=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const after=await anchor.evaluate((row)=>row.getBoundingClientRect().top);
  assert.ok(Math.abs(after-before)<=2,`reader keeps the answer after the scroll event:${before}→${after}`);
  assert.deepEqual(pageErrors,[]);
});

test('late authorized metadata cannot resurrect manager actions across real account A→B→A revalidation', {timeout:60_000},async()=>{
  const page=await open(manager);
  const card=page.locator('.assistant-proposal').last();await card.scrollIntoViewIfNeeded();await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  const held:{route:Route,response:Awaited<ReturnType<Route['fetch']>>}[]=[];
  let captureNext=true;
  await page.route(referencePattern,async(route)=>{
    if(captureNext){captureNext=false;const response=await route.fetch();held.push({route,response});return;}
    await route.fulfill({status:503,contentType:'application/json',body:'{"code":"WORK_READ_UNAVAILABLE","error":"Required scope read unavailable"}'});
  });
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>held.length).toBe(1);
  const oldValue=await held[0]!.response.json() as {access:string};assert.equal(oldValue.access,'manager');
  async function switchAccount(who:Person){
    const signedOut=await page.context().request.post('/api/auth/sign-out',{headers:{origin:origin.origin}});assert.equal(signedOut.status(),200);
    const signedIn=await page.context().request.post('/api/auth/sign-in/email',{headers:{origin:origin.origin},data:{email:who.email,password}});assert.equal(signedIn.status(),200);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  }
  await switchAccount(writer);
  await expect(page.locator('.assistant-answer__asked').last()).toHaveText('asked by Reference manager');
  await expect(page.getByRole('button',{name:'Refresh task references',exact:true})).toBeVisible();
  await expect(card.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
  await page.locator('#thread-composer').fill('Only the second account owns this private draft');
  await switchAccount(manager);
  await expect(page.locator('.assistant-answer__asked').last()).toHaveText('asked by you');
  await expect(page.getByRole('button',{name:'Refresh task references',exact:true})).toBeVisible();
  await held[0]!.route.fulfill({response:held[0]!.response});
  await page.waitForTimeout(500);
  await expect(card.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
  await expect(page.locator('#thread-composer')).toHaveValue('');
  await page.unroute(referencePattern);await page.getByRole('button',{name:'Refresh task references',exact:true}).click();
  await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeVisible();
  await capture(page,'references-account-aba-recovered');
  assert.equal(collectionReads.length,0);assert.deepEqual(pageErrors,[]);
});


test('a held old metadata selector cannot refill a newer failed focused-reference window',{timeout:45_000},async()=>{
  const page=await open(owner,390,844);
  const first=page.locator(`.assistant-cite[data-native-ref="work:${tasks[0]!.id}"]`);
  await first.scrollIntoViewIfNeeded();await first.focus();await expect(first).toHaveAttribute('aria-label',/Native citation001 refreshed/);
  await page.locator('#thread-composer').fill('Private owner draft during selector replacement');
  const held:{route:Route,response:Awaited<ReturnType<Route['fetch']>>}[]=[];
  let captureNext=true;
  await page.route(referencePattern,async(route)=>{
    if(captureNext){captureNext=false;const response=await route.fetch();held.push({route,response});return;}
    await route.fulfill({status:503,contentType:'application/json',body:'{"code":"WORK_READ_UNAVAILABLE","error":"New focused reference read unavailable"}'});
  });
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>held.length).toBe(1);
  const last=page.locator(`.assistant-cite[data-native-ref="work:${tasks[119]!.id}"]`);
  await last.scrollIntoViewIfNeeded();await last.focus();
  await expect(page.getByRole('button',{name:'Refresh task references',exact:true})).toBeVisible();
  const old=await held[0]!.response.json() as {items:{id:string}[]};assert.ok(old.items.some((row)=>row.id===tasks[0]!.id));
  await held[0]!.route.fulfill({response:held[0]!.response});await page.waitForTimeout(250);
  await expect(page.locator('.thread__pane')).toHaveAttribute('data-references-phase','unavailable');
  await expect(first).toHaveAttribute('aria-label',/in this project/);
  await expect(page.locator('#thread-composer')).toHaveValue('Private owner draft during selector replacement');
  await page.unroute(referencePattern);await page.getByRole('button',{name:'Refresh task references',exact:true}).click();
  await expect(last).toHaveAttribute('aria-label',/Native citation 120/);
  await capture(page,'references-phone-held-selector-recovered');
  assert.equal(collectionReads.length,0);assert.ok(referenceReads.every((batch)=>batch.length<=100));assert.deepEqual(pageErrors,[]);
});
