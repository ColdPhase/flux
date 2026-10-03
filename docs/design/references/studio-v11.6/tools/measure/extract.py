"""Measure computed styles of the supplied Studio 11.6 prototype (read-only copy).
Runs inside the Playwright 1.62 image with --network none. Output: /out/measured.json, /out/shots/*.png
"""
from common import *
import re, time

MEASURE_JS = r'''
(() => {
 const PROPS=['display','position','min-height','max-height','min-width','max-width','padding-top','padding-right','padding-bottom','padding-left',
  'margin-top','margin-right','margin-bottom','margin-left','row-gap','column-gap',
  'border-top-width','border-top-style','border-top-color','border-right-width','border-right-style','border-right-color',
  'border-bottom-width','border-bottom-style','border-bottom-color','border-left-width','border-left-style','border-left-color',
  'border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius',
  'background-color','background-image','background-size','color','font-family','font-size','font-weight','line-height','letter-spacing',
  'text-transform','font-style','font-variant-numeric','box-shadow','opacity','transition','animation','outline-style','outline-width','outline-color','outline-offset',
  'transform','filter','backdrop-filter','z-index','overflow-x','overflow-y','text-decoration-line','fill','stroke','stroke-width','content',
  'left','right','top','bottom','grid-template-columns','flex-direction','align-items','justify-content','white-space','text-overflow'];
 const DEFAULTS={display:null,position:'static','min-height':['auto','0px'],'max-height':'none','min-width':['auto','0px'],'max-width':'none',
  'background-image':'none','background-size':'auto','text-transform':'none','font-style':'normal','font-variant-numeric':'normal','box-shadow':'none','opacity':'1',
  'transition':['all 0s ease 0s','all','none 0s ease 0s','all 0s'],'animation':['none 0s ease 0s 1 normal none running','none'],'outline-style':'none','transform':'none','filter':'none','backdrop-filter':'none','z-index':'auto',
  'overflow-x':'visible','overflow-y':'visible','text-decoration-line':'none','fill':'rgb(0, 0, 0)','stroke':'none','stroke-width':'1px','content':['normal','none'],
  'left':'auto','right':'auto','top':'auto','bottom':'auto','grid-template-columns':'none','flex-direction':'row','align-items':'normal','justify-content':'normal','white-space':'normal','text-overflow':'clip',
  'letter-spacing':'normal','row-gap':'normal','column-gap':'normal'};
 function pick(cs,pseudo){
  const o={};
  for(const p of (pseudo?PROPS.concat(['width','height']):PROPS)){
   let v=cs.getPropertyValue(p);
   const d=DEFAULTS[p];
   if(d!==undefined && d!==null){ if(Array.isArray(d)? d.includes(v): d===v) continue; }
   if(p.startsWith('outline-') && p!=='outline-style' && cs.getPropertyValue('outline-style')==='none') continue;
   if(/^border-.*-(style|color)$/.test(p)){ const side=p.split('-')[1]; if(cs.getPropertyValue('border-'+side+'-width')==='0px') continue; }
   if(/^border-.*-width$/.test(p) && v==='0px') continue;
   if(/^(margin|padding)-/.test(p) && v==='0px') continue;
   o[p]=v;
  }
  return o;
 }
 window.__m=(sel,opts={})=>{
  let el=sel;
  if(typeof sel==='string'){
   const all=[...document.querySelectorAll(sel)];
   const vis=all.filter(e=>{const r=e.getBoundingClientRect();return opts.any||(r.width>0&&r.height>0)});
   el=vis[opts.n||0];
   if(!el) return {missing:sel,count:all.length};
  }
  const r=el.getBoundingClientRect();
  const o={sel:typeof sel==='string'?sel:'(el)',rect:[r.x,r.y,r.width,r.height].map(v=>Math.round(v*10)/10)};
  Object.assign(o,pick(getComputedStyle(el)));
  const t=(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
  if(t) o.text=t.slice(0,70);
  for(const ps of (opts.pseudo||['::before','::after'])){
   const c=getComputedStyle(el,ps);
   if(c.content && c.content!=='none' && c.content!=='normal'){ o[ps]=pick(c,true); }
  }
  const svg=el.querySelector(':scope > svg');
  if(svg && opts.svg!==false){ const sr=svg.getBoundingClientRect(); o.svg=[Math.round(sr.width),Math.round(sr.height),getComputedStyle(svg).color]; }
  return o;
 };
 window.__vars=()=>{
  const names=new Set();
  const walk=(rules)=>{for(const r of rules){ if(r.style){ for(const p of r.style){ if(p.startsWith('--')) names.add(p);} } if(r.cssRules) walk(r.cssRules);} };
  for(const s of document.styleSheets) walk(s.cssRules);
  const cs=getComputedStyle(document.documentElement);
  const probe=document.createElement('span'); document.body.appendChild(probe);
  const out={};
  for(const n of [...names].sort()){
   const raw=cs.getPropertyValue(n).trim();
   probe.style.color=''; probe.style.color='var('+n+')';
   const col=getComputedStyle(probe).color;
   probe.style.color='rgb(1, 2, 3)'; probe.style.color='var('+n+')';
   const col2=getComputedStyle(probe).color;
   out[n]={raw, resolved: (col===col2 && raw && !/^[\d.]+(px|%|em|rem)?$/.test(raw))?col:null};
  }
  probe.remove();
  const root={};
  for(const p of ['font-family','font-size','line-height','color','background-color','font-synthesis-weight']) root[p]=cs.getPropertyValue(p);
  const b=getComputedStyle(document.body); root.body_bg=b.backgroundColor; root.body_color=b.color;
  return {vars:out,root};
 };
 return true;
})()
'''

