'use strict';
CustomEase.create("smooth","M0,0 C0.16,0 0.17,0.96 0.48,0.98 0.7,1 0.84,1 1,1");
CustomEase.create("pop","M0,0 C0.12,0 0.16,1.12 0.5,1.04 0.7,1 0.84,1 1,1");

// ── State ──────────────────────────────────────────────────────────────────
let annotations  = [];
let quizData     = [];
let quizDiff     = 'easy';
let quizNq       = 5;
let summaryDone  = false;
let chaptersDone = false;
let annOpen      = false;
let firstHighlight = true;

// open tabs: [{id, label}] — 'learn' is always present, not in this array
let openTabs = [];
let activeTab = 'learn';

// exam
let examData=[],examIdx=0,examAnswers={},examTimer=null,examSecs=0,examDone=false;

// ── Hard fallback ──────────────────────────────────────────────────────────
setTimeout(()=>{
  const ld=document.getElementById('loader');
  const ly=document.getElementById('layout');
  if(ld)ld.style.display='none';
  if(ly)ly.style.opacity='1';
},3000);

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded',()=>{
  lucide.createIcons();
  reformatText();

  const body=document.getElementById('reader-body');
  const meta=document.getElementById('reader-meta');
  if(body&&meta){
    const words=body.textContent.trim().split(/\s+/).filter(Boolean).length;
    meta.textContent=`${words.toLocaleString()} words · ${Math.ceil(words/200)} min read`;
  }

  // Entrance
  const tl=gsap.timeline({defaults:{ease:'smooth'}});
  tl
    .to('#loader',{opacity:0,duration:.3,onComplete:()=>{document.getElementById('loader').style.display='none'}})
    .set('#layout',{opacity:1})
    .fromTo('.topbar',{opacity:0,y:-8},{opacity:1,y:0,duration:.35})
    .fromTo('.panel-left',{opacity:0,x:-18},{opacity:1,x:0,duration:.45,ease:'pop'},'-=.2')
    .fromTo('.panel-right',{opacity:0,x:18},{opacity:1,x:0,duration:.45,ease:'pop'},'-=.4')
    .fromTo('.tool-btn',{opacity:0,y:14,scale:.97},{opacity:1,y:0,scale:1,duration:.3,stagger:.06,ease:'pop'},'-=.2');

  updateSlider();
  attachSelectionListener();
  loadAnnotations();

  // Lucide observer — debounced, disconnect guard
  let _ldeb;
  const obs=new MutationObserver(mutations=>{
    const hasNew=mutations.some(m=>Array.from(m.addedNodes).some(n=>n.dataset?.lucide||n.querySelector?.('[data-lucide]')));
    if(!hasNew)return;
    obs.disconnect();
    clearTimeout(_ldeb);
    _ldeb=setTimeout(()=>{lucide.createIcons();obs.observe(document.body,{childList:true,subtree:true});},80);
  });
  obs.observe(document.body,{childList:true,subtree:true});
});

