'use strict';
CustomEase.create("smooth","M0,0 C0.16,0 0.17,0.96 0.48,0.98 0.7,1 0.84,1 1,1");
CustomEase.create("pop","M0,0 C0.12,0 0.16,1.12 0.5,1.04 0.7,1 0.84,1 1,1");

// ── PDF.js setup ───────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ──────────────────────────────────────────────────────────────────
let pdfDoc        = null;
let pdfScale      = 1.2;
let pdfRendering  = {};        // pageNum → true while rendering
let pdfRendered   = {};        // pageNum → true once done
let totalPages    = 0;
let currentView   = 'pdf';     // 'pdf' | 'ocr'

let annotations   = [];        // [{id,page,rects:[{x,y,w,h}],text,color}]
let annOpen       = false;
let firstHighlight= true;

let quizData=[], quizDiff='easy', quizNq=5;
let summaryDone=false, chaptersDone=false;
let openTabs=[], activeTab='learn';

let examData=[],examIdx=0,examAnswers={},examTimer=null,examSecs=0,examDone=false;

let chatHistory   = [];        // [{role,content}]
let chatThreadId  = null;      // lazy-assigned on first message
let chatSending   = false;

// Selection tracking
let _selText = '';
let _selPage = 0;
let _selRects= [];             // [{x,y,w,h}] relative to page

// ── Hard fallback loader ───────────────────────────────────────────────────
setTimeout(()=>{
  const ld=document.getElementById('loader');
  const ly=document.getElementById('layout');
  if(ld)ld.style.display='none';
  if(ly)ly.style.opacity='1';
},4000);

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async ()=>{
  lucide.createIcons();
  startLucideObserver();

  const tl=gsap.timeline({defaults:{ease:'smooth'}});
  tl
    .to('#loader',{opacity:0,duration:.3,onComplete:()=>{document.getElementById('loader').style.display='none'}})
    .set('#layout',{opacity:1})
    .fromTo('.topbar',{opacity:0,y:-8},{opacity:1,y:0,duration:.35})
    .fromTo('.panel-left',{opacity:0,x:-18},{opacity:1,x:0,duration:.45,ease:'pop'},'-=.2')
    .fromTo('.panel-right',{opacity:0,x:18},{opacity:1,x:0,duration:.45,ease:'pop'},'-=.4')
    .fromTo('.tool-btn',{opacity:0,y:14,scale:.97},{opacity:1,y:0,scale:1,duration:.3,stagger:.06,ease:'pop'},'-=.2');

  updateSlider();
  await loadAnnotations();
  checkFigures();

  if(SESSION_PDF_URL){
    loadPDF(SESSION_PDF_URL);
  } else {
    // No PDF — go straight to OCR view, hide PDF controls
    switchView('ocr');
    document.getElementById('vt-pdf').style.display='none';
    document.getElementById('pdf-controls').style.display='none';
  }
});

function startLucideObserver(){
  let _ldeb;
  const obs=new MutationObserver(mutations=>{
    const hasNew=mutations.some(m=>Array.from(m.addedNodes).some(n=>n.dataset?.lucide||n.querySelector?.('[data-lucide]')));
    if(!hasNew)return;
    obs.disconnect();
    clearTimeout(_ldeb);
    _ldeb=setTimeout(()=>{lucide.createIcons();obs.observe(document.body,{childList:true,subtree:true});},80);
  });
  obs.observe(document.body,{childList:true,subtree:true});
}

// ── PDF LOADER ────────────────────────────────────────────────────────────
async function loadPDF(url){
  const container = document.getElementById('pdf-container');
  try {
    const loadingTask = pdfjsLib.getDocument(url);
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;
    document.getElementById('total-pages').textContent = totalPages;
    document.getElementById('current-page').textContent = '1';

    // Build page placeholders first (fast)
    container.innerHTML = '';
    for(let i=1; i<=totalPages; i++){
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.id = `pdf-page-${i}`;
      wrap.dataset.page = i;
      // temporary placeholder size — will be set correctly on render
      wrap.style.width = '600px';
      wrap.style.height = '780px';
      const ph = document.createElement('div');
      ph.className = 'pdf-page-placeholder';
      ph.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center';
      ph.textContent = `Page ${i}`;
      wrap.appendChild(ph);
      container.appendChild(wrap);
    }

    // Observe which pages are visible
    setupPageObserver();
    // Render page 1 immediately
    renderPage(1);

  } catch(e){
    console.error('[PDF.js] Load failed:', e);
    container.innerHTML = `<div class="pdf-unavailable" style="margin:40px auto;color:#ccc">
      <p>Could not load PDF: ${esc(e.message)}</p>
      <button class="vtbtn" style="margin-top:12px;background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.2)" onclick="switchView('ocr')">View OCR output instead</button>
    </div>`;
  }
}

function setupPageObserver(){
  const obs = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting){
        const page = parseInt(entry.target.dataset.page);
        if(page && !pdfRendered[page]) renderPage(page);
        // Update current page display
        document.getElementById('current-page').textContent = page;
      }
    });
  },{root: document.getElementById('pdf-container'), rootMargin:'200px 0px', threshold:0.01});

  document.querySelectorAll('.pdf-page-wrap').forEach(w=>obs.observe(w));
}

