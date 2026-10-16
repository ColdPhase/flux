import json
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    browser=pw.webkit.launch()
    print('Browser',browser.version,flush=True)
    for gesture in ['key','wheel']:
        for anchor in ['auto','none']:
            for remove in [False,True]:
                page=browser.new_page(viewport={'width':1000,'height':900})
                page.set_content('<div id="native" style="width:500px;height:591px;overflow:auto;overflow-anchor:'+anchor+'"><div id="removed" style="height:76px"></div>'+''.join('<div tabindex="0" style="height:100px">row '+str(i)+'</div>' for i in range(200))+'</div>')
                page.evaluate('''({remove,gesture})=>{
                    const pane=document.querySelector('#native');pane.scrollTop=gesture==='key'?9760:255;
                    pane.children[gesture==='key'?98:4].focus({preventScroll:true});
                    const events=window.events=[];window.removed=false;
                    for(const kind of ['scroll','keydown','keyup','wheel'])pane.addEventListener(kind,event=>{
                        events.push({kind,at:performance.now(),top:pane.scrollTop,height:pane.scrollHeight,key:event.key,delta:event.deltaY,trusted:event.isTrusted});
                        if(kind==='scroll'&&remove&&!window.removed&&pane.scrollTop>(gesture==='key'?9760:10000)){
                            window.removed=true;requestAnimationFrame(()=>{document.querySelector('#removed').remove();events.push({kind:'remove',at:performance.now(),top:pane.scrollTop,height:pane.scrollHeight});});
                        }
                    });
                }''',{'remove':remove,'gesture':gesture})
                if gesture=='key':page.keyboard.press('PageDown')
                else:
                    page.locator('#native').hover();page.mouse.wheel(0,100000)
                page.wait_for_function("()=>window.events.some(e=>e.kind==='scroll')")
                page.wait_for_function("()=>new Promise(resolve=>{let last=-1,stable=0;const check=()=>{const p=document.querySelector('#native');stable=p.scrollTop===last?stable+1:0;last=p.scrollTop;if(stable>8)resolve(true);else requestAnimationFrame(check);};requestAnimationFrame(check);})")
                print(json.dumps({'gesture':gesture,'anchor':anchor,'remove':remove,'result':page.evaluate("({events:window.events,final:document.querySelector('#native').scrollTop,max:document.querySelector('#native').scrollHeight-document.querySelector('#native').clientHeight,anchorSupported:CSS.supports('overflow-anchor','none')})")}),flush=True)
                page.close()
    browser.close()