def install(s):
    s.page.evaluate(MEASURE_JS)

def M(s, sel, **opts):
    return s.page.evaluate('([s,o])=>{ if(!window.__m) return null; return window.__m(s,o)}', [sel, opts])

def measure_set(s, spec):
    install(s)
    out = {}
    for key, sel, *rest in spec:
        opts = rest[0] if rest else {}
        out[key] = M(s, sel, **opts)
    return out

SHELL = [
 ('html', 'html'), ('body', 'body'), ('shell', '.shell'), ('sidebar', '.sidebar'),
 ('brand', '.sidebar .brand'), ('brand_svg', '.sidebar .brand>svg'), ('wordmark', '.atelier-wordmark'), ('wordmark_stop', '.atelier-wordmark-stop'), ('brand_version', '.sidebar .brand .version'),
 ('search_launch', '.search-launch'), ('search_label', '.search-launch-label'), ('search_kbd', '.search-launch kbd'),
 ('nav_home', '.sidebar > .nav'), ('nav_badge', '.nav .badge-number'), ('nav_sketch', '.sidebar > .nav', {'n': 1}), ('nav_sketch_lock_svg', '.sidebar > .nav:nth-child(4) > svg:last-child'),
 ('side_scroll', '.side-scroll'), ('side_label', '.side-label'), ('side_label_eyebrow', '.side-label .eyebrow'), ('side_label_iconbtn', '.side-label .iconbtn'),
 ('nav_project_active', '.side-scroll .nav.active'), ('nav_project_active_icon', '.side-scroll .nav.active .nav-icon'), ('nav_project_active_icon_svg', '.side-scroll .nav.active .nav-icon svg'), ('nav_project_active_label', '.side-scroll .nav.active .grow'),
 ('nav_project', '.side-scroll .nav:not(.active)'), ('nav_project_label', '.side-scroll .nav:not(.active) .grow'), ('unread_dot', '.side-scroll .unread-dot'),
 ('nav_dm', '.side-scroll .nav:has(.avatar)'), ('nav_dm_avatar', '.side-scroll .nav .avatar'),
 ('side_bottom', '.side-bottom'), ('demo_tag', '.demo-tag'), ('status_dot', '.demo-tag .status-dot'), ('demo_tag_iconbtn', '.demo-tag .iconbtn'),
 ('profile', '.atelier-profile'), ('profile_avatar', '.atelier-profile>.avatar'), ('profile_name', '.atelier-profile>.grow>div:first-child'), ('profile_sub', '.atelier-profile>.grow>.dim'), ('profile_iconbtn', '.atelier-profile>.iconbtn'),
 ('main_sheet', '.main'),
]
HEADER = [
 ('header', '.atelier-header'), ('head_top', '.atelier-header .head-top'), ('head_name', '.atelier-header .head-name'), ('head_context', '.atelier-header .head-context'),
 ('members_label', '.atelier-header .members-label'), ('goal_chip', '.atelier-header .goal-chip'), ('goal_chip_text', '.atelier-header .goal-chip span'),
 ('head_controls', '.atelier-header .head-controls'), ('live_button', '.head-controls .live-button'), ('live_label', '.head-controls .live-label'), ('project_menu_btn', '.atelier-project-menu'),
 ('tabs_row', '.atelier-header .tabs-row'), ('tabs', '.atelier-header .tabs'), ('tab', '.atelier-header .tab:not(.active)'), ('tab_active', '.atelier-header .tab.active'),
 ('catchup', '.catchup-button'), ('catchup_label', '.catchup-button span'), ('catchup_count', '.catchup-button b'),
]
CHAT = [
 ('workspace', '.workspace'), ('messages', '.messages'), ('day_divider', '.day-divider'),
 ('msg', '.messages > .msg'), ('msg_avatar', '.messages .msg-avatar .avatar'), ('msg_wrap', '.messages .msg-wrap'), ('msg_meta', '.messages .msg-meta'), ('msg_meta_name', '.messages .msg-meta b'), ('msg_meta_time', '.messages .msg-meta span'),
 ('bubble', '.messages .msg:not(.self):not(.marked-result):not(.marked-blocker) .bubble'), ('msg_text', '.messages .msg-text'),
 ('replies_line', '.messages .replies-line'),
 ('msg_actions', '.messages .msg-actions'), ('msg_action_reply', '.messages .msg-actions button[data-action=comments]'), ('msg_action_react', '.messages .msg-actions button[data-action=react]', {'any': True}),
 ('bubble_result', '.messages .msg.marked-result .bubble'), ('effect_result', '.messages .msg.marked-result .msg-effect'), ('effect_result_btn', '.messages .msg.marked-result .msg-effect button'),
 ('bubble_blocker', '.messages .msg.marked-blocker .bubble'), ('effect_blocker', '.messages .msg.marked-blocker .msg-effect'),
 ('material', '.messages .material'), ('material_kind', '.messages .material .kindline'), ('material_title', '.messages .material .title'), ('material_meta', '.messages .material .meta'),
 ('pill_good', '.messages .pill.good'), ('pill_accent', '.messages .pill.accent'), ('pill_warn', '.messages .pill.warn'), ('pill_plain', '.messages .pill:not(.good):not(.accent):not(.warn)'),
 ('msg_self', '.messages .msg.self'), ('msg_self_avatar', '.messages .msg.self .avatar'), ('bubble_self', '.messages .msg.self .bubble'), ('link_mini', '.messages .link-mini'),
 ('inline_ref', '.messages .inline-ref'), ('ref_kind', '.messages .inline-ref .ref-kind'),
 ('composer_wrap', '.chat > .composer-wrap'), ('composer', '.chat .composer'), ('editor', '.chat .composer .editor'), ('composer_tools', '.chat .composer-tools'),
 ('composer_iconbtn', '.chat .composer-tools .iconbtn'), ('composer_ai_btn', '.chat .composer-tools .btn'), ('send', '.chat .composer .send'),
 ('composer_caption', '.chat .composer-caption'), ('kbd_hint', '.chat .composer-caption .kbd-hint'),
]
TASKS = [
 ('toolbar', '.tasks-toolbar'), ('toolbar_select', '.tasks-toolbar select'), ('toolbar_iconbtn', '.tasks-toolbar .toolbar-group .iconbtn'),
 ('local_search', '.tasks-toolbar .local-search'), ('local_search_input', '.tasks-toolbar .local-search input'),
 ('segmented', '.tasks-toolbar .segmented'), ('seg_active', '.tasks-toolbar .segmented button.active'), ('seg_inactive', '.tasks-toolbar .segmented button:not(.active)'),
 ('btn_mine_quiet', '.tasks-toolbar .btn.quiet'), ('btn_new_task_primary', '.tasks-toolbar .btn.primary'),
 ('board', '.board'), ('column', '.column'), ('column_head', '.column-head'), ('column_head_label', '.column-head > span:nth-of-type(2)'), ('column_count', '.column-head .count'), ('column_head_iconbtn', '.column-head .iconbtn'),
 ('status_todo', '.status-circle.todo'), ('status_doing', '.status-circle.doing'), ('status_done', '.status-circle.done'),
 ('column_cards', '.column-cards'), ('card', '.task-card11'), ('card_top', '.task-card11 .task-card-top'), ('task_number', '.task-number'), ('board_label', '.task-board-label'),
 ('card_title', '.task-card11 h3'), ('context_link', '.task-context-link'), ('card_footer', '.task-card-footer'), ('task_owner', '.task-owner'), ('task_owner_avatar', '.task-owner .avatar'),
 ('task_facts', '.task-facts'), ('task_date_urgent', '.task-date.urgent'), ('plan_line', '.task-plan-line'), ('co_card_run', '.co-card-run'),
 ('add_card', '.add-card'), ('column_empty', '.column-empty'),
]
WIKI = [
 ('wiki_layout', '.wiki-layout'), ('wiki_list', '.wiki-list'), ('wiki_list_eyebrow', '.wiki-list .eyebrow'), ('wiki_search', '.wiki-list .local-search'), ('wiki_search_input', '.wiki-list .local-search input'),
 ('wiki_item', '.wiki-list .wiki-page-item:not(.active)'), ('wiki_item_label', '.wiki-list .wiki-page-item:not(.active) b'), ('wiki_item_active', '.wiki-list .wiki-page-item.active'), ('wiki_item_active_label', '.wiki-list .wiki-page-item.active b'),
 ('wiki_side_btn', '.wiki-side-actions .btn'),
 ('wiki_main', '.wiki-main'), ('wiki_topbar', '.wiki-topbar'), ('wiki_topbar_meta', '.wiki-topbar-meta'), ('wiki_topbar_iconbtn', '.wiki-topbar-actions .iconbtn'), ('wiki_topbar_primary', '.wiki-topbar .btn.primary'),
 ('wiki_document', '.wiki-document'), ('wiki_doc_project', '.wiki-document-project'), ('wiki_title', '.wiki-document-title'), ('wiki_body', '.wiki-read-content'),
 ('wiki_p', '.wiki-read-content > p'), ('wiki_h2', '.wiki-read-content h2'), ('wiki_ul', '.wiki-read-content ul'), ('wiki_li', '.wiki-read-content li'),
 ('wiki_pre', '.wiki-read-content pre'), ('wiki_code', '.wiki-read-content pre code'), ('wiki_inline_ref', '.wiki-read-content .inline-ref'), ('wiki_ref_kind', '.wiki-read-content .inline-ref .ref-kind'),
 ('wiki_tail', '.wiki-page-tail'), ('wiki_tail_h4', '.wiki-page-tail h4'), ('wiki_backlink', '.wiki-page-tail .backlink'),
]
WIKI_EDIT = [
 ('wiki_formatbar', '.wiki-formatbar'), ('wiki_format_select', '.wiki-formatbar select'), ('wiki_format_iconbtn', '.wiki-formatbar .iconbtn'), ('wiki_tool_sep', '.wiki-tool-sep'),
 ('wiki_format_segmented_active', '.wiki-formatbar .segmented button.active'), ('wiki_rich', '.wiki-rich'), ('wiki_rich_h2', '.wiki-rich h2'), ('wiki_rich_inline_ref', '.wiki-rich .inline-ref'),
 ('wiki_title_edit', '.wiki-document-title'), ('wiki_editor_bottom', '.wiki-editor-bottom'),
]
MAP = [
 ('map_toolbar', '.view > .toolbar'), ('map_select', '.view > .toolbar select'), ('map_seg_active', '.view > .toolbar .segmented button.active'), ('map_btn_layout', '.view > .toolbar .btn:not(.primary)'), ('map_btn_primary', '.view > .toolbar .btn.primary'),
 ('map_shell', '.map-shell'), ('map_canvas', '.map-canvas'), ('node_root', '.node.root'), ('node', '.node:not(.root)'), ('node_kind', '.node:not(.root) .node-kind'), ('node_text', '.node:not(.root) .node-text'),
 ('node_root_text', '.node.root .node-text'), ('node_work', '.node .node-work'), ('node_work_head', '.node .node-work-head'), ('node_plus', '.node .node-plus', {'any': True}), ('node_source', '.node .node-kind .node-meta button'),
 ('edge', '.edges .edge-line', {'any': True}), ('canvas_controls', '.canvas-controls'), ('canvas_iconbtn', '.canvas-controls .iconbtn'), ('zoom_label', '.zoom-label'), ('canvas_hint', '.canvas-hint'),
]
MAP_LIST = [
 ('map_outline', '.map-outline'), ('outline_caption', '.outline-caption'), ('outline_row', '.outline-row'), ('outline_row_selected', '.outline-row.selected'),
 ('outline_main_b', '.outline-main b'), ('outline_main_small', '.outline-main small'), ('outline_task_count', '.outline-task-count'), ('outline_children', '.outline-children'),
]
AGENTS = [
 ('co_room', '.co-room'), ('co_room_top', '.co-room-top'), ('co_heading', '.co-room-heading'), ('co_h1', '.co-room-heading h1'), ('co_delegate_btn', '.co-room-heading .btn'), ('co_settings_iconbtn', '.co-room-heading .iconbtn'),
 ('co_people', '.co-people'), ('co_person', '.co-person'), ('co_person_icon', '.co-person-icon'), ('co_person_name', '.co-person b'), ('co_person_owner', '.co-person b em'), ('co_person_status', '.co-person small'), ('co_person_status_dot', '.co-person small i'),
 ('co_focus_bar', '.co-focus-bar'), ('co_focus_task', '.co-focus-task'), ('co_focus_small', '.co-focus-task small'), ('co_focus_title', '.co-focus-task b'), ('co_open_task', '.co-open-task'),
 ('co_role_lane', '.co-role-lane'), ('co_role_label', '.co-role-lane>div>span'), ('co_role_value', '.co-role-lane>div>button'), ('co_role_arrow', '.co-role-lane .co-role-arrow'), ('co_checkpoint_btn', '.co-role-lane>.btn'),
 ('co_thread_column', '.co-thread-column'), ('co_topline', '.co-thread-topline'), ('co_msg', '.co-conversation-message'), ('co_msg_avatar', '.co-conversation-message .avatar'), ('co_msg_meta', '.co-conversation-message .msg-meta'),
 ('co_msg_name', '.co-conversation-message .msg-meta b'), ('co_msg_bubble', '.co-conversation-message .bubble'), ('co_source_link', '.co-source-link'),
 ('co_pr', '.co-pr-attachment'), ('co_pr_title', '.co-pr-attachment b'), ('co_pr_small', '.co-pr-attachment small'), ('co_pr_current', '.co-pr-current'),
 ('co_plan', '.co-plan'), ('co_plan_summary', '.co-plan > summary'), ('co_plan_lead', '.co-plan-lead'), ('co_plan_open', '.co-plan-open'),
 ('co_current', '.co-current'), ('co_current_icon', '.co-current-icon'), ('co_current_b', '.co-current-text b'), ('co_current_small', '.co-current-text small'),
 ('co_compose_dock', '.co-compose-dock'), ('co_composer', '.co-chat-composer .composer'), ('co_editor', '.co-chat-composer .editor'), ('co_send', '.co-chat-composer .send'), ('co_composer_meta', '.co-composer-meta'), ('co_footer', '.co-room-footer'), ('co_footer_btn', '.co-room-footer .btn'),
]
MODAL = [
 ('backdrop', '.backdrop'), ('modal', '.modal'), ('modal_header', '.modal-header'), ('modal_h2', '.modal-header h2'), ('modal_close', '.modal-header .iconbtn'), ('modal_content', '.modal-content'),
 ('modal_description', '.modal-description'), ('label', '.modal label'), ('input', '.modal input:not([type=checkbox]):not([type=radio])'), ('textarea', '.modal textarea'), ('select', '.modal select'),
 ('modal_footer', '.modal-footer'), ('modal_btn_primary', '.modal-footer .btn.primary'), ('modal_btn_secondary', '.modal-footer .btn:not(.primary)'),
]