async function renderPage(pageNum){
  if(pdfRendering[pageNum] || pdfRendered[pageNum]) return;
  if(!pdfDoc || pageNum < 1 || pageNum > totalPages) return;
  pdfRendering[pageNum] = true;

  try {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({scale: pdfScale});

    const wrap = document.getElementById(`pdf-page-${pageNum}`);
    if(!wrap){ pdfRendering[pageNum]=false; return; }

    wrap.innerHTML = '';
    wrap.style.width  = viewport.width  + 'px';
    wrap.style.height = viewport.height + 'px';

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'block';
    wrap.appendChild(canvas);

    await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;

    // Text layer
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'pdf-text-layer active';
    textLayerDiv.dataset.page = pageNum;
    wrap.appendChild(textLayerDiv);

    const textContent = await page.getTextContent();
    await pdfjsLib.renderTextLayer({
      textContent,
      container: textLayerDiv,
      viewport,
      textDivs: [],
    }).promise;

    // Annotation layer
    const annLayer = document.createElement('div');
    annLayer.className = 'pdf-ann-layer';
    annLayer.dataset.page = pageNum;
    wrap.appendChild(annLayer);

    // Draw saved highlights for this page
    drawPageHighlights(pageNum, viewport.width, viewport.height);

    pdfRendered[pageNum] = true;

  } catch(e){
    console.error(`[PDF.js] Render page ${pageNum} failed:`, e);
  }
  pdfRendering[pageNum] = false;
}

// Re-render all currently rendered pages (for zoom)
async function rerenderAll(){
  pdfRendered = {};
  pdfRendering = {};
  document.querySelectorAll('.pdf-page-wrap').forEach(w=>{
    const pg = parseInt(w.dataset.page);
    w.innerHTML = '';
    w.style.width='600px'; w.style.height='780px';
    const ph=document.createElement('div');
    ph.className='pdf-page-placeholder';
    ph.style.cssText='width:100%;height:100%;display:flex;align-items:center;justify-content:center';
    ph.textContent=`Page ${pg}`;
    w.appendChild(ph);
  });
  setupPageObserver();
  renderPage(1);
}

// ── PAGE NAVIGATION ────────────────────────────────────────────────────────
function goToPage(n){
  if(!pdfDoc || n<1 || n>totalPages) return;
  const wrap = document.getElementById(`pdf-page-${n}`);
  if(wrap){
    wrap.scrollIntoView({behavior:'smooth', block:'start'});
    document.getElementById('current-page').textContent = n;
  }
}
function prevPage(){
  const cur = parseInt(document.getElementById('current-page').textContent)||1;
  goToPage(cur-1);
}
function nextPage(){
  const cur = parseInt(document.getElementById('current-page').textContent)||1;
  goToPage(cur+1);
}

// ── ZOOM ──────────────────────────────────────────────────────────────────
function zoomIn(){
  if(pdfScale >= 3.0) return;
  pdfScale = Math.min(3.0, pdfScale + 0.2);
  updateZoomLabel();
  rerenderAll();
}
function zoomOut(){
  if(pdfScale <= 0.5) return;
  pdfScale = Math.max(0.5, pdfScale - 0.2);
  updateZoomLabel();
  rerenderAll();
}
function updateZoomLabel(){
  document.getElementById('zoom-label').textContent = Math.round(pdfScale*100/1.2)+'%';
}

// ── VIEW SWITCHER ─────────────────────────────────────────────────────────
function switchView(mode){
  currentView = mode;
  const pdfContainer = document.getElementById('pdf-container');
  const ocrView      = document.getElementById('ocr-view');
  const vtPdf        = document.getElementById('vt-pdf');
  const vtOcr        = document.getElementById('vt-ocr');
  const pdfControls  = document.getElementById('pdf-controls');

  if(mode === 'pdf'){
    pdfContainer.style.display = 'flex';
    ocrView.style.display      = 'none';
    vtPdf.classList.add('active');
    vtOcr.classList.remove('active');
    pdfControls.style.display  = '';
    hideSelToolbar();
  } else {
    pdfContainer.style.display = 'none';
    ocrView.style.display      = 'flex';
    vtPdf.classList.remove('active');
    vtOcr.classList.add('active');
    pdfControls.style.display  = 'none';
    renderOCRView();
    attachOCRSelectionListener();

    // Word count in meta
    const meta = document.getElementById('reader-meta');
    if(meta && SESSION_RAW_TEXT){
      const words = SESSION_RAW_TEXT.trim().split(/\s+/).filter(Boolean).length;
      meta.textContent = `${words.toLocaleString()} words · ${Math.ceil(words/200)} min read`;
    }
  }
}

// ── OCR VIEW RENDERER ─────────────────────────────────────────────────────
let ocrRendered = false;
function renderOCRView(){
  if(ocrRendered) return;
  ocrRendered = true;
  const container = document.getElementById('ocr-view');
  if(!SESSION_RAW_TEXT){
    container.innerHTML = '<div style="padding:40px 32px;color:var(--g4);font-size:13px">No OCR content available.</div>';
    return;
  }

  // Split by [Page N] markers
  const parts = SESSION_RAW_TEXT.split(/\n(?=\[Page \d+\])/);
  let html = '';
  for(const part of parts){
    const m = part.match(/^\[Page (\d+)\]\n?([\s\S]*)/);
    if(m){
      const pageNum = m[1];
      const md = m[2].trim();
      html += `<div class="ocr-page" id="ocr-page-${pageNum}">
        <div class="ocr-page-label">Page ${pageNum}</div>
        <div class="ocr-content">${marked.parse(md||'')}</div>
      </div>`;
    } else if(part.trim()){
      html += `<div class="ocr-page"><div class="ocr-content">${marked.parse(part.trim())}</div></div>`;
    }
  }
  container.innerHTML = html || '<div style="padding:40px 32px;color:var(--g4)">No content extracted.</div>';
}