// ── Text reformatter ───────────────────────────────────────────────────────
function reformatText(){
  const el=document.getElementById('reader-body');
  if(!el)return;

  // Step 1: grab raw text and run the cleanup pipeline
  let raw=el.textContent||el.innerText;
  if(!raw.trim()){el.innerHTML='<p style="color:var(--g4)">No content available.</p>';return;}

  // Step 2: normalize line endings, collapse tabs → 2 spaces,
  //         collapse runs of spaces (not newlines), collapse 3+ blank lines → 2
  raw=raw
    .replace(/\r\n/g,'\n')
    .replace(/\t/g,'  ')
    .replace(/[ ]{2,}/g,' ')
    .replace(/\n{3,}/g,'\n\n')
    .replace(/ *\n */g,'\n')
    .trim();

  // Step 3: split on double-newlines to get logical blocks (paragraphs / sections)
  const blocks=raw.split(/\n\n+/);
  let html='';

  for(const block of blocks){
    const trimmed=block.trim();
    if(!trimmed)continue;
    const lines=trimmed.split('\n');
    const first=lines[0].trim();

    // ── Fenced code block
    if(/^```/.test(first)||lines.every(l=>/^( {4}|\t)/.test(l))){
      const code=lines.map(l=>l.replace(/^```\w*/,'').replace(/```$/,'').replace(/^ {4}/,'')).join('\n').trim();
      html+=`<pre><code>${esc(code)}</code></pre>`;

    // ── Email-style blockquote
    } else if(/^>/.test(first)){
      html+=`<blockquote>${lines.map(l=>inlineFmt(l.replace(/^>\s*/,''))).join('<br>')}</blockquote>`;

    // ── Markdown headings
    } else if(/^#{1,3}\s/.test(first)){
      const lvl=first.match(/^(#+)/)[1].length;
      const tag=lvl===1?'h2':lvl===2?'h3':'h4';
      html+=`<${tag}>${inlineFmt(first.replace(/^#+\s/,''))}</${tag}>`;
      if(lines.length>1)html+=`<p>${inlineFmt(lines.slice(1).join(' '))}</p>`;

    // ── ALL-CAPS short line → heading (e.g. "INTRODUCTION")
    } else if(lines.length===1&&first===first.toUpperCase()&&first.replace(/\s/g,'').length>3&&first.length<70&&!/[.?!,;]/.test(first)){
      html+=`<h2>${esc(first)}</h2>`;

    // ── Bullet list (-, *, •)
    } else if(/^[-*•]\s/.test(first)){
      const items=lines.filter(l=>/^[-*•]\s/.test(l.trim()));
      const rest =lines.filter(l=>!/^[-*•]\s/.test(l.trim()));
      html+=`<ul>${items.map(l=>`<li>${inlineFmt(l.trim().replace(/^[-*•]\s/,''))}</li>`).join('')}</ul>`;
      if(rest.length)html+=`<p>${inlineFmt(rest.join(' '))}</p>`;

    // ── Numbered list
    } else if(/^\d+[.)]\s/.test(first)){
      const items=lines.filter(l=>/^\d+[.)]\s/.test(l.trim()));
      const rest =lines.filter(l=>!/^\d+[.)]\s/.test(l.trim()));
      html+=`<ol>${items.map(l=>`<li>${inlineFmt(l.trim().replace(/^\d+[.)]\s/,''))}</li>`).join('')}</ol>`;
      if(rest.length)html+=`<p>${inlineFmt(rest.join(' '))}</p>`;

    // ── key: value pair lines
    } else if(lines.every(l=>/^[\w\s\-\/]+:\s+.+/.test(l.trim()))){
      html+=lines.map(l=>{
        const colon=l.indexOf(':');
        const k=esc(l.slice(0,colon).trim());
        const v=inlineFmt(l.slice(colon+1).trim());
        return `<p><strong>${k}:</strong> ${v}</p>`;
      }).join('');

    // ── URL-only line → make clickable
    } else if(lines.length===1&&/^https?:\/\/\S+$/.test(first)){
      html+=`<p><a href="${esc(first)}" target="_blank" rel="noopener" style="color:var(--c-summary)">${esc(first)}</a></p>`;

    // ── Normal paragraph — join lines, apply inline formatting
    } else {
      // Auto-capitalize first letter of sentences within the paragraph
      const joined=lines.join(' ').replace(/(?<=[.!?]\s)([a-z])/g,c=>c.toUpperCase());
      html+=`<p>${inlineFmt(joined)}</p>`;
    }
  }

  el.innerHTML=html||'<p style="color:var(--g4)">No content.</p>';
}

function inlineFmt(s){
  // Escape first, then apply inline markdown: **bold**, *italic*, `code`, URLs
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`(.+?)`/g,'<code>$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:var(--c-summary)">$1</a>');
}

// ── TAB SYSTEM ────────────────────────────────────────────────────────────
function switchTab(id){
  activeTab=id;
  // Deactivate all static tabs
  document.querySelectorAll('.rp-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.rp-tab-dyn').forEach(t=>t.classList.toggle('active',t.dataset.tab===id));
  const staticTab=document.getElementById('tab-'+id);
  if(staticTab)staticTab.classList.add('active');
  // Show correct panel
  document.querySelectorAll('.rp-panel').forEach(p=>p.classList.remove('active'));
  const panel=document.getElementById('panel-'+id);
  if(panel){panel.style.display='block';panel.classList.add('active');}
  updateSlider();
  // Close annotations drawer when switching tabs
  if(annOpen)closeAnnotations();
}