def norm_color_str(s):
    if not isinstance(s, str):
        return s
    def rgb(m):
        parts = [p for p in re.split(r'[ ,/]+', m.group(1).strip()) if p]
        r, g, b = [int(round(float(x))) for x in parts[:3]]
        a = float(parts[3]) if len(parts) > 3 else 1.0
        h = '#%02x%02x%02x' % (r, g, b)
        if a < 1:
            h += '%02x' % int(round(a * 255))
        return h
    def srgb(m):
        parts = [p for p in re.split(r'[ /]+', m.group(1).strip()) if p]
        r, g, b = [int(round(float(x) * 255)) for x in parts[:3]]
        a = float(parts[3]) if len(parts) > 3 else 1.0
        h = '#%02x%02x%02x' % (r, g, b)
        if a < 1:
            h += '%02x' % int(round(a * 255))
        return h
    s = re.sub(r'rgba?\(([^)]*)\)', rgb, s)
    s = re.sub(r'color\(srgb ([^)]*)\)', srgb, s)
    return s

def norm(o):
    if isinstance(o, dict):
        return {k: norm(v) for k, v in o.items()}
    if isinstance(o, list):
        return [norm(v) for v in o]
    return norm_color_str(o)

def hover(s, sel, key_spec):
    try:
        s.page.hover(sel, timeout=2000)
        time.sleep(0.4)
        r = M(s, sel)
    except Exception as e:
        r = {'error': str(e)[:200]}
    s.page.mouse.move(1, 1)
    time.sleep(0.4)
    return r

