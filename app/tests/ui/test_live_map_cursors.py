"""#228 AC-1/AC-2: peer-visible named cursors and presence on the map and the wiki.

Run only with FLUX_LIVE_EDITING_TEST=1 against the isolated development candidate
(scripts/check_live_editing.sh test_live_map_cursors). Two real accounts, real sockets;
FLUX_UI_SCREENSHOTS keeps one screenshot per surface.
"""
import os
import re
import time
import unittest
import uuid
from pathlib import Path

from playwright.async_api import expect
from test_live_editing import LiveFixture

SHOTS = Path(os.environ.get('FLUX_UI_SCREENSHOTS', '')) if os.environ.get('FLUX_UI_SCREENSHOTS') else None


@unittest.skipUnless(os.environ.get('FLUX_LIVE_EDITING_TEST') == '1', 'Actual isolated live candidate required')
class LiveCursors(LiveFixture):
    async def shoot(self, page, name):
        if SHOTS:
            engine = self.browser.browser_type.name
            await page.screenshot(path=str(SHOTS / f'{name}-{engine}.png'))

    async def observe_map_renders(self, page):
        await page.add_init_script("""(() => {
          const seen=new Map();
          window.__presenceRenders={view:0,geometry:0,node:0,cursor:0,people:0};
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,isDisabled:false,renderers:new Map(),inject(){return 1;},
            checkDCE(){},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},
            onCommitFiberRoot(_id,root){
              const stack=[root.current];
              while(stack.length){
                const fiber=stack.pop(),props=fiber.memoizedProps,classes=String(props?.className||'').split(' ');
                let kind=null,key=null;
                if(typeof fiber.type==='string'){
                  if(classes.includes('sk-page--map'))kind='view';
                  else if(classes.includes('sk-canvas-wrap'))kind='geometry';
                  else if(classes.includes('sk-node')){kind='node';key=props['data-id'];}
                  else if(classes.includes('sk-peer')){kind='cursor';key=fiber.key;}
                  else if(classes.includes('sk-here'))kind='people';
                }
                if(kind){
                  key=kind+':'+(key||'');
                  if(seen.has(key)&&seen.get(key)!==props)window.__presenceRenders[kind]++;
                  seen.set(key,props);
                }
                if(fiber.sibling)stack.push(fiber.sibling);
                if(fiber.child)stack.push(fiber.child);
              }
            }};
        })()""")

    async def test_map_shows_the_peers_named_cursor_and_who_is_here(self):
        await self.observe_map_renders(self.pages['kai'])
        await self.create_map(3)
        ada, kai = self.pages['ada'], self.pages['kai']
        node = ada.locator(f'.sk-node[data-id="{self.thoughts[0]["id"]}"]')
        box = await node.bounding_box()
        # Ada moves over empty space beside her first thought; Kai sees her named cursor there.
        await ada.mouse.move(box['x'] + box['width'] + 60, box['y'] + 200, steps=5)
        cursor = kai.locator('.sk-peer[data-live-peer="Ada North"]')
        await expect(cursor).to_have_count(1)
        await expect(cursor).to_contain_text('Ada North')
        await expect(kai.locator('.sk-here')).to_contain_text('Ada North')
        mine = await ada.locator('.sk-peer').count()
        self.assertEqual(mine, 0, 'Nobody sees their own cursor drawn')
        # Her cursor follows the pointer: same offset from the thought on both planes (same plane units).
        first = await kai.locator(f'.sk-node[data-id="{self.thoughts[0]["id"]}"]').bounding_box()
        target = (box['x'] + box['width'] + 160, box['y'] + 260)
        await ada.mouse.move(*target, steps=5)
        want = (target[0] - box['x'], target[1] - box['y'])
        deadline = time.perf_counter() + 3
        while True:
            at = await cursor.bounding_box()
            if abs(at['x'] - first['x'] - want[0]) <= 3 and abs(at['y'] - first['y'] - want[1]) <= 3:
                break
            self.assertLess(time.perf_counter(), deadline, f'The cursor follows the pointer: {at} vs {first} + {want}')
            await kai.wait_for_function('() => new Promise((done) => requestAnimationFrame(done))')
        # Actual presence-only wire updates paint their cursor without rerendering the editor/graph.
        await kai.evaluate('() => new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
        before=await kai.evaluate('window.__presenceRenders')
        received=lambda: [row for row in self.frames['kai'] if row['direction']=='received'
                          and row['header'].get('type')=='map-presence' and row['header'].get('actor',{}).get('id')==self.ada_id]
        count_before=len(received())
        for step in range(1,6):
            previous=await cursor.get_attribute('style')
            await ada.mouse.move(target[0]+step*9,target[1]+step*5)
            await expect(cursor).not_to_have_attribute('style',previous)
        await kai.evaluate('() => new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
        after=await kai.evaluate('window.__presenceRenders')
        self.assertGreaterEqual(len(received())-count_before,5,'Five fresh authorized peer presence packets arrived')
        self.assertGreaterEqual(after['cursor']-before['cursor'],5,'The observer detects real cursor paints')
        self.assertEqual(after['view'],before['view'],'Cursor-only receipts do not render the sketch editor')
        self.assertEqual(after['geometry'],before['geometry'],'Cursor-only receipts do not render the graph')
        self.assertEqual(after['node'],before['node'],'Thought shells retain their current props during presence-only updates')

        # Positive control: a real native body/geometry change MUST update the graph and visible copy.
        changed=await self.api(ada,'PATCH',f'/api/v1/sketches/{self.map_id}/thoughts/{self.thoughts[1]["id"]}',
            {'text':'Native geometry remains current during presence','x':self.thoughts[1]['x']+80},200,
            {'idempotency-key':str(uuid.uuid4()),'if-match':f'"{self.thoughts[1]["version"]}"'})
        native=kai.locator(f'.sk-node[data-id="{changed["id"]}"]')
        await expect(native).to_have_attribute('data-thought-x',str(changed['x']))
        await expect(native.locator('.sk-t')).to_have_text(changed['text'])
        positive=await kai.evaluate('window.__presenceRenders')
        self.assertGreater(positive['view'],after['view'],'Native change renders the editor')
        self.assertGreater(positive['geometry'],after['geometry'],'Native change renders current geometry')
        self.assertGreater(positive['node'],after['node'],'The shell observer detects the native change')
        print('PRESENCE_RENDER_CONTROL',{'before':before,'after':after,'native':positive,
              'actual_peer_presence_packets':len(received())-count_before},flush=True)
        await kai.mouse.move(first['x'] + 20, first['y'] + 300, steps=3)
        await expect(ada.locator('.sk-peer[data-live-peer="Kai South"]')).to_have_count(1)
        print('PEER_COLOURS', await kai.locator('.sk-peer span').evaluate('e => getComputedStyle(e).backgroundColor'), await ada.locator('.sk-peer span').evaluate('e => getComputedStyle(e).backgroundColor'), flush=True)
        await self.shoot(kai, 'map-peer-cursor')
        await self.shoot(ada, 'map-peer-cursor-ada')
        # Leaving the map takes the cursor away.
        await ada.mouse.move(2, 2)
        await expect(kai.locator('.sk-peer[data-live-peer="Ada North"]')).to_have_count(0)

    async def test_map_presence_clears_on_room_change_disconnect_expiry_and_revocation(self):
        connections=[]
        def connect(socket):
            socket.connect_to_server()  # Actual server, automatic unchanged forwarding both ways.
            connections.append(socket)
        await self.pages['kai'].route_web_socket(re.compile(r'.*/api/v1/editing\?kind=map.*'),connect)
        await self.create_map(3)
        ada,kai=self.pages['ada'],self.pages['kai']
        first=self.thoughts[0]
        async def move_owner(dx=0):
            bounds=await ada.locator(f'.sk-node[data-id="{first["id"]}"]').bounding_box()
            await ada.mouse.move(bounds['x']+bounds['width']+80+dx,bounds['y']+220,steps=3)
        cursor=kai.locator('.sk-peer[data-live-peer="Ada North"]')
        await move_owner()
        await expect(cursor).to_have_count(1)
        await expect(kai.locator('.sk-here')).to_contain_text('Ada North')
        original=self.map_id
        other=await self.api(ada,'POST',f'/api/v1/workspaces/{self.workspace}/sketches',
            {'title':'Another room','scope':'project','projectId':self.project},201,
            {'idempotency-key':str(uuid.uuid4())})
        await self.api(ada,'POST',f'/api/v1/sketches/{other["id"]}/thoughts',{'text':'Only in the other room','x':40,'y':40},201,
            {'idempotency-key':str(uuid.uuid4())})
        await kai.goto(f'/map/{other["id"]}')
        await expect(kai.locator('[data-live-map-status="live"]')).to_be_visible()
        await expect(kai.locator('.sk-peer')).to_have_count(0)
        await expect(kai.locator('.sk-here')).to_have_count(0)
        await move_owner(40)
        await expect(kai.locator('.sk-peer')).to_have_count(0)
        await kai.goto(f'/map/{original}')
        await expect(kai.locator('[data-live-map-status="live"]')).to_be_visible()
        await expect(cursor).to_have_count(1)

        # A real network interruption retires this room's old cursor snapshot before reconnect.
        await connections[-1].close(code=1001,reason='Actual disconnect regression')
        await expect(kai.locator('[data-live-map-status="connecting"]')).to_be_visible()
        await expect(kai.locator('.sk-peer')).to_have_count(0)
        await expect(kai.locator('.sk-here')).to_have_count(0)
        await expect(kai.locator('[data-live-map-status="live"]')).to_be_visible()
        await move_owner(60)
        await expect(cursor).to_have_count(1)

        # Stop the sender's actual room connection; no fake expiry or clock advance.
        await ada.goto('/inbox')
        await expect(cursor).to_have_count(0,timeout=8000)
        await expect(kai.locator('.sk-here')).to_have_count(0,timeout=8000)
        await ada.goto(f'/map/{original}')
        await expect(ada.locator('[data-live-map-status="live"]')).to_be_visible()
        await move_owner(90)
        await expect(cursor).to_have_count(1)
        await self.api(ada,'DELETE',f'/api/v1/projects/{self.project}/grants/{self.project_grant_id}',status=204)
        await expect(kai.locator('[data-live-map-status="private"]')).to_be_visible()
        await expect(kai.locator('.sk-peer')).to_have_count(0)
        await expect(kai.locator('.sk-here')).to_have_count(0)
        self.assertEqual(self.errors,[])

    async def test_wiki_shows_the_peers_named_cursor_and_writer(self):
        await self.create_doc('First paragraph of the shared field notes.')
        ada = await self.editor('ada')
        kai = await self.editor('kai')
        await self.type_text(self.pages['ada'], ada, ' Ada was here.')
        await expect(self.pages['kai'].locator('.editing-caret[aria-label="Ada North\'s cursor"]')).to_have_count(1)
        await expect(self.pages['kai'].locator('.editing-people')).to_contain_text('Ada North')
        await self.type_text(self.pages['kai'], kai, ' Kai too.')
        await expect(self.pages['ada'].locator('.editing-caret[aria-label="Kai South\'s cursor"]')).to_have_count(1)
        await expect(self.pages['ada'].locator('.editing-people')).to_contain_text('Kai South')
        await self.shoot(self.pages['ada'], 'wiki-peer-cursor')