function openToolTab(id,label,icon,color){
  // If tab already exists just switch to it
  if(openTabs.find(t=>t.id===id)){switchTab(id);return;}
  openTabs.push({id,label,icon,color});
  // Show the pre-built panel
  const panel=document.getElementById('panel-'+id);
  if(panel)panel.style.display='block';
  // Create tab button
  const btn=document.createElement('button');
  btn.className='rp-tab-dyn';
  btn.id='tab-dyn-'+id;
  btn.dataset.tab=id;
  btn.innerHTML=`<svg width="12" height="12" style="color:${color};flex-shrink:0"><use href="#icon-${icon}"/></svg>
    <span>${label}</span>
    <button class="tab-close" onclick="closeTab(event,'${id}')" title="Close">
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  // Use the proper lucide icon via inline SVG approach
  btn.querySelector('svg use')?.remove();
  const iconEl=document.createElementNS('http://www.w3.org/2000/svg','svg');
  iconEl.setAttribute('width','12');iconEl.setAttribute('height','12');
  iconEl.style.color=color;iconEl.style.flexShrink='0';
  iconEl.innerHTML=`<use href="#lucide-${icon}"/>`;
  // Simpler: just use an i tag that lucide can pick up
  btn.querySelector('svg')?.remove();
  const iTag=document.createElement('i');
  iTag.dataset.lucide=icon;
  iTag.style.width='12px';iTag.style.height='12px';iTag.style.color=color;
  btn.insertBefore(iTag,btn.firstChild);
  btn.onclick=()=>switchTab(id);
  document.getElementById('dyn-tabs').appendChild(btn);
  lucide.createIcons();
  switchTab(id);
  // Animate new tab
  gsap.fromTo(btn,{opacity:0,x:10},{opacity:1,x:0,duration:.22,ease:'power2.out'});
}

function closeTab(e,id){
  e.stopPropagation();
  openTabs=openTabs.filter(t=>t.id!==id);
  const btn=document.getElementById('tab-dyn-'+id);
  const panel=document.getElementById('panel-'+id);
  gsap.to(btn,{opacity:0,x:-8,duration:.18,ease:'power2.in',onComplete:()=>{btn?.remove();updateSlider();}});
  if(panel)panel.style.display='none';
  if(activeTab===id)switchTab('learn');
}

function updateSlider(){
  const slider=document.getElementById('rp-slider');
  const nav=document.getElementById('rp-nav');
  if(!slider||!nav)return;
  // Find active tab element
  const activeEl=document.querySelector('.rp-tab.active, .rp-tab-dyn.active');
  if(!activeEl){slider.style.width='0';return;}
  const nr=nav.getBoundingClientRect();
  const ar=activeEl.getBoundingClientRect();
  slider.style.left=(ar.left-nr.left+nav.scrollLeft)+'px';
  slider.style.width=ar.width+'px';
}

// ── ANNOTATIONS ───────────────────────────────────────────────────────────
function toggleAnnotations(){
  annOpen=!annOpen;
  const drawer=document.getElementById('ann-drawer');
  const btn=document.getElementById('ann-nav-btn');
  if(annOpen){
    drawer.classList.add('open');
    btn.style.color='var(--black)';
    gsap.fromTo(drawer,{x:40,opacity:.6},{x:0,opacity:1,duration:.26,ease:'pop'});
  } else {
    closeAnnotations();
  }
}
function closeAnnotations(){
  annOpen=false;
  const drawer=document.getElementById('ann-drawer');
  const btn=document.getElementById('ann-nav-btn');
  btn.style.color='';
  // Use GSAP to animate out (GSAP inline styles override CSS class transitions)
  gsap.to(drawer,{x:40,opacity:0,duration:.22,ease:'power2.in',onComplete:()=>{
    drawer.classList.remove('open');
    gsap.set(drawer,{clearProps:'all'});
  }});
}
function openAnnotationsAuto(){
  if(!annOpen)toggleAnnotations();
}

function loadAnnotations(){
  try{
    const saved=sessionStorage.getItem('ann_'+SESSION_ID);
    if(saved)annotations=JSON.parse(saved);
  }catch(e){}
  renderAnnotations();
}
function saveAnnotationsState(){
  sessionStorage.setItem('ann_'+SESSION_ID,JSON.stringify(annotations));
}
function addAnnotation(text,color,markId){
  annotations.push({id:markId,text,color});
  saveAnnotationsState();
  renderAnnotations();
  // Open on first highlight only
  if(firstHighlight){firstHighlight=false;openAnnotationsAuto();}
}
function removeAnnotation(id){
  annotations=annotations.filter(a=>a.id!==id);
  saveAnnotationsState();
  const mark=document.querySelector(`mark[data-ann-id="${id}"]`);
  if(mark){
    const parent=mark.parentNode;
    while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);
    parent.removeChild(mark);
  }
  renderAnnotations();
}

function scrollToMark(id){
  const mark=document.querySelector(`mark[data-ann-id="${id}"]`);
  if(!mark){toast('Highlight not found in text');return;}
  const body=document.getElementById('reader-body');
  const markRect=mark.getBoundingClientRect();
  const bodyRect=body.getBoundingClientRect();
  body.scrollTo({top:body.scrollTop+(markRect.top-bodyRect.top)-(body.clientHeight*0.3),behavior:'smooth'});
  mark.classList.add('ann-pulse');
  setTimeout(()=>mark.classList.remove('ann-pulse'),1800);
}
function renderAnnotations(){
  const list=document.getElementById('ann-list');
  const empty=document.getElementById('ann-empty');
  const badge=document.getElementById('ann-badge');
  const n=annotations.length;
  badge.style.display=n>0?'block':'none';
  if(n===0){empty.style.display='flex';list.innerHTML='';return;}
  empty.style.display='none';
  list.innerHTML=`<span class="ann-count-lbl">${n} annotation${n===1?'':'s'}</span>`+
    annotations.map(a=>`
      <div class="ann-card" data-color="${a.color}" onclick="scrollToMark(${a.id})" title="Jump to highlight" style="cursor:pointer">
        <div class="ann-text">${esc(a.text)}</div>
        <div class="ann-footer">
          <span class="ann-color-badge">${a.color}</span>
          <button class="ann-del" onmousedown="event.preventDefault()" onclick="event.stopPropagation();removeAnnotation(${a.id})" title="Remove highlight">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
    `).join('');
}

// ── SELECTION TOOLBAR ─────────────────────────────────────────────────────
let _savedRange=null;
let _savedText='';

function attachSelectionListener(){
  const reader=document.getElementById('reader-body');
  document.addEventListener('mouseup',()=>{
    const sel=window.getSelection();
    if(!sel||sel.isCollapsed||!sel.toString().trim()){return;}
    if(!reader.contains(sel.anchorNode)){hideSelToolbar();return;}
    _savedRange=sel.getRangeAt(0).cloneRange();
    _savedText=sel.toString().trim();
    positionSelToolbar(sel);
  });
  document.addEventListener('selectionchange',()=>{
    const sel=window.getSelection();
    if(!sel||sel.isCollapsed||!sel.toString().trim())hideSelToolbar();
  });
}
function positionSelToolbar(sel){
  const toolbar=document.getElementById('sel-toolbar');
  const rect=sel.getRangeAt(0).getBoundingClientRect();
  const tw=toolbar.offsetWidth||220;
  let left=rect.left+rect.width/2-tw/2;
  left=Math.max(8,Math.min(left,window.innerWidth-tw-8));
  toolbar.style.top=(rect.top+window.scrollY-50)+'px';
  toolbar.style.left=left+'px';
  toolbar.classList.add('visible');
}
function hideSelToolbar(){document.getElementById('sel-toolbar').classList.remove('visible');}
function getSelectedText(){return window.getSelection()?.toString().trim()||'';}

async function selExplain(){
  const text=_savedText||getSelectedText();
  if(!text)return;
  hideSelToolbar();
  const overlay=document.getElementById('explain-overlay');
  const out=document.getElementById('explain-text');
  out.textContent='Explaining…';
  overlay.style.transform='translateY(0)';
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/text_explain`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text})
    });
    const data=await res.json();
    out.innerHTML=fmt(data.result||data.error||'Could not explain.');
  }catch(e){out.textContent='Network error.';}
}
function closeExplain(){document.getElementById('explain-overlay').style.transform='translateY(100%)';}