raw = {'source_sha256': SOURCE_HASH, 'viewport_desktop': [1440, 900], 'viewport_phone': [390, 844], 'device_scale_factor': 1}
server = start_server()
with sync_playwright() as p:
    s = Session(p, server)
    raw['browser'] = s.browser.version
    raw['release'] = s.page.evaluate('({release:Flux.release,coop:FluxCoop.version})')
    raw['used_fonts_note'] = s.page.evaluate('''(()=>{const c=document.createElement('canvas').getContext('2d');const r={};for(const f of ['Segoe UI','-apple-system','BlinkMacSystemFont','Roboto','Helvetica Neue','Arial','Inter']){c.font='16px "'+f+'", monospace';const a=c.measureText('mmmmmmmmmmlli').width;c.font='16px monospace';const b=c.measureText('mmmmmmmmmmlli').width;r[f]=a!==b;}return r;})()''')
    # ---------- tokens per theme / accent ----------
    raw['tokens'] = {}
    raw['accents'] = {}
    for theme in ['light', 'dark']:
        s.fresh(theme=theme)
        install(s)
        raw['tokens'][theme] = s.page.evaluate('({prefs:{theme:Flux.prefs.theme,accent:Flux.prefs.accent,accents:Flux.prefs.accents},html:{theme:document.documentElement.dataset.theme,accent:document.documentElement.dataset.accent},...window.__vars()})')
        raw['accents'][theme] = {}
        for accent in ['mint', 'sky', 'copper']:
            s.act('accent-set', value=accent)
            install(s)
            v = s.page.evaluate('window.__vars().vars')
            raw['accents'][theme][accent] = {k: v[k] for k in ['--accent', '--accent-strong', '--on-accent', '--accent-soft', '--own'] if k in v}
            raw['accents'][theme][accent]['html_accent'] = s.page.evaluate('document.documentElement.dataset.accent')
    # ---------- desktop measurements ----------
    raw['desktop'] = {}
    for theme in ['light', 'dark']:
        d = raw['desktop'][theme] = {}
        s.fresh(theme=theme)
        s.act('view', view='chat')
        d['shell'] = measure_set(s, SHELL)
        d['header'] = measure_set(s, HEADER)
        d['chat'] = measure_set(s, CHAT)
        # hover / focus states
        d['states'] = {}
        d['states']['nav_hover'] = hover(s, '.side-scroll .nav:not(.active)', None)
        d['states']['tab_hover'] = hover(s, '.atelier-header .tab:not(.active)', None)
        d['states']['material_hover'] = hover(s, '.messages button.material', None)
        install(s)
        s.page.focus('.chat .composer .editor')
        time.sleep(0.4)
        d['states']['composer_focus'] = M(s, '.chat .composer')
        s.page.keyboard.press('Escape')
        s.page.evaluate('document.activeElement && document.activeElement.blur()')
        s.page.keyboard.press('Tab'); s.page.keyboard.press('Tab')
        s.page.clock.run_for(200)
        d['states']['focus_visible_after_2_tabs'] = s.page.evaluate('(()=>{const e=document.activeElement; const r=window.__m(e,{}); r.tag=e.tagName+"."+e.className; return r;})()')
        # toast
        s.page.evaluate('''(()=>{const t=document.querySelector('#toasts')||document.body; const el=document.createElement('div'); el.className='toast'; el.id='measure-toast'; el.innerHTML='<svg viewBox="0 0 24 24"></svg><span>Zapisano zmiany</span>'; t.appendChild(el);})()''')
        d['toast'] = {'toast': M(s, '#measure-toast'), 'toasts_container': M(s, '#toasts', any=True)}
        s.page.evaluate("document.querySelector('#measure-toast')?.remove()")
        if theme == 'light':
            s.shot('chat-1440-light.png')
        else:
            s.shot('chat-1440-dark.png')
        # tasks
        s.act('view', view='tasks')
        d['tasks'] = measure_set(s, TASKS)
        d['states']['card_hover'] = hover(s, '.task-card11', None)
        d['states']['btn_primary_hover'] = hover(s, '.tasks-toolbar .btn.primary', None)
        d['states']['btn_quiet_hover'] = hover(s, '.tasks-toolbar .btn.quiet', None)
        d['states']['iconbtn_hover'] = hover(s, '.tasks-toolbar .toolbar-group .iconbtn', None)
        d['states']['seg_inactive_hover'] = hover(s, '.tasks-toolbar .segmented button:not(.active)', None)
        d['states']['add_card_hover'] = hover(s, '.add-card', None)
        d['states']['nav_active_hover'] = hover(s, '.side-scroll .nav.active', None)
        install(s)
        s.page.focus('.tasks-toolbar .local-search input'); time.sleep(0.4)
        d['states']['local_search_focus'] = M(s, '.tasks-toolbar .local-search')
        d['states']['local_search_input_focus'] = M(s, '.tasks-toolbar .local-search input')
        s.page.evaluate('document.activeElement && document.activeElement.blur()')
        s.shot(f'tasks-1440-{theme}.png')
        # wiki
        s.act('view', view='wiki')
        d['wiki'] = measure_set(s, WIKI)
        s.shot(f'wiki-1440-{theme}.png')
        try:
            s.act('wiki-edit')
            d['wiki_edit'] = measure_set(s, WIKI_EDIT)
            if theme == 'light':
                s.shot('wiki-edit-1440-light.png')
            s.page.evaluate("Flux.action('wiki-cancel',{dataset:{}})") if False else None
        except Exception as e:
            d['wiki_edit'] = {'error': str(e)[:300]}
        # map
        s.fresh(theme=theme)
        s.act('view', view='map')
        d['map'] = measure_set(s, MAP)
        s.shot(f'map-1440-{theme}.png')
        s.act('map-view', value='list')
        d['map_list'] = measure_set(s, MAP_LIST)
        # agents
        s.fresh(theme=theme)
        s.act('view', view='agents')
        d['agents'] = measure_set(s, AGENTS)
        s.shot(f'agents-1440-{theme}.png')
        # modal (new task)
        s.fresh(theme=theme)
        s.act('view', view='tasks')
        s.act('new-task')
        d['modal_new_task'] = measure_set(s, MODAL)
        d['modal_new_task']['type'] = s.page.evaluate('Flux.ui.modal && Flux.ui.modal.type')
        install(s)
        try:
            s.page.focus('.modal input:not([type=checkbox]), .modal textarea')
            s.page.clock.run_for(200)
            d['states']['modal_field_focus'] = s.page.evaluate('(()=>{const e=document.activeElement; const r=window.__m(e,{}); r.tag=e.tagName; return r;})()')
        except Exception as e:
            d['states']['modal_field_focus'] = {'error': str(e)[:200]}
        s.shot(f'modal-new-task-1440-{theme}.png')
        # settings / appearance modal
        s.fresh(theme=theme)
        s.act('settings')
        d['modal_settings'] = measure_set(s, MODAL + [
            ('settings_tab', '.settings-tab:not(.active)'), ('settings_tab_active', '.settings-tab.active'), ('theme_option', '.theme-option:not(.selected)'), ('theme_option_selected', '.theme-option.selected'),
            ('swatch', '.swatch'), ('swatch_dot', '.swatch .dot'), ('settings_row', '.settings-row')])
        d['modal_settings']['type'] = s.page.evaluate('Flux.ui.modal && Flux.ui.modal.type')
        if theme == 'light':
            s.shot('modal-settings-1440-light.png')
        # project menu
        s.fresh(theme=theme)
        s.page.click('.atelier-project-menu'); s.page.clock.run_for(300)
        d['menu'] = measure_set(s, [('menu', '.menu'), ('menu_btn', '.menu button'), ('menu_label', '.menu .menu-label'), ('menu_sub', '.menu .menu-sub')])
        if theme == 'light':
            s.shot('menu-project-1440-light.png')
    # ---------- phone ----------
    raw['phone'] = {}
    for theme in ['light']:
        ph = raw['phone'][theme] = {}
        s.fresh(390, 844, theme=theme)
        s.act('view', view='chat')
        ph['chat'] = measure_set(s, [
            ('shell', '.shell'), ('sidebar_closed', '.sidebar'), ('main', '.main'), ('menu_toggle', '.atelier-header .mobile-only, .header .mobile-only'),
            ('header', '.atelier-header'), ('head_top', '.atelier-header .head-top'), ('head_name', '.atelier-header .head-name'), ('goal_chip', '.atelier-header .goal-chip'),
            ('members_label', '.atelier-header .members-label', {'any': True}), ('head_controls', '.atelier-header .head-controls'), ('live_button', '.head-controls .live-button'),
            ('tabs', '.atelier-header .tabs'), ('tab', '.atelier-header .tab:not(.active)'), ('tab_active', '.atelier-header .tab.active'), ('catchup', '.catchup-button'),
            ('messages', '.messages'), ('msg', '.messages > .msg'), ('msg_avatar', '.messages .msg-avatar', {'any': True}), ('msg_wrap', '.messages .msg-wrap'), ('bubble', '.messages .bubble'),
            ('composer_wrap', '.chat > .composer-wrap'), ('composer', '.chat .composer'), ('composer_iconbtn', '.chat .composer-tools .iconbtn'), ('send', '.chat .composer .send'), ('composer_caption', '.chat .composer-caption')])
        s.shot('chat-390-light.png')
        s.act('toggle-sidebar')
        s.page.clock.run_for(400)
        ph['menu_open'] = measure_set(s, [('shell', '.shell'), ('sidebar_open', '.sidebar'), ('nav', '.sidebar .nav'), ('brand', '.sidebar .brand'), ('nav_active', '.sidebar .nav.active')])
        s.shot('chat-390-menu-open-light.png')
        s.fresh(390, 844, theme=theme)
        s.act('view', view='tasks')
        ph['tasks'] = measure_set(s, [('toolbar', '.tasks-toolbar'), ('board', '.board'), ('column', '.column'), ('card', '.task-card11'), ('seg_btn', '.tasks-toolbar .segmented button'), ('btn_primary', '.tasks-toolbar .btn.primary')])
        s.shot('tasks-390-light.png')
        s.act('view', view='agents')
        ph['agents'] = measure_set(s, [('co_room_top', '.co-room-top'), ('co_h1', '.co-room-heading h1'), ('co_composer', '.co-chat-composer .composer')])
        s.shot('agents-390-light.png')
    # ---------- intermediate widths: root vars ----------
    raw['widths'] = {}
    for w, h in [(390, 844), (680, 900), (760, 900), (900, 900), (1000, 900), (1100, 900), (1200, 900), (1440, 900), (1600, 900), (1920, 1080)]:
        s.fresh(w, h, theme='light')
        install(s)
        v = s.page.evaluate('window.__vars().vars')
        r = s.page.evaluate('''(()=>{const q=s=>{const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); const c=getComputedStyle(e); return {rect:[r.x,r.y,r.width,r.height].map(Math.round), padding:c.padding, radius:c.borderRadius, position:c.position, transform:c.transform};}; return {shell:q('.shell'), sidebar:q('.sidebar'), main:q('.main'), header:q('.atelier-header'), messages:q('.messages'), composer:q('.chat .composer'), head_name_fs:getComputedStyle(document.querySelector('.head-name')).fontSize, tab_fs:getComputedStyle(document.querySelector('.atelier-header .tab')).fontSize, tabs_gap:getComputedStyle(document.querySelector('.atelier-header .tabs')).columnGap};})()''')
        raw['widths'][str(w)] = {'vars': {k: v[k]['raw'] for k in ['--sidebar', '--drawer', '--space-page', '--text-measure', '--radius'] if k in v}, 'layout': r}
    raw['page_errors'] = s.errors
    s.browser.close()
