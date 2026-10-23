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
from test_app_shell import ORIGIN
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
        await self.api(ada,'DELETE',f'/api/v1/projects/{self.project}/grants/{self.project_grant_id}',{},status=204)
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

    async def third_writer(self, name='Lia West', key='lia'):
        """Another account in the same project (a third person watching, or a fourth)."""
        stamp = uuid.uuid4().hex
        context = await self.browser.new_context(base_url=ORIGIN, viewport={'width': 1440, 'height': 900}, reduced_motion='reduce', service_workers='block')
        self.contexts.append(context)
        page = await context.new_page()
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.record_socket(page, key)
        await page.goto('/sign-up')
        await page.get_by_label('Name', exact=True).fill(name)
        await page.get_by_label('Email', exact=True).fill(f'{key}.live.{stamp}@example.test')
        await page.get_by_label('Password', exact=True).fill('live copies retain exact history')
        await page.get_by_role('button', name='Create account', exact=True).click()
        await expect(page.get_by_role('heading', name='Home', exact=True)).to_be_visible()
        me = await self.api(page, 'GET', '/api/v1/me')
        await self.api(self.pages['ada'], 'POST', f'/api/v1/workspaces/{self.workspace}/members', {'email': f'{key}.live.{stamp}@example.test', 'role': 'member'}, 201)
        await self.api(self.pages['ada'], 'POST', f'/api/v1/projects/{self.project}/grants', {'principal': {'kind': 'human', 'id': me['user']['id']}, 'role': 'contributor'}, 201)
        self.pages[key] = page
        return page

    async def caret_at(self, page, field, offset):
        await field.click()
        await page.keyboard.press('Control+Home')
        for _ in range(offset):
            await page.keyboard.press('ArrowRight')

    async def test_map_names_clustered_people_and_tells_them_apart_without_colour(self):
        # #613 visual review: every cursor keeps a visible name that covers no thought, no other name and no other cursor,
        # and the cursor, its name and the People chip entry show one shape per person.
        for key in ('lia', 'mo'):
            self.frames[key] = []
            self.acks[key] = {}
        await self.create_map(3)
        ada, kai = self.pages['ada'], self.pages['kai']
        lia = await self.third_writer('Lia West', 'lia')
        mo = await self.third_writer('Mo Nakamura', 'mo')
        for page in (lia, mo):
            await page.goto(f'/map/{self.map_id}')
            await expect(page.locator('[data-live-map-status="live"]')).to_be_visible()
        first = await kai.locator(f'.sk-node[data-id="{self.thoughts[0]["id"]}"]').bounding_box()
        base = (first['x'] + first['width'] + 90, first['y'] + 260)
        # Three people within about 40 px of each other, in empty space.
        for page, (dx, dy) in ((ada, (0, 0)), (lia, (18, 14)), (mo, (36, 28))):
            await page.mouse.move(base[0] + dx, base[1] + dy, steps=4)
        names = ('Ada North', 'Lia West', 'Mo Nakamura')
        for name in names:
            await expect(kai.locator(f'.sk-peer[data-live-peer="{name}"]')).to_have_count(1)
            await expect(kai.locator(f'.sk-peer[data-live-peer="{name}"] .sk-peer__label')).to_be_visible()

        async def layout():
            return await kai.evaluate("""(names) => {
              const box = (el) => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; };
              return {
                labels: Object.fromEntries(names.map((n) => [n, box(document.querySelector(`.sk-peer[data-live-peer="${n}"] .sk-peer__label`))])),
                arrows: Object.fromEntries(names.map((n) => [n, box(document.querySelector(`.sk-peer[data-live-peer="${n}"] svg`))])),
                nodes: [...document.querySelectorAll('.sk-node')].map(box),
              };
            }""", list(names))

        def touches(a, b):
            return a['x'] < b['x'] + b['w'] and b['x'] < a['x'] + a['w'] and a['y'] < b['y'] + b['h'] and b['y'] < a['y'] + a['h']

        async def assert_clear(where):
            found = await layout()
            for name, label in found['labels'].items():
                self.assertGreater(label['w'], 0, f'{where}: {name} has a visible name')
                for node in found['nodes']:
                    self.assertFalse(touches(label, node), f'{where}: the name {name} covers a thought')
                for other, arrow in found['arrows'].items():
                    self.assertFalse(touches(label, arrow), f'{where}: the name {name} covers the cursor of {other}')
                for other, label2 in found['labels'].items():
                    if other != name:
                        self.assertFalse(touches(label, label2), f'{where}: the names {name} and {other} overlap')
        await assert_clear('clustered')
        cut = await kai.evaluate("() => [...document.querySelectorAll('.sk-peer__label > b')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)")
        self.assertEqual(cut, [], 'every name is shown in full')
        shapes = {}
        for name in names:
            peer = kai.locator(f'.sk-peer[data-live-peer="{name}"]')
            shape = await peer.get_attribute('data-shape')
            self.assertEqual(await peer.locator('.sk-peer__mark').get_attribute('data-shape'), shape)
            self.assertEqual(await peer.locator('.sk-peer__label .editing-shape').get_attribute('data-shape'), shape)
            self.assertEqual(await kai.locator('.sk-here > span', has_text=name).locator('.editing-shape').get_attribute('data-shape'), shape, f'{name}: the chip shows the same shape')
            shapes[name] = shape
        self.assertEqual(len(set(shapes.values())), 3, shapes)
        await self.shoot(kai, 'map-three-clustered-peers')

        # A cursor over a thought keeps its name, placed outside the thought so the text stays readable.
        over = await kai.locator(f'.sk-node[data-id="{self.thoughts[1]["id"]}"]').bounding_box()
        await ada.mouse.move(over['x'] + over['width'] / 2, over['y'] + over['height'] / 2, steps=4)
        await expect(kai.locator('.sk-peer[data-live-peer="Ada North"] .sk-peer__label')).to_be_visible()
        await kai.wait_for_timeout(300)
        await assert_clear('over a thought')

        # Phone width: the People chip stays inside the screen and clear of Map options; names stay inside it too.
        await kai.set_viewport_size({'width': 390, 'height': 844})
        await expect(kai.locator('.sk-here')).to_be_visible()
        chip = await kai.locator('.sk-here').bounding_box()
        self.assertGreaterEqual(chip['x'], 0)
        self.assertLessEqual(chip['x'] + chip['width'], 390, 'the chip fits the phone width')
        options = kai.get_by_role('button', name='Map options')
        if await options.count():
            self.assertTrue(await options.is_visible())
            box = await options.bounding_box()
            self.assertLessEqual(chip['x'] + chip['width'], box['x'] + 1, 'the chip does not run under Map options')
        clipped = await kai.evaluate("""() => [...document.querySelectorAll('.sk-here > span > b')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)""")
        self.assertEqual(clipped, [], 'no name in the chip is cut off at the phone width')
        for name in names:
            label = await kai.locator(f'.sk-peer[data-live-peer="{name}"] .sk-peer__label').bounding_box()
            self.assertGreaterEqual(label['x'], 0, name)
            self.assertLessEqual(label['x'] + label['width'], 390, f'{name}: the name stays inside the screen')
        await self.shoot(kai, 'map-three-peers-phone')
        self.assertEqual(self.errors, [])

    async def test_map_moving_line_stays_visible_over_another_thought(self):
        await self.create_map(3)
        ada, kai = self.pages['ada'], self.pages['kai']
        a = await ada.locator(f'.sk-node[data-id="{self.thoughts[0]["id"]}"]').bounding_box()
        b = await ada.locator(f'.sk-node[data-id="{self.thoughts[1]["id"]}"]').bounding_box()
        await ada.mouse.move(a['x'] + 20, a['y'] + 20)
        await ada.mouse.down()
        # Drag the first thought half over the second and hold it there.
        await ada.mouse.move(b['x'] + 40, b['y'] + 40, steps=12)
        mover = kai.locator(f'.sk-node[data-id="{self.thoughts[0]["id"]}"][data-live-mover="Ada North"] .sk-live-mover')
        await expect(mover).to_have_text('Ada North is moving')
        visible = await mover.evaluate("""(el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + Math.min(r.width / 2, 20), r.y + r.height / 2); return !!top && el.closest('.sk-node').contains(top); }""")
        self.assertTrue(visible, 'the moving line is not hidden under the thought it overlaps')
        await ada.mouse.up()

    async def test_wiki_names_two_people_writing_in_one_paragraph(self):
        # #613 review, AC-2: carets and selections are identified on screen, and two people in one paragraph tell apart.
        self.frames['lia'] = []
        self.acks['lia'] = {}
        paragraph = ' '.join(f'Observation {n} of the shared field notes keeps going.' for n in range(1, 13))
        await self.create_doc(paragraph)
        lia = await self.third_writer()
        ada, kai = self.pages['ada'], self.pages['kai']
        ada_field, kai_field = await self.editor('ada'), await self.editor('kai')
        await self.editor('lia')
        # Both carets sit in the same logical line, on the same wrapped row, where only a name tells them apart.
        await self.caret_at(ada, ada_field, 6)
        await self.caret_at(kai, kai_field, 30)
        ada_caret = lia.locator('.editing-caret[aria-label="Ada North\'s cursor"]')
        kai_caret = lia.locator('.editing-caret[aria-label="Kai South\'s cursor"]')
        await expect(ada_caret).to_have_count(1)
        await expect(kai_caret).to_have_count(1)
        tags = lia.locator('.editing-caret__tag')
        await expect(tags).to_have_count(2)
        await expect(lia.locator('.editing-caret__tag[title="Ada North"]')).to_be_visible()
        await expect(lia.locator('.editing-caret__tag[title="Kai South"]')).to_be_visible()

        async def boxes():
            return {
                'ada': await ada_caret.bounding_box(), 'kai': await kai_caret.bounding_box(),
                'ada_tag': await lia.locator('.editing-caret__tag[title="Ada North"]').bounding_box(), 'kai_tag': await lia.locator('.editing-caret__tag[title="Kai South"]').bounding_box(),
                'text': await lia.locator('.cm-line').first.bounding_box(),
            }

        self.assertEqual(await lia.locator('.cm-scroller').evaluate('(el) => getComputedStyle(el).paddingRight'), '136px', 'a wide editor reserves the lane')
        box = await boxes()
        # The names sit in the lane beside the line, never over the writing, and never over each other.
        for tag in ('ada_tag', 'kai_tag'):
            self.assertGreaterEqual(box[tag]['x'], box['text']['x'] + box['text']['width'], f'{tag} is clear of the text')
        self.assertGreaterEqual(box['kai_tag']['x'], box['ada_tag']['x'] + box['ada_tag']['width'], 'two tags on one row sit side by side without touching')
        self.assertLess(box['ada']['x'], box['kai']['x'], 'Ada is left of Kai in the same row, so her tag is first')
        # Both tags stay level with their carets' row; the second does not drop to the next wrapped row.
        for who in ('ada', 'kai'):
            self.assertLessEqual(abs((box[f'{who}_tag']['y'] + box[f'{who}_tag']['height'] / 2) - (box[who]['y'] + box[who]['height'] / 2)), 4, who)
        # Caret, tag and strip share one shape per person and the shapes differ.
        shapes = {}
        for name, caret in (('Ada North', ada_caret), ('Kai South', kai_caret)):
            shape = await caret.get_attribute('data-shape')
            self.assertEqual(await lia.locator(f'.editing-caret__tag[title="{name}"]').locator('.editing-shape').get_attribute('data-shape'), shape)
            self.assertEqual(await lia.locator('.editing-people > span', has_text=name).locator('.editing-shape').get_attribute('data-shape'), shape)
            shapes[name] = shape
        self.assertEqual(len(set(shapes.values())), 2, shapes)
        # Colour does not identify anyone: tags and carets use the monochrome tokens only.
        inks = await lia.evaluate("""() => [...document.querySelectorAll('.editing-caret__tag, .editing-caret')].map((el) => {
          const style = getComputedStyle(el); return [style.color, style.backgroundColor, style.borderLeftColor].join('|'); })""")
        for ink in inks:
            for value in ink.split('|'):
                numbers = [int(float(part)) for part in re.findall(r'[\d.]+', value)[:3]]
                if value.startswith('rgb') and len(numbers) == 3:
                    self.assertLess(max(numbers) - min(numbers), 12, f'monochrome: {value}')
        await self.shoot(lia, 'wiki-two-peers-one-paragraph')

        # A selection is attributed without colour too: it carries a line style that goes with its owner's shape.
        for _ in range(8):
            await ada.keyboard.press('Shift+ArrowRight')
        selection = lia.locator('.editing-selection').first
        await expect(selection).to_have_count(1)
        await expect(selection).to_have_attribute('data-shape', shapes['Ada North'])
        await expect(selection).to_have_attribute('title', 'Selected by Ada North')
        self.assertNotEqual(await selection.evaluate('(el) => getComputedStyle(el).borderBottomStyle'), 'none')

        # A caret and its name move together: Kai now sits on a later wrapped row, so his tag leaves Ada's row.
        await self.caret_at(kai, kai_field, 160)
        for _ in range(80):
            box = await boxes()
            if box['kai']['y'] > box['ada']['y'] + box['ada']['height']:
                break
            await lia.wait_for_timeout(100)
        self.assertGreater(box['kai']['y'], box['ada']['y'] + box['ada']['height'], 'Kai moved to a later row')
        self.assertGreaterEqual(box['kai_tag']['y'], box['ada_tag']['y'] + box['ada_tag']['height'])
        self.assertLessEqual(abs((box['kai_tag']['y'] + box['kai_tag']['height'] / 2) - (box['kai']['y'] + box['kai']['height'] / 2)), 4)

        # A narrow editor keeps all of its width: no lane, the caret keeps its shape and the strip names it.
        await lia.set_viewport_size({'width': 390, 'height': 844})
        await expect(tags.first).to_be_hidden()
        padding = await lia.locator('.cm-scroller').evaluate('(el) => getComputedStyle(el).paddingRight')
        self.assertEqual(padding, '0px')
        await expect(lia.locator('.editing-people')).to_contain_text('Ada North')
        await expect(lia.locator('.editing-people')).to_contain_text('Kai South')
        self.assertEqual(self.errors, [])