function selChat(){
  const text=_savedText||getSelectedText();
  if(!text)return;
  hideSelToolbar();
  toast('Chat from selection coming soon');
}

function selAddToNotes(){
  const text=_savedText||getSelectedText();
  if(!text)return;
  hideSelToolbar();
  const ta=document.getElementById('notes-ta');
  if(ta)ta.value=ta.value?ta.value+'\n\n> '+text:'> '+text;
  openToolTab('notes','Notes','notebook-pen','var(--c-notes)');
  toast('Added to notes');
}

function selHighlight(color='yellow'){
  // Use _savedText because mousedown on color dot collapses browser selection before this fires
  const text=_savedText||getSelectedText();
  if(!text||!_savedRange)return;
  hideSelToolbar();
  const markId=Date.now();
  try{
    const mark=document.createElement('mark');
    mark.dataset.color=color;
    mark.dataset.annId=markId;
    mark.textContent=text;
    _savedRange.deleteContents();
    _savedRange.insertNode(mark);
    window.getSelection().removeAllRanges();
  }catch(e){toast('Could not highlight here');}
  addAnnotation(text,color,markId);
  _savedText='';
}

// ── SUMMARY ───────────────────────────────────────────────────────────────
async function genSummary(){
  if(summaryDone)return;
  const btn=document.getElementById('summary-gen-btn');
  btn.classList.add('loading');btn.disabled=true;
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/summarize`,{method:'POST'});
    const data=await res.json();
    const text=data.summary||data.result||data.error||'No summary.';
    summaryDone=true;
    btn.style.display='none';
    document.getElementById('summary-output').innerHTML=`<div class="output-card">${fmt(text)}</div>`;
  }catch(e){toast('Network error');}
  btn.classList.remove('loading');btn.disabled=false;
}

// ── QUIZ ──────────────────────────────────────────────────────────────────
function setDiff(btn){document.querySelectorAll('[data-diff]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');quizDiff=btn.dataset.diff;}
function setNq(btn){document.querySelectorAll('[data-nq]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');quizNq=parseInt(btn.dataset.nq);}
async function genQuiz(){
  const btn=document.getElementById('quiz-gen-btn');
  btn.classList.add('loading');btn.disabled=true;
  quizData=[];document.getElementById('quiz-output').innerHTML='';
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/quiz`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({difficulty:quizDiff,num_questions:quizNq})
    });
    const data=await res.json();
    let qs=null;
    if(data.questions)qs=data.questions;
    else if(data.result){try{qs=JSON.parse(data.result);}catch{}}
    if(qs&&Array.isArray(qs)){quizData=qs;renderQuiz(qs);}
    else toast('Could not parse quiz.');
  }catch(e){toast('Network error');}
  btn.classList.remove('loading');btn.disabled=false;
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
  const q=quizData[qi];if(!q)return;
  const ci=resolveCorrectIdx(q);
  document.querySelectorAll(`[data-qi="${qi}"]`).forEach((el,j)=>{
    el.classList.remove('correct','wrong');
    if(j===ci)el.classList.add('correct');
    else if(j===oi)el.classList.add('wrong');
  });
}

// ── NOTES ─────────────────────────────────────────────────────────────────
function applyNote(type){
  const ta=document.getElementById('notes-ta');if(!ta)return;
  const s=ta.selectionStart,e=ta.selectionEnd,sel=ta.value.slice(s,e);
  const w={bold:`**${sel}**`,italic:`_${sel}_`,h2:`## ${sel}`,bullet:`- ${sel}`};
  ta.value=ta.value.slice(0,s)+(w[type]||sel)+ta.value.slice(e);
  ta.focus();
}
async function saveNotes(){
  const text=document.getElementById('notes-ta')?.value||'';
  try{
    await fetch(`/api/session/${SESSION_ID}/notes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:text})});
    toast('Notes saved');
  }catch(e){toast('Save failed');}
}

// ── CHAPTERS ─────────────────────────────────────────────────────────────
async function genChapters(){
  if(chaptersDone)return;
  const btn=document.getElementById('chapters-gen-btn');
  btn.classList.add('loading');btn.disabled=true;
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/text_chapters`,{method:'POST'});
    const data=await res.json();
    if(data.ok&&data.chapters?.length){
      chaptersDone=true;btn.style.display='none';
      document.getElementById('chapters-output').innerHTML=data.chapters.map((c,i)=>`
        <div class="chapter-card" onclick="scrollToSnippet(${JSON.stringify(c.start_snippet||'')})">
          <div class="chapter-num">Chapter ${i+1}</div>
          <div class="chapter-title">${esc(c.title)}</div>
          <div class="chapter-summary">${esc(c.summary)}</div>
        </div>`).join('');
    }else toast(data.error||'Could not generate chapters.');
  }catch(e){toast('Network error');}
  btn.classList.remove('loading');btn.disabled=false;
}
function scrollToSnippet(snippet){
  if(!snippet)return;
  const body=document.getElementById('reader-body');
  const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
  let node;
  while(node=walker.nextNode()){
    const idx=node.textContent.indexOf(snippet.slice(0,20));
    if(idx>=0){
      const range=document.createRange();
      range.setStart(node,idx);
      const rect=range.getBoundingClientRect();
      const bodyRect=body.getBoundingClientRect();
      body.scrollTo({top:body.scrollTop+(rect.top-bodyRect.top)-60,behavior:'smooth'});
      return;
    }
  }
}