server.shutdown()

# ---------- CSS text: media queries & motion ----------
css = HTML.read_text(encoding='utf-8')
css = css[css.index('<style>') + 7: css.index('</style>')]
lines = css.split('\n')
def layer_for(pos):
    line_no = css[:pos].count('\n') + 7
    marks = [(7, '09 base'), (35, '10'), (57, '11.1'), (92, '11.1 rhythm'), (103, '11.2 co-op'), (202, '11.3'), (348, '11.4 Pracownia'), (733, '11.5'), (774, '11.6')]
    lay = None
    for ln, name in marks:
        if line_no >= ln:
            lay = name
    return line_no, lay
media = []
i = 0
while True:
    j = css.find('@media', i)
    if j < 0:
        break
    k = css.index('{', j)
    cond = css[j + 6:k].strip()
    depth = 1; m = k + 1
    while depth:
        if css[m] == '{': depth += 1
        elif css[m] == '}': depth -= 1
        m += 1
    body = css[k + 1:m - 1]
    ln, lay = layer_for(j)
    root_vars = re.findall(r':root(?:\[data-theme\])?\{([^}]*)\}', body)
    rv = {}
    for blk in root_vars:
        for decl in blk.split(';'):
            if decl.strip().startswith('--'):
                a, b = decl.split(':', 1); rv[a.strip()] = b.strip()
    selectors = re.findall(r'([^{}]+)\{', body)
    media.append({'line': ln, 'layer': lay, 'condition': cond, 'root_vars': rv, 'n_rules': len(selectors),
                  'key_rules': [x.strip()[:90] for x in selectors if re.search(r'\.shell|\.sidebar|\.main\b|\.atelier-header|\.drawer\b|\.messages|\.composer|\.board|\.column\b|\.wiki-list|\.tabs', x)][:25]})
    i = m
raw['media'] = media
motion = []
for mt in re.finditer(r'([^{}]+)\{([^{}]*)\}', css):
    sel, body = mt.group(1).strip(), mt.group(2)
    for decl in body.split(';'):
        dd = decl.strip()
        if re.match(r'(transition|animation)(-[a-z]+)?\s*:', dd) or dd.startswith('@keyframes'):
            ln, lay = layer_for(mt.start())
            motion.append({'line': ln, 'layer': lay, 'selector': sel[-120:], 'decl': dd})
raw['motion'] = motion
raw['keyframes'] = re.findall(r'@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}', css)
(OUT / 'measured.json').write_text(json.dumps(norm(raw), ensure_ascii=False, indent=1))
print('ok', len(media), len(motion), raw.get('page_errors'))