// ── SELECTION — PDF TEXT LAYER ─────────────────────────────────────────────
document.addEventListener('mouseup', (e)=>{
  if(currentView !== 'pdf') return;
  const sel = window.getSelection();
  if(!sel || sel.isCollapsed || !sel.toString().trim()){
    hideSelToolbar();
    return;
  }

  // Find which page this selection is in
  let pageNum = 0;
  let node = sel.anchorNode;
  while(node){
    if(node.classList?.contains('pdf-text-layer')){ pageNum = parseInt(node.dataset.page)||0; break; }
    node = node.parentElement;
  }
  if(!pageNum){ hideSelToolbar(); return; }

  _selText = sel.toString().trim();
  _selPage = pageNum;

  // Compute rects relative to page wrap
  const wrap = document.getElementById(`pdf-page-${pageNum}`);
  if(!wrap){ hideSelToolbar(); return; }
  const wRect = wrap.getBoundingClientRect();
  const range = sel.getRangeAt(0);
  const clientRects = Array.from(range.getClientRects());
  _selRects = clientRects.map(r=>({
    x: (r.left - wRect.left) / wRect.width,
    y: (r.top  - wRect.top)  / wRect.height,
    w: r.width  / wRect.width,
    h: r.height / wRect.height,
  })).filter(r=>r.w>0 && r.h>0);

  positionSelToolbarFromRange(range);
});

// ── SELECTION — OCR VIEW ──────────────────────────────────────────────────
let _ocrSelAttached = false;
function attachOCRSelectionListener(){
  if(_ocrSelAttached) return;
  _ocrSelAttached = true;
  document.addEventListener('mouseup', (e)=>{
    if(currentView !== 'ocr') return;
    const sel = window.getSelection();
    if(!sel || sel.isCollapsed || !sel.toString().trim()){
      hideSelToolbar(); return;
    }
    const ocrView = document.getElementById('ocr-view');
    if(!ocrView.contains(sel.anchorNode)){ hideSelToolbar(); return; }
    _selText = sel.toString().trim();
    _selPage = 0;
    _selRects = [];
    positionSelToolbarFromRange(sel.getRangeAt(0));
  });
}

function positionSelToolbarFromRange(range){
  const toolbar = document.getElementById('sel-toolbar');
  const rect = range.getBoundingClientRect();
  const tw = toolbar.offsetWidth || 280;
  let left = rect.left + rect.width/2 - tw/2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  toolbar.style.top  = (rect.top + window.scrollY - 54) + 'px';
  toolbar.style.left = left + 'px';
  toolbar.classList.add('visible');
}

function hideSelToolbar(){
  document.getElementById('sel-toolbar').classList.remove('visible');
}

// ── SELECTION ACTIONS ─────────────────────────────────────────────────────
async function selExplain(){
  const text = _selText;
  if(!text) return;
  hideSelToolbar();
  const overlay = document.getElementById('explain-overlay');
  const out = document.getElementById('explain-text');
  out.textContent = 'Explaining…';
  overlay.style.transform = 'translateY(0)';
  try{
    const res = await fetch(`/api/session/${SESSION_ID}/text_explain`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({text})
    });
    const data = await res.json();
    out.innerHTML = fmt(data.result || data.error || 'Could not explain.');
  }catch(e){ out.textContent='Network error.'; }
}

function selChatWith(){
  const text = _selText;
  if(!text) return;
  hideSelToolbar();
  // Pre-fill chat input with context, open Chat tab
  const inp = document.getElementById('rp-chat-input');
  if(inp){
    inp.value = `Explain this: "${text.slice(0,200)}"`;
    inp.focus();
    autoResizeChat(inp);
  }
  openToolTab('chat','Chat','message-circle','#8b5cf6');
}

function selAddToNotes(){
  const text = _selText;
  if(!text) return;
  hideSelToolbar();
  const ta = document.getElementById('notes-ta');
  if(ta) ta.value = ta.value ? ta.value + '\n\n> ' + text : '> ' + text;
  openToolTab('notes','Notes','notebook-pen','var(--c-notes)');
  toast('Added to notes');
}

function selHighlight(color='yellow'){
  const text = _selText;
  if(!text) return;
  hideSelToolbar();

  if(currentView === 'pdf'){
    if(!_selPage || !_selRects.length){
      toast('Select text in the PDF view to highlight');
      return;
    }
    const id = Date.now();
    const ann = {id, page:_selPage, rects:_selRects, text, color};
    annotations.push(ann);
    saveAnnotations();

    // Draw immediately
    const wrap = document.getElementById(`pdf-page-${_selPage}`);
    if(wrap){
      const w = wrap.getBoundingClientRect().width;
      const h = wrap.getBoundingClientRect().height;
      drawHighlight(ann, w, h);
    }
    addAnnotationCard(ann);
    if(firstHighlight){ firstHighlight=false; openAnnotationsAuto(); }

  } else if(currentView === 'ocr'){
    // OCR view: wrap with mark element
    const sel = window.getSelection();
    if(!sel || sel.isCollapsed) return;
    const id = Date.now();
    try{
      const range = sel.getRangeAt(0);
      const mark = document.createElement('mark');
      mark.dataset.color = color;
      mark.dataset.annId = id;
      mark.style.background = highlightBg(color);
      mark.style.borderBottom = `2px solid ${highlightBorder(color)}`;
      mark.style.borderRadius = '2px';
      range.surroundContents(mark);
      window.getSelection().removeAllRanges();
    }catch(e){ toast('Could not highlight here'); return; }
    const ann = {id, page:0, rects:[], text, color};
    annotations.push(ann);
    saveAnnotations();
    addAnnotationCard(ann);
    if(firstHighlight){ firstHighlight=false; openAnnotationsAuto(); }
  }
  _selText=''; _selRects=[];
}

function highlightBg(c){
  return {yellow:'rgba(255,214,0,.38)',blue:'rgba(26,110,255,.22)',green:'rgba(16,185,129,.22)',red:'rgba(229,57,53,.18)'}[c]||'rgba(255,214,0,.38)';
}
function highlightBorder(c){
  return {yellow:'rgba(255,190,0,.7)',blue:'rgba(26,110,255,.5)',green:'rgba(16,185,129,.5)',red:'rgba(229,57,53,.5)'}[c]||'rgba(255,190,0,.7)';
}