// ── EXAM ──────────────────────────────────────────────────────────────────
function openExamModal(){
  const m=document.getElementById('exam-modal');m.classList.add('open');
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
  btn.textContent='Generating…';btn.disabled=true;
  try{
    const res=await fetch(`/api/session/${SESSION_ID}/exam`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({num_questions:nq,difficulty:diff,time_limit:tlim})
    });
    const data=await res.json();
    if(!data.ok){toast(data.error||'Failed');btn.textContent='Start Exam';btn.disabled=false;return;}
    let qs=null;
    if(data.questions)qs=data.questions;
    else if(data.result){try{qs=JSON.parse(data.result);}catch{}}
    if(!qs?.length){toast('Could not parse exam.');btn.textContent='Start Exam';btn.disabled=false;return;}
    examData=qs;examIdx=0;examAnswers={};examDone=false;examSecs=tlim*60;
    closeExamModal();setTimeout(launchExam,350);
  }catch(e){toast('Network error');}
  btn.textContent='Start Exam';btn.disabled=false;
}
function launchExam(){
  document.querySelector('.exam-body').innerHTML=`
    <div class="exam-q-num" id="exam-q-num"></div>
    <div class="exam-question" id="exam-question"></div>
    <div class="exam-opts" id="exam-opts"></div>`;
  document.getElementById('exam-screen').classList.add('open');
  updateNavBtns();renderExamQ();startExamTimer();
}
function updateNavBtns(){
  const last=examIdx>=examData.length-1;
  document.getElementById('exam-next-btn').style.display=last?'none':'';
  document.getElementById('exam-finish-btn').style.display=last?'':'none';
}
function renderExamQ(){
  const q=examData[examIdx];if(!q)return;
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
function selectExamOpt(oi){examAnswers[examIdx]=oi;document.querySelectorAll('.exam-opt').forEach((el,j)=>el.classList.toggle('selected',j===oi));}
function examNext(){if(examDone||examIdx>=examData.length-1)return;examIdx++;gsap.to('#exam-question,.exam-opt',{opacity:0,x:-14,duration:.16,ease:'power2.in',onComplete:renderExamQ});}
function examPrev(){if(examIdx<=0)return;examIdx--;gsap.to('#exam-question,.exam-opt',{opacity:0,x:14,duration:.16,ease:'power2.in',onComplete:renderExamQ});}
function finishExam(){
  if(examDone)return;examDone=true;clearInterval(examTimer);
  let correct=0;
  examData.forEach((q,i)=>{if(examAnswers[i]!==undefined&&examAnswers[i]===resolveCorrectIdx(q))correct++;});
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
  const prevBtn=document.querySelector('.exam-nav .exam-nav-btn.secondary');
  if(prevBtn)prevBtn.style.display='none';
}
function closeExamScreen(){
  clearInterval(examTimer);examDone=false;
  const sc=document.getElementById('exam-screen');
  gsap.to(sc,{opacity:0,duration:.24,ease:'power2.in',onComplete:()=>{
    sc.classList.remove('open');sc.style.opacity='';
    document.getElementById('exam-next-btn').style.display='';
    document.getElementById('exam-finish-btn').style.display='none';
    const pb=document.querySelector('.exam-nav .exam-nav-btn.secondary');
    if(pb)pb.style.display='';
  }});
}
function startExamTimer(){
  clearInterval(examTimer);
  const el=document.getElementById('exam-timer-display');
  function tick(){
    if(examSecs<=0){clearInterval(examTimer);finishExam();return;}
    examSecs--;
    const m=Math.floor(examSecs/60),s=examSecs%60;
    el.textContent=`${m}:${String(s).padStart(2,'0')}`;
    document.getElementById('exam-timer').classList.toggle('warning',examSecs<=60);
  }
  tick();examTimer=setInterval(tick,1000);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmt(text){
  const lines=esc(text).split('\n');let html='',ul=false,ol=false;
  for(const line of lines){
    if(/^###\s/.test(line)){cl();html+=`<h4 style="font-size:13px;font-weight:700;margin:10px 0 3px">${line.slice(4)}</h4>`;}
    else if(/^##\s/.test(line)){cl();html+=`<h3 style="font-size:14px;font-weight:700;margin:12px 0 4px">${line.slice(3)}</h3>`;}
    else if(/^#\s/.test(line)){cl();html+=`<h2 style="font-size:16px;font-weight:700;margin:14px 0 5px">${line.slice(2)}</h2>`;}
    else if(/^[-*]\s/.test(line)){if(!ul){html+='<ul style="margin:6px 0;padding-left:18px">'; ul=true;}html+=`<li style="margin:3px 0">${il(line.slice(2))}</li>`;}
    else if(/^\d+\.\s/.test(line)){if(!ol){html+='<ol style="margin:6px 0;padding-left:18px">'; ol=true;}html+=`<li style="margin:3px 0">${il(line.replace(/^\d+\.\s/,''))}</li>`;}
    else if(line.trim()==='---'){cl();html+='<hr style="border:none;border-top:1px solid var(--g5);margin:10px 0">';}
    else{cl();if(line.trim())html+=`<p style="margin:4px 0">${il(line)}</p>`;}
  }
  cl();return html;
  function cl(){if(ul){html+='</ul>';ul=false;}if(ol){html+='</ol>';ol=false;}}
  function il(s){return s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code style="font-family:\'DM Mono\',monospace;font-size:.88em;background:var(--g6);padding:1px 5px;border-radius:4px">$1</code>');}
}
function resolveCorrectIdx(q){
  const ans=(q.answer||q.correct_answer||'').toString().trim();
  const opts=q.options||[];
  if(!ans)return -1;
  if(/^[A-Da-d]\.?$/.test(ans))return ans.toUpperCase().charCodeAt(0)-65;
  const lm=ans.match(/^([A-Da-d])[.)]/);if(lm)return lm[1].toUpperCase().charCodeAt(0)-65;
  if(/^[0-3]$/.test(ans))return parseInt(ans);
  const ei=opts.findIndex(o=>o===ans);if(ei!==-1)return ei;
  const ci=opts.findIndex(o=>o.toLowerCase()===ans.toLowerCase());if(ci!==-1)return ci;
  return opts.findIndex(o=>o.toLowerCase().includes(ans.toLowerCase())||ans.toLowerCase().includes(o.toLowerCase()));
}
// ── LISTEN (Web Speech API) ───────────────────────────────────────────────
let _ttsActive=false;
function toggleListen(){
  if(!('speechSynthesis' in window)){toast('Your browser does not support text-to-speech');return;}
  const btn=document.getElementById('listen-btn');
  const icon=document.getElementById('listen-icon');
  const label=document.getElementById('listen-label');
  if(_ttsActive){
    window.speechSynthesis.cancel();
    _ttsActive=false;
    btn.classList.remove('playing');
    icon.dataset.lucide='play-circle';
    label.textContent='Listen';
    lucide.createIcons();
    return;
  }
  // Get plain text from reader (strips HTML tags from reformatted content)
  const text=document.getElementById('reader-body')?.innerText||'';
  if(!text.trim()){toast('No text to read');return;}
  const utt=new SpeechSynthesisUtterance(text);
  utt.rate=0.95;
  utt.pitch=1;
  utt.lang='en-US';
  utt.onstart=()=>{
    _ttsActive=true;
    btn.classList.add('playing');
    icon.dataset.lucide='pause-circle';
    label.textContent='Pause';
    lucide.createIcons();
  };
  utt.onend=utt.onerror=()=>{
    _ttsActive=false;
    btn.classList.remove('playing');
    icon.dataset.lucide='play-circle';
    label.textContent='Listen';
    lucide.createIcons();
  };
  window.speechSynthesis.speak(utt);
}

// Stop TTS if user navigates away
window.addEventListener('beforeunload',()=>window.speechSynthesis?.cancel());

let _toastT;
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('on');clearTimeout(_toastT);_toastT=setTimeout(()=>el.classList.remove('on'),3000);}

// Close toolbar on outside click, close explain on ESC
document.addEventListener('click',e=>{
  const tb=document.getElementById('sel-toolbar');
  if(tb&&!tb.contains(e.target)&&!document.getElementById('reader-body')?.contains(e.target))hideSelToolbar();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeExplain();closeExamScreen();closeExamModal();hideSelToolbar();}
});