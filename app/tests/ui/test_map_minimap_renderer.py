"""#228: real-map Canvas/SVG geometry and raster calibration; no acceptance-driver changes."""
from pathlib import Path
import json
import base64
import os
import uuid

from playwright.async_api import expect
from test_live_editing import LiveFixture

REFERENCE = Path(__file__).with_name('minimap_reference.js').read_text()
OBSERVE = """(() => {
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function(...args) {
    this.canvas.__marks = []; return clear.apply(this,args);
  };
  const round = CanvasRenderingContext2D.prototype.roundRect;
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,radii) {
    (this.canvas.__marks ||= []).push({x,y,w,h,rx:radii[0].x,ry:radii[0].y,color:this.fillStyle,alpha:this.globalAlpha});
    return round.call(this,x,y,w,h,radii);
  };
  const computed = window.getComputedStyle;
  window.__minimapStyleReads = 0;
  window.getComputedStyle = function(el,...args) {
    if(el.matches?.('.sk-minimap__drawing')) window.__minimapStyleReads++;
    return computed.call(this,el,...args);
  };
})()"""


class MinimapRenderer(LiveFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for page in self.pages.values():
            await page.add_init_script(OBSERVE)

    async def reference(self, page, label, *, controls=False):
        await page.evaluate(REFERENCE)
        result = await page.evaluate('window.minimapReference()')
        self.assertLess(result['geometryError'], 1e-7, result)
        self.assertLess(result['overlayError'], 1e-7, result)
        self.assertEqual(result['drawColors'], [result['drawColor']])
        self.assertEqual(result['alphas'], [.6])
        self.assertEqual(result['backing'], [round(172*result['dpr']), round(112*result['dpr'])])
        self.assertGreater(result['raster']['ink'], 0)
        # Different native rasterizers can differ at antialiased boundaries; geometry is exact above.
        self.assertLess(result['raster']['relativeAlphaError'], .03, result)
        self.assertLessEqual(result['raster']['colorError'], 2, result)
        if controls:
            self.assertGreater(result['squareControl']['relativeAlphaError'], .03, result)
            self.assertGreater(result['minimumControl']['relativeAlphaError'], .03, result)
        print('MINIMAP_REFERENCE ' + json.dumps({'label':label, **result}), flush=True)
        directory = os.environ.get('FLUX_UI_SCREENSHOTS')
        if directory:
            Path(directory).mkdir(parents=True, exist_ok=True)
            await page.locator('.sk-minimap').screenshot(path=str(Path(directory)/f'{label}.png'))
            for kind in ('Reference','Actual'):
                png = await page.evaluate(f'window.__minimap{kind}PNG')
                (Path(directory)/f'{label}-{kind.lower()}.png').write_bytes(base64.b64decode(png.split(',',1)[1]))
        return result

    async def palette_and_dpr(self, label, *, controls=False):
        peer = self.pages['kai']
        state = await peer.context.storage_state()
        contexts = []
        try:
            for dpr in (1, 2):
                context = await self.browser.new_context(storage_state=state, viewport={'width':1440,'height':900},
                    device_scale_factor=dpr, reduced_motion='reduce', service_workers='block')
                contexts.append(context)
                await context.add_init_script(OBSERVE)
                page = await context.new_page()
                page.on('pageerror', lambda error: self.errors.append(str(error)))
                await page.goto(peer.url)
                await expect(page.locator('.sk-minimap canvas')).to_be_visible()
                for palette in ('light','dark'):
                    await page.emulate_media(color_scheme=palette)
                    await self.reference(page, f'{label}-{palette}-dpr{dpr}', controls=controls)
        finally:
            for context in contexts:
                await context.close()

    async def frozen_interaction(self, page):
        initial = await self.reference(page, 'before-minimap-drag')
        drawing = page.locator('.sk-minimap__drawing')
        marks = await drawing.evaluate('el => el.__marks')
        box = await page.locator('.sk-minimap').bounding_box()
        try:
            await page.mouse.move(box['x']+8,box['y']+104)
            await page.mouse.down()
            for px, py in ((8,104),(164,8)):
                await page.mouse.move(box['x']+px,box['y']+py,steps=3)
                await page.evaluate('() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                self.assertEqual(await drawing.evaluate('el => el.__marks'),marks,
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

    async def test_500_clamped_marks_follow_200_real_peer_previews_without_svg_host_writes(self):
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
          window.__minimapStyleReads=0;window.__minimapMutations=[];
          new MutationObserver(items=>window.__minimapMutations.push(...items.map(i=>i.type)))
            .observe(document.querySelector('.sk-minimap__drawing'),{attributes:true,childList:true,subtree:true});
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
            # reference() reads style once per observation; production must not read it per preview.
            self.assertEqual(await kai.evaluate('window.__minimapStyleReads'),3)
            self.assertEqual(await kai.evaluate('window.__minimapMutations'),[])
        finally:
            await ada.mouse.up()
        await expect(peer).not_to_have_attribute('data-live-mover','Ada North')
        await self.reference(kai,'500-committed',controls=True)
        self.assertEqual(self.errors, [])
