"""#228: real-map Grouped/native SVG geometry and raster calibration; no acceptance-driver changes."""
from pathlib import Path
import json
import base64
import os
import uuid

from playwright.async_api import expect
from test_live_editing import LiveFixture

REFERENCE = Path(__file__).with_name('minimap_reference.js').read_text()


class MinimapRenderer(LiveFixture):
    async def reference(self, page, label, *, controls=False):
        await page.evaluate(REFERENCE)
        result = await page.evaluate('window.minimapReference()')
        result.update(await self.raster(page, result.pop('markup'), result['color']))
        print('MINIMAP_REFERENCE ' + json.dumps({'label':label, **result}), flush=True)
        directory = os.environ.get('FLUX_UI_SCREENSHOTS')
        if directory:
            Path(directory).mkdir(parents=True, exist_ok=True)
            await page.locator('.sk-minimap').screenshot(path=str(Path(directory)/f'{label}.png'))
            for kind,png in self.raster_images.items():
                (Path(directory)/f'{label}-{kind}.png').write_bytes(base64.b64decode(png.split(',',1)[1]))
        # CSS transform/style serialization rounds the independent DOM reconstruction. Keep
        # its error below one thousandth of a CSS pixel; raster/negative controls stay separate.
        self.assertLess(result['geometryError'], .001, result)
        self.assertLess(result['overlayError'], .001, result)
        self.assertEqual(result['fills'], [result['color']])
        self.assertEqual(result['alphas'], ['0.6'])
        self.assertEqual(result['raster']['pixels'], [round(172*result['dpr']), round(112*result['dpr'])])
        self.assertGreater(result['raster']['ink'], 0)
        # Same original limits, now against rendered native SVG rather than image conversion.
        self.assertLess(result['raster']['relativeAlphaError'], .03, result)
        self.assertLessEqual(result['raster']['colorError'], 2, result)
        if controls:
            self.assertGreater(result['squareControl']['relativeAlphaError'], .03, result)
            self.assertGreater(result['minimumControl']['relativeAlphaError'], .03, result)
        return result

    async def raster(self, page, markup, color):
        # Clone observed native SVG markup into a blank page in the SAME engine and DPR.
        # Original reference and actual geometry are then screenshot through the same render path.
        raster_page = await page.context.new_page()
        images = {}
        try:
            wrappers = ''.join(f'<div id="{kind}" style="position:absolute;left:{i*200}px;top:0">{svg}</div>'
                               for i,(kind,svg) in enumerate(markup.items()))
            await raster_page.set_content(f'<style>body{{margin:0;background:transparent}}svg{{display:block}}'
                f'.sk-minimap__drawing rect{{fill:{color};opacity:.6}}</style>{wrappers}')
            for kind in markup:
                raw = await raster_page.locator(f'#{kind} svg').screenshot(omit_background=True)
                images[kind] = 'data:image/png;base64,' + base64.b64encode(raw).decode()
            await raster_page.evaluate(REFERENCE)
            results = {}
            for key, reference in (('raster','reference'),('squareControl','square'),('minimumControl','minimum')):
                results[key] = await raster_page.evaluate('args => window.minimapComparePNGs(args)',
                    {'actual':images['actual'],'reference':images[reference]})
            self.raster_images = images
            return results
        finally:
            await raster_page.close()

    async def palette_and_dpr(self, label, *, controls=False):
        peer = self.pages['kai']
        state = await peer.context.storage_state()
        contexts = []
        failures = []
        try:
            for dpr in (1, 2):
                context = await self.browser.new_context(storage_state=state, viewport={'width':1440,'height':900},
                    device_scale_factor=dpr, reduced_motion='reduce', service_workers='block')
                contexts.append(context)
                page = await context.new_page()
                page.on('pageerror', lambda error: self.errors.append(str(error)))
                await page.goto(peer.url)
                await expect(page.locator('.sk-minimap svg')).to_be_visible()
                for palette in ('light','dark'):
                    await page.emulate_media(color_scheme=palette)
                    try:
                        await self.reference(page, f'{label}-{palette}-dpr{dpr}', controls=controls)
                    except AssertionError as error:
                        failures.append({'case':f'{label}-{palette}-dpr{dpr}','error':str(error)})
        finally:
            for context in contexts:
                await context.close()
        self.assertFalse(failures, json.dumps(failures))

    async def frozen_interaction(self, page):
        initial = await self.reference(page, 'before-minimap-drag')
        drawing = page.locator('.sk-minimap__drawing')
        marks = await drawing.evaluate('el => el.innerHTML')
        box = await page.locator('.sk-minimap').bounding_box()
        try:
            await page.mouse.move(box['x']+8,box['y']+104)
            await page.mouse.down()
            for px, py in ((8,104),(164,8)):
                await page.mouse.move(box['x']+px,box['y']+py,steps=3)
                await page.evaluate('() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                self.assertEqual(await drawing.evaluate('el => el.innerHTML'),marks,
                                 'The exact fitted drawing stays frozen throughout minimap pointer capture')
                error = await page.evaluate("""({f,px,py}) => {
                  const c=document.querySelector('.sk-canvas'),p=document.querySelector('.sk-plane');
                  const z=new DOMMatrix(p.style.transform||undefined).a;
                  const left=Math.max(0,Math.min(c.scrollWidth-c.clientWidth,((px-f.dx)/f.k+f.x0)*z-c.clientWidth/2));
                  const top=Math.max(0,Math.min(c.scrollHeight-c.clientHeight,((py-f.dy)/f.k+f.y0)*z-c.clientHeight/2));
                  return Math.max(Math.abs(left-c.scrollLeft),Math.abs(top-c.scrollTop));
                }""", {'f':initial['frame'],'px':px,'py':py})
                self.assertLessEqual(error,1,'Minimap click/drag still uses the original inverse frame, allowing native scroll rounding')
        finally:
            await page.mouse.up()
        await self.reference(page,'after-minimap-drag')

    async def test_small_and_large_native_sizes_match_original_svg_in_both_palettes_and_dpr(self):
        await self.create_map(3)
        for thought, changes in zip(self.thoughts, ({'text':'Tiny','width':80,'height':40},
                {'text':'Large','width':800,'height':800}, {'text':'Wide','width':800,'height':40})):
            await self.api(self.pages['ada'], 'PATCH', f'/api/v1/sketches/{self.map_id}/thoughts/{thought["id"]}', changes,
                200, {'idempotency-key':str(uuid.uuid4()), 'if-match':f'"{thought["version"]}"'})
        await expect(self.pages['kai'].locator('.sk-t').filter(has_text='Wide')).to_be_visible()
        await self.palette_and_dpr('mixed-native-sizes')
        await self.frozen_interaction(self.pages['kai'])
        self.assertEqual(self.errors, [])

    async def test_500_clamped_marks_follow_200_real_peer_previews_without_unchanged_leaf_host_writes(self):
        await self.create_map(500)
        await self.palette_and_dpr('500-clamped', controls=True)
        ada, kai = self.pages['ada'], self.pages['kai']
        for thought in self.thoughts[:200]:
            await ada.locator(f'.sk-node[data-id="{thought["id"]}"]').click(modifiers=['Shift'])
        target = self.thoughts[199]
        node = ada.locator(f'.sk-node[data-id="{target["id"]}"]')
        peer = kai.locator(f'.sk-node[data-id="{target["id"]}"]')
        await node.scroll_into_view_if_needed()
        await peer.scroll_into_view_if_needed()
        # Keep the trusted pointer excursion inside the same actual map viewport as the driver.
        for page in (ada,kai):
            await page.locator(f'.sk-node[data-id="{target["id"]}"]').evaluate("""el => {
              const c=el.closest('.sk-canvas'),r=el.getBoundingClientRect(),v=c.getBoundingClientRect();
              c.scrollLeft+=(r.left+r.right-v.left-v.right)/2;
            }""")
        await self.reference(kai, '500-before-preview', controls=True)
        await kai.evaluate("""() => {
          window.__minimapMutations=[];
          const drawing=document.querySelector('.sk-minimap__drawing');
          const indices=new Map([...drawing.querySelectorAll('rect')].map((el,i)=>[el,i]));
          new MutationObserver(items=>window.__minimapMutations.push(...items.map(i=>({type:i.type,index:indices.get(i.target)??null,name:i.attributeName}))))
            .observe(drawing,{attributes:true,childList:true,subtree:true});
        }""")
        bounds = await node.bounding_box()
        initial = await peer.get_attribute('data-thought-x')
        try:
            await ada.mouse.move(bounds['x']+20,bounds['y']+20)
            await ada.mouse.down()
            frames = []
            for step in range(1,4):
                previous = await peer.get_attribute('data-live-preview-sequence')
                await ada.mouse.move(bounds['x']+40+step*12,bounds['y']+30+step*8,steps=2)
                await expect(peer).to_have_attribute('data-live-mover','Ada North')
                await expect(peer).not_to_have_attribute('data-live-preview-sequence', previous or '')
                result = await self.reference(kai,f'500-preview-{step}',controls=True)
                self.assertEqual(result['count'],500)
                self.assertEqual(result['clamped'],500)
                frames.append(result['frame'])
            await expect(peer).not_to_have_attribute('data-thought-x',initial)
            self.assertGreater(len({f['k'] for f in frames}),1,'Live upper-bound movement still refits the complete minimap')
            mutations = await kai.evaluate('window.__minimapMutations')
            self.assertFalse([m for m in mutations if m['index'] is not None and m['index'] >= 200], mutations)
            self.assertTrue([m for m in mutations if m['index'] is not None and m['name'] in ('x','y')], mutations)
            self.assertFalse([m for m in mutations if m['index'] is not None and m['name'] == 'style'], mutations)
            self.assertFalse([m for m in mutations if m['type'] == 'childList'], mutations)
        finally:
            await ada.mouse.up()
        await expect(peer).not_to_have_attribute('data-live-mover','Ada North')
        await self.reference(kai,'500-committed',controls=True)
        self.assertEqual(self.errors, [])