// ── DRAW HIGHLIGHTS ON PDF PAGES ──────────────────────────────────────────
function drawHighlight(ann, pageW, pageH){
  const annLayer = document.querySelector(`.pdf-ann-layer[data-page="${ann.page}"]`);
  if(!annLayer) return;
  ann.rects.forEach(r=>{
    const div = document.createElement('div');
    div.className = 'pdf-highlight';
    div.dataset.color = ann.color;
    div.dataset.annId = ann.id;
    div.style.left   = (r.x * pageW) + 'px';
    div.style.top    = (r.y * pageH) + 'px';
    div.style.width  = (r.w * pageW) + 'px';
    div.style.height = (r.h * pageH) + 'px';
    div.title = ann.text.slice(0,80);
    annLayer.appendChild(div);
  });
}

function drawPageHighlights(pageNum, pageW, pageH){
  annotations.filter(a=>a.page===pageNum).forEach(a=>drawHighlight(a, pageW, pageH));
}

// ── ANNOTATIONS PERSISTENCE ───────────────────────────────────────────────
async function loadAnnotations(){
  try{
    const res = await fetch(`/api/session/${SESSION_ID}/annotations`);
    const data = await res.json();
    annotations = data.annotations || [];
    renderAnnotationsList();
  }catch(e){
    // Fallback to session storage
    try{ annotations = JSON.parse(sessionStorage.getItem('ann_'+SESSION_ID)||'[]'); }catch(_){}
    renderAnnotationsList();
  }
}

async function saveAnnotations(){
  renderAnnotationsList();
  sessionStorage.setItem('ann_'+SESSION_ID, JSON.stringify(annotations));
  try{
    await fetch(`/api/session/${SESSION_ID}/annotations`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({annotations})
    });
  }catch(e){ console.warn('[Annotations] Save failed:', e); }
}

function addAnnotationCard(ann){
  const badge = document.getElementById('ann-badge');
  const n = annotations.length;
  if(badge) badge.style.display = n>0?'block':'none';
  renderAnnotationsList();
  if(firstHighlight){ firstHighlight=false; openAnnotationsAuto(); }
}

function renderAnnotationsList(){
  const list  = document.getElementById('ann-list');
  const empty = document.getElementById('ann-empty');
  const badge = document.getElementById('ann-badge');
  const n = annotations.length;
  if(badge) badge.style.display = n>0?'block':'none';
  if(n===0){ if(empty)empty.style.display='flex'; if(list)list.innerHTML=''; return; }
  if(empty) empty.style.display='none';
  if(!list) return;
  list.innerHTML = `<span class="ann-count-lbl">${n} annotation${n===1?'':'s'}</span>` +
    annotations.map(a=>`
      <div class="ann-card" data-color="${a.color}" onclick="jumpToAnnotation(${a.id})" style="cursor:pointer">
        <div class="ann-text">${esc(a.text.slice(0,120))}${a.text.length>120?'…':''}</div>
        <div class="ann-footer">
          <span class="ann-color-badge">${a.color}${a.page?` · p.${a.page}`:''}</span>
          <button class="ann-del" onmousedown="event.preventDefault()" onclick="event.stopPropagation();removeAnnotation(${a.id})" title="Remove">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>`).join('');
}

function jumpToAnnotation(id){
  const ann = annotations.find(a=>a.id===id);
  if(!ann) return;
  if(ann.page > 0){
    // PDF annotation — switch to PDF view and scroll to page
    if(currentView!=='pdf') switchView('pdf');
    setTimeout(()=>goToPage(ann.page), 100);
  } else {
    // OCR annotation — switch to OCR and find mark
    if(currentView!=='ocr') switchView('ocr');
    setTimeout(()=>{
      const mark = document.querySelector(`mark[data-ann-id="${id}"]`);
      if(mark) mark.scrollIntoView({behavior:'smooth', block:'center'});
    }, 100);
  }
}

function removeAnnotation(id){
  annotations = annotations.filter(a=>a.id!==id);
  saveAnnotations();
  // Remove from DOM
  document.querySelectorAll(`[data-ann-id="${id}"]`).forEach(el=>{
    if(el.tagName==='MARK'){
      const p=el.parentNode;
      while(el.firstChild) p.insertBefore(el.firstChild,el);
      p.removeChild(el);
    } else {
      el.remove();
    }
  });
}

// ── ANNOTATIONS DRAWER ────────────────────────────────────────────────────
function toggleAnnotations(){
  annOpen = !annOpen;
  const drawer = document.getElementById('ann-drawer');
  const btn    = document.getElementById('ann-nav-btn');
  if(annOpen){
    drawer.classList.add('open');
    btn.style.color='var(--black)';
    gsap.fromTo(drawer,{x:40,opacity:.6},{x:0,opacity:1,duration:.26,ease:'pop'});
  } else closeAnnotations();
}
function closeAnnotations(){
  annOpen=false;
  const drawer=document.getElementById('ann-drawer');
  const btn=document.getElementById('ann-nav-btn');
  btn.style.color='';
  gsap.to(drawer,{x:40,opacity:0,duration:.22,ease:'power2.in',onComplete:()=>{
    drawer.classList.remove('open'); gsap.set(drawer,{clearProps:'all'});
  }});
}
function openAnnotationsAuto(){ if(!annOpen) toggleAnnotations(); }

// ── TAB SYSTEM ────────────────────────────────────────────────────────────
function switchTab(id){
  activeTab=id;
  document.querySelectorAll('.rp-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.rp-tab-dyn').forEach(t=>t.classList.toggle('active',t.dataset.tab===id));
  const staticTab=document.getElementById('tab-'+id);
  if(staticTab) staticTab.classList.add('active');
  document.querySelectorAll('.rp-panel').forEach(p=>p.classList.remove('active'));
  const panel=document.getElementById('panel-'+id);
  if(panel){ panel.style.display='block'; panel.classList.add('active'); }
  updateSlider();
  if(annOpen) closeAnnotations();
}

function openToolTab(id,label,icon,color){
  if(openTabs.find(t=>t.id===id)){ switchTab(id); return; }
  openTabs.push({id,label,icon,color});
  const panel=document.getElementById('panel-'+id);
  if(panel) panel.style.display='block';
  const btn=document.createElement('button');
  btn.className='rp-tab-dyn'; btn.id='tab-dyn-'+id; btn.dataset.tab=id;
  const iTag=document.createElement('i');
  iTag.dataset.lucide=icon; iTag.style.width='12px'; iTag.style.height='12px'; iTag.style.color=color;
  btn.appendChild(iTag);
  const span=document.createElement('span'); span.textContent=label; btn.appendChild(span);
  const closeBtn=document.createElement('button');
  closeBtn.className='tab-close';
  closeBtn.innerHTML=`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.onclick=e=>closeTab(e,id);
  btn.appendChild(closeBtn);
  btn.onclick=()=>{ switchTab(id); if(id==='figures') loadFigures(); };
  document.getElementById('dyn-tabs').appendChild(btn);
  lucide.createIcons();
  switchTab(id);
  gsap.fromTo(btn,{opacity:0,x:10},{opacity:1,x:0,duration:.22,ease:'power2.out'});
}

function closeTab(e,id){
  e.stopPropagation();
  openTabs=openTabs.filter(t=>t.id!==id);
  const btn=document.getElementById('tab-dyn-'+id);
  const panel=document.getElementById('panel-'+id);
  gsap.to(btn,{opacity:0,x:-8,duration:.18,ease:'power2.in',onComplete:()=>{btn?.remove();updateSlider();}});
  if(panel) panel.style.display='none';
  if(activeTab===id) switchTab('learn');
}

function updateSlider(){
  const slider=document.getElementById('rp-slider');
  const nav=document.getElementById('rp-nav');
  if(!slider||!nav) return;
  const activeEl=document.querySelector('.rp-tab.active, .rp-tab-dyn.active');
  if(!activeEl){ slider.style.width='0'; return; }
  const nr=nav.getBoundingClientRect();
  const ar=activeEl.getBoundingClientRect();
  slider.style.left=(ar.left-nr.left+nav.scrollLeft)+'px';
  slider.style.width=ar.width+'px';
}

// ── CHAT BAR ──────────────────────────────────────────────────────────────
function chatInputKeydown(e){
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChatMessage(); }
}

function autoResizeChat(el){
  el.style.height='auto';
  el.style.height=Math.min(el.scrollHeight, 120)+'px';
}

async function sendChatMessage(){
  if(chatSending) return;
  const inp = document.getElementById('rp-chat-input');
  const msg = inp.value.trim();
  if(!msg) return;

  // Open Chat tab if not open
  if(!openTabs.find(t=>t.id==='chat')){
    openToolTab('chat','Chat','message-circle','#8b5cf6');
  } else {
    switchTab('chat');
  }

  inp.value='';
  autoResizeChat(inp);
  chatSending=true;
  document.getElementById('rp-chat-send').disabled=true;

  // Hide empty state
  const emptyEl = document.getElementById('chat-empty');
  if(emptyEl) emptyEl.style.display='none';

  // Append user bubble
  appendChatBubble('user', msg);
  chatHistory.push({role:'user', content:msg});

  // Thinking indicator
  const thinkId = 'think-'+Date.now();
  appendThinking(thinkId);

  // Ensure thread id
  if(!chatThreadId) chatThreadId = 'pdf_chat_' + SESSION_ID;

  try{
    const res = await fetch(`/api/session/${SESSION_ID}/thread/${chatThreadId}/chat`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message:msg, history:chatHistory.slice(-8), thread_name:'PDF Chat'})
    });
    const data = await res.json();
    removeThinking(thinkId);
    if(data.ok){
      const reply = data.result||'';
      chatHistory.push({role:'assistant', content:reply});
      appendChatBubble('ai', reply);
    } else {
      appendChatBubble('ai', '⚠ ' + (data.error||'Something went wrong.'));
    }
  }catch(e){
    removeThinking(thinkId);
    appendChatBubble('ai','⚠ Network error. Please try again.');
  }

  chatSending=false;
  document.getElementById('rp-chat-send').disabled=false;
  inp.focus();
}

function appendChatBubble(role, text){
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}`;
  div.innerHTML = role==='ai' ? fmt(text) : esc(text);
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendThinking(id){
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-thinking';
  div.id = id;
  div.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeThinking(id){
  document.getElementById(id)?.remove();
}

// ── SUMMARY ───────────────────────────────────────────────────────────────
async function genSummary(){
  if(summaryDone) return;
  const btn=document.getElementById('summary-gen-btn');
  btn.classList.add('loading'); btn.disabled=true;
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/summarize`,{method:'POST'});
    const data=await res.json();
    const text=data.summary||data.result||data.error||'No summary.';
    summaryDone=true; btn.style.display='none';
    document.getElementById('summary-output').innerHTML=`<div class="output-card">${fmt(text)}</div>`;
  }catch(e){ toast('Network error'); }
  btn.classList.remove('loading'); btn.disabled=false;
}

// ── QUIZ ──────────────────────────────────────────────────────────────────
function setDiff(btn){ document.querySelectorAll('[data-diff]').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); quizDiff=btn.dataset.diff; }
function setNq(btn)  { document.querySelectorAll('[data-nq]').forEach(b=>b.classList.remove('active'));   btn.classList.add('active'); quizNq=parseInt(btn.dataset.nq); }

async function genQuiz(){
  const btn=document.getElementById('quiz-gen-btn');
  btn.classList.add('loading'); btn.disabled=true;
  quizData=[]; document.getElementById('quiz-output').innerHTML='';
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/quiz`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({difficulty:quizDiff,num_questions:quizNq})});
    const data=await res.json();
    let qs=null;
    if(data.questions) qs=data.questions;
    else if(data.result){ try{qs=JSON.parse(data.result);}catch{} }
    if(qs&&Array.isArray(qs)){ quizData=qs; renderQuiz(qs); }
    else toast('Could not parse quiz.');
  }catch(e){ toast('Network error'); }
  btn.classList.remove('loading'); btn.disabled=false;
}

function renderQuiz(qs){
  document.getElementById('quiz-output').innerHTML=qs.map((q,qi)=>`
    <div class="quiz-card">
      <div class="quiz-q">${qi+1}. ${esc(q.question)}</div>
      <div class="quiz-options">${(q.options||[]).map((opt,oi)=>`
        <div class="quiz-opt" data-qi="${qi}" data-oi="${oi}" onclick="pickOpt(${qi},${oi})">
          ${String.fromCharCode(65+oi)}. ${esc(opt)}
        </div>`).join('')}
      </div>
    </div>`).join('');
}

function pickOpt(qi,oi){
  const q=quizData[qi]; if(!q) return;
  const ci=resolveCorrectIdx(q);
  document.querySelectorAll(`[data-qi="${qi}"]`).forEach((el,j)=>{
    el.classList.remove('correct','wrong');
    if(j===ci) el.classList.add('correct'); else if(j===oi) el.classList.add('wrong');
  });
}

// ── NOTES ─────────────────────────────────────────────────────────────────
function applyNote(type){
  const ta=document.getElementById('notes-ta'); if(!ta) return;
  const s=ta.selectionStart,e=ta.selectionEnd,sel=ta.value.slice(s,e);
  const w={bold:`**${sel}**`,italic:`_${sel}_`,h2:`## ${sel}`,bullet:`- ${sel}`};
  ta.value=ta.value.slice(0,s)+(w[type]||sel)+ta.value.slice(e); ta.focus();
}

async function saveNotes(){
  const text=document.getElementById('notes-ta')?.value||'';
  try{
    await fetch(`/api/session/${SESSION_ID}/notes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:text})});
    toast('Notes saved');
  }catch(e){ toast('Save failed'); }
}

// ── CHAPTERS ─────────────────────────────────────────────────────────────
async function genChapters(){
  if(chaptersDone) return;
  const btn=document.getElementById('chapters-gen-btn');
  btn.classList.add('loading'); btn.disabled=true;
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/text_chapters`,{method:'POST'});
    const data=await res.json();
    if(data.ok&&data.chapters?.length){
      chaptersDone=true; btn.style.display='none';
      document.getElementById('chapters-output').innerHTML=data.chapters.map((c,i)=>`
        <div class="chapter-card" onclick="jumpToChapter(${JSON.stringify(c.start_snippet||'')})">
          <div class="chapter-num">Chapter ${i+1}</div>
          <div class="chapter-title">${esc(c.title)}</div>
          <div class="chapter-summary">${esc(c.summary)}</div>
        </div>`).join('');
    }else toast(data.error||'Could not generate chapters.');
  }catch(e){ toast('Network error'); }
  btn.classList.remove('loading'); btn.disabled=false;
}

function jumpToChapter(snippet){
  if(!snippet) return;
  // Switch to OCR view and find text
  switchView('ocr');
  setTimeout(()=>{
    const ocrView = document.getElementById('ocr-view');
    const walker = document.createTreeWalker(ocrView, NodeFilter.SHOW_TEXT);
    let node;
    while(node=walker.nextNode()){
      const idx=node.textContent.indexOf(snippet.slice(0,20));
      if(idx>=0){
        const range=document.createRange();
        range.setStart(node,idx);
        const el=range.startContainer.parentElement;
        el?.scrollIntoView({behavior:'smooth', block:'center'});
        return;
      }
    }
  },300);
}

// ── EXAM ──────────────────────────────────────────────────────────────────
function openExamModal(){
  const m=document.getElementById('exam-modal'); m.classList.add('open');
  gsap.fromTo(m,{opacity:0},{opacity:1,duration:.2,ease:'power2.out'});
  gsap.fromTo(m.querySelector('.modal'),{opacity:0,scale:.92,y:14},{opacity:1,scale:1,y:0,duration:.3,ease:'pop'});
}
function closeExamModal(){
  const m=document.getElementById('exam-modal');
  gsap.to(m.querySelector('.modal'),{opacity:0,scale:.93,y:8,duration:.18,ease:'power2.in'});
  gsap.to(m,{opacity:0,duration:.24,onComplete:()=>m.classList.remove('open')});
}
async function startExam(){
  const nq=parseInt(document.getElementById('exam-nq').value||20);
  const diff=document.getElementById('exam-diff').value||'mixed';
  const tlim=parseInt(document.getElementById('exam-time').value||30);
  const btn=document.getElementById('exam-start-btn');
  btn.textContent='Generating…'; btn.disabled=true;
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/exam`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({num_questions:nq,difficulty:diff,time_limit:tlim})});
    const data=await res.json();
    if(!data.ok){ toast(data.error||'Failed'); btn.textContent='Start Exam'; btn.disabled=false; return; }
    let qs=null;
    if(data.questions) qs=data.questions;
    else if(data.result){ try{qs=JSON.parse(data.result);}catch{} }
    if(!qs?.length){ toast('Could not parse exam.'); btn.textContent='Start Exam'; btn.disabled=false; return; }
    examData=qs; examIdx=0; examAnswers={}; examDone=false; examSecs=tlim*60;
    closeExamModal(); setTimeout(launchExam,350);
  }catch(e){ toast('Network error'); }
  btn.textContent='Start Exam'; btn.disabled=false;
}
function launchExam(){
  document.querySelector('.exam-body').innerHTML=`<div class="exam-q-num" id="exam-q-num"></div><div class="exam-question" id="exam-question"></div><div class="exam-opts" id="exam-opts"></div>`;
  document.getElementById('exam-screen').classList.add('open');
  updateNavBtns(); renderExamQ(); startExamTimer();
}
function updateNavBtns(){
  const last=examIdx>=examData.length-1;
  document.getElementById('exam-next-btn').style.display=last?'none':'';
  document.getElementById('exam-finish-btn').style.display=last?'':'none';
}
function renderExamQ(){
  const q=examData[examIdx]; if(!q) return;
  document.getElementById('exam-q-num').textContent=`Question ${examIdx+1} of ${examData.length}`;
  document.getElementById('exam-question').textContent=q.question;
  document.getElementById('exam-opts').innerHTML=(q.options||[]).map((opt,j)=>`
    <div class="exam-opt${examAnswers[examIdx]===j?' selected':''}" onclick="selectExamOpt(${j})">
      ${String.fromCharCode(65+j)}. ${esc(opt)}
    </div>`).join('');
  document.getElementById('exam-progress-fill').style.width=(examIdx/examData.length*100).toFixed(1)+'%';
  updateNavBtns();
  gsap.fromTo('#exam-question',{opacity:0,y:8},{opacity:1,y:0,duration:.28,ease:'smooth'});
  gsap.fromTo('.exam-opt',{opacity:0,x:-6},{opacity:1,x:0,duration:.24,stagger:.04,ease:'power2.out'});
}
function selectExamOpt(oi){ examAnswers[examIdx]=oi; document.querySelectorAll('.exam-opt').forEach((el,j)=>el.classList.toggle('selected',j===oi)); }
function examNext(){ if(examDone||examIdx>=examData.length-1)return; examIdx++; gsap.to('#exam-question,.exam-opt',{opacity:0,x:-14,duration:.16,ease:'power2.in',onComplete:renderExamQ}); }
function examPrev(){ if(examIdx<=0)return; examIdx--; gsap.to('#exam-question,.exam-opt',{opacity:0,x:14,duration:.16,ease:'power2.in',onComplete:renderExamQ}); }
function finishExam(){
  if(examDone)return; examDone=true; clearInterval(examTimer);
  let correct=0;
  examData.forEach((q,i)=>{ if(examAnswers[i]!==undefined&&examAnswers[i]===resolveCorrectIdx(q))correct++; });
  const pct=Math.round(correct/examData.length*100);
  document.getElementById('exam-progress-fill').style.width='100%';
  document.querySelector('.exam-body').innerHTML=`
    <div class="results-wrap">
      <div class="results-score">${pct}%</div>
      <div class="results-label">${correct} / ${examData.length} correct</div>
      <div class="results-detail">${pct>=80?'🎉 Excellent!':pct>=60?'👍 Good effort!':'📚 Keep studying!'}</div>
      <button class="exam-nav-btn" onclick="closeExamScreen()" style="margin-top:24px">Close</button>
    </div>`;
  document.getElementById('exam-next-btn').style.display='none';
  document.getElementById('exam-finish-btn').style.display='none';
  const pb=document.querySelector('.exam-nav .exam-nav-btn.secondary'); if(pb)pb.style.display='none';
}
function closeExamScreen(){
  clearInterval(examTimer); examDone=false;
  const sc=document.getElementById('exam-screen');
  gsap.to(sc,{opacity:0,duration:.24,ease:'power2.in',onComplete:()=>{
    sc.classList.remove('open'); sc.style.opacity='';
    document.getElementById('exam-next-btn').style.display='';
    document.getElementById('exam-finish-btn').style.display='none';
    const pb=document.querySelector('.exam-nav .exam-nav-btn.secondary'); if(pb)pb.style.display='';
  }});
}
function startExamTimer(){
  clearInterval(examTimer);
  const el=document.getElementById('exam-timer-display');
  function tick(){
    if(examSecs<=0){ clearInterval(examTimer); finishExam(); return; }
    examSecs--;
    const m=Math.floor(examSecs/60),s=examSecs%60;
    el.textContent=`${m}:${String(s).padStart(2,'0')}`;
    document.getElementById('exam-timer').classList.toggle('warning',examSecs<=60);
  }
  tick(); examTimer=setInterval(tick,1000);
}

// ── EXPLAIN OVERLAY ───────────────────────────────────────────────────────
function closeExplain(){ document.getElementById('explain-overlay').style.transform='translateY(100%)'; }

// ── LISTEN ────────────────────────────────────────────────────────────────
let _ttsActive=false;
function toggleListen(){
  if(!('speechSynthesis' in window)){ toast('Your browser does not support text-to-speech'); return; }
  const btn=document.getElementById('listen-btn');
  const icon=document.getElementById('listen-icon');
  const label=document.getElementById('listen-label');
  if(_ttsActive){ window.speechSynthesis.cancel(); _ttsActive=false; btn.classList.remove('playing'); icon.dataset.lucide='play-circle'; label.textContent='Listen'; lucide.createIcons(); return; }
  // Use OCR text
  if(currentView==='pdf') switchView('ocr');
  const text=document.getElementById('ocr-view')?.innerText||'';
  if(!text.trim()){ toast('No text to read'); return; }
  const utt=new SpeechSynthesisUtterance(text);
  utt.rate=0.95; utt.pitch=1; utt.lang='en-US';
  utt.onstart=()=>{ _ttsActive=true; btn.classList.add('playing'); icon.dataset.lucide='pause-circle'; label.textContent='Pause'; lucide.createIcons(); };
  utt.onend=utt.onerror=()=>{ _ttsActive=false; btn.classList.remove('playing'); icon.dataset.lucide='play-circle'; label.textContent='Listen'; lucide.createIcons(); };
  window.speechSynthesis.speak(utt);
}
window.addEventListener('beforeunload',()=>window.speechSynthesis?.cancel());

// ── FIGURES ───────────────────────────────────────────────────────────────
let _figuresLoaded=false;
async function checkFigures(){
  try{
    const r=await fetch(`/api/session/${SESSION_ID}/ocr_figures`);
    const d=await r.json();
    if(d.figures&&d.figures.length>0){
      const btn=document.getElementById('figures-tool-btn'); if(btn) btn.style.display='';
    }
  }catch(e){}
}
async function loadFigures(){
  if(_figuresLoaded) return;
  const grid=document.getElementById('figures-grid');
  const loading=document.getElementById('figures-loading');
  const empty=document.getElementById('figures-empty');
  try{
    const r=await fetch(`/api/session/${SESSION_ID}/ocr_figures`);
    const d=await r.json();
    if(loading) loading.style.display='none';
    const figs=d.figures||[];
    if(!figs.length){ if(empty)empty.style.display='block'; return; }
    _figuresLoaded=true;
    grid.innerHTML=figs.map((fig,i)=>`
      <div class="figure-card">
        <img class="figure-img" src="data:${fig.mime};base64,${fig.b64}" alt="Figure ${i+1} (Page ${fig.page})" loading="lazy"
             onclick="openLightbox('data:${fig.mime};base64,${fig.b64}','Figure ${i+1}')"/>
        <div class="figure-footer">
          <span class="figure-page-lbl"><i data-lucide="file-text" style="width:10px;height:10px;margin-right:3px"></i> Page ${fig.page}</span>
          <button class="figure-dl-btn" onclick="downloadFigure('data:${fig.mime};base64,${fig.b64}','figure_p${fig.page}_${i+1}')">
            <i data-lucide="download"></i> Save
          </button>
        </div>
      </div>`).join('');
    lucide.createIcons();
  }catch(e){
    if(loading) loading.style.display='none';
    if(empty) empty.style.display='block';
  }
}
function openLightbox(src,alt){
  const lb=document.createElement('div');
  lb.className='fig-lightbox';
  lb.innerHTML=`<img src="${src}" alt="${esc(alt)}"/>`;
  lb.onclick=()=>lb.remove();
  document.addEventListener('keydown',function esc(e){ if(e.key==='Escape'){lb.remove();document.removeEventListener('keydown',esc);} });
  document.body.appendChild(lb);
  gsap.fromTo(lb,{opacity:0},{opacity:1,duration:.2,ease:'power2.out'});
}
function downloadFigure(dataUrl,name){
  const a=document.createElement('a'); a.href=dataUrl; a.download=name+'.jpg'; a.click();
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function fmt(text){
  const lines=esc(text).split('\n'); let html='',ul=false,ol=false;
  for(const line of lines){
    if(/^###\s/.test(line)){cl();html+=`<h4 style="font-size:13px;font-weight:700;margin:10px 0 3px">${line.slice(4)}</h4>`;}
    else if(/^##\s/.test(line)){cl();html+=`<h3 style="font-size:14px;font-weight:700;margin:12px 0 4px">${line.slice(3)}</h3>`;}
    else if(/^#\s/.test(line)){cl();html+=`<h2 style="font-size:16px;font-weight:700;margin:14px 0 5px">${line.slice(2)}</h2>`;}
    else if(/^[-*]\s/.test(line)){if(!ul){html+='<ul style="margin:6px 0;padding-left:18px">';ul=true;}html+=`<li style="margin:3px 0">${il(line.slice(2))}</li>`;}
    else if(/^\d+\.\s/.test(line)){if(!ol){html+='<ol style="margin:6px 0;padding-left:18px">';ol=true;}html+=`<li style="margin:3px 0">${il(line.replace(/^\d+\.\s/,''))}</li>`;}
    else if(line.trim()==='---'){cl();html+='<hr style="border:none;border-top:1px solid var(--g5);margin:10px 0">';}
    else{cl();if(line.trim())html+=`<p style="margin:4px 0">${il(line)}</p>`;}
  }
  cl(); return html;
  function cl(){ if(ul){html+='</ul>';ul=false;} if(ol){html+='</ol>';ol=false;} }
  function il(s){ return s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code style="font-family:\'DM Mono\',monospace;font-size:.88em;background:var(--g6);padding:1px 5px;border-radius:4px">$1</code>'); }
}

function resolveCorrectIdx(q){
  const ans=(q.answer||q.correct_answer||'').toString().trim();
  const opts=q.options||[];
  if(!ans) return -1;
  if(/^[A-Da-d]\.?$/.test(ans)) return ans.toUpperCase().charCodeAt(0)-65;
  const lm=ans.match(/^([A-Da-d])[.)]/); if(lm) return lm[1].toUpperCase().charCodeAt(0)-65;
  if(/^[0-3]$/.test(ans)) return parseInt(ans);
  const ei=opts.findIndex(o=>o===ans); if(ei!==-1) return ei;
  const ci=opts.findIndex(o=>o.toLowerCase()===ans.toLowerCase()); if(ci!==-1) return ci;
  return opts.findIndex(o=>o.toLowerCase().includes(ans.toLowerCase())||ans.toLowerCase().includes(o.toLowerCase()));
}

let _toastT;
function toast(msg){ const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('on'); clearTimeout(_toastT); _toastT=setTimeout(()=>el.classList.remove('on'),3000); }

// Close toolbar when clicking elsewhere
document.addEventListener('click',e=>{
  const tb=document.getElementById('sel-toolbar');
  const pdfC=document.getElementById('pdf-container');
  const ocrV=document.getElementById('ocr-view');
  if(tb&&!tb.contains(e.target)&&!pdfC?.contains(e.target)&&!ocrV?.contains(e.target)) hideSelToolbar();
});
document.addEventListener('selectionchange',()=>{
  const sel=window.getSelection();
  if(!sel||sel.isCollapsed||!sel.toString().trim()) hideSelToolbar();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ closeExplain(); closeExamScreen(); closeExamModal(); hideSelToolbar(); }
});