'use strict';
CustomEase.create("smooth","M0,0 C0.16,0 0.17,0.96 0.48,0.98 0.7,1 0.84,1 1,1");
CustomEase.create("pop","M0,0 C0.12,0 0.16,1.12 0.5,1.04 0.7,1 0.84,1 1,1");

// ── State ─────────────────────────────────────────────────────────────────
let currentThread = null;
let threads       = [];
let chatHistory   = [];
let isLoading     = false;
let quizData      = [], quizIdx = 0, quizAnswers = {};

setTimeout(()=>{
  const ld=document.getElementById('loader'),ly=document.getElementById('layout');
  if(ld)ld.style.display='none';
  if(ly)ly.style.opacity='1';
},3000);

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async ()=>{
  lucide.createIcons();
  const tl=gsap.timeline({defaults:{ease:'smooth'}});
  tl
    .to('#loader',{opacity:0,duration:.3,onComplete:()=>document.getElementById('loader').style.display='none'})
    .set('#layout',{opacity:1})
    .fromTo('.topbar',{opacity:0,y:-8},{opacity:1,y:0,duration:.32})
    .fromTo('.tab-bar',{opacity:0,y:-6},{opacity:1,y:0,duration:.28},'-=.15')
    .fromTo('.chat-area',{opacity:0},{opacity:1,duration:.35},'-=.15');

  await loadThreads();

  let _ld;
  const obs=new MutationObserver(muts=>{
    const hasNew=muts.some(m=>Array.from(m.addedNodes).some(n=>n.dataset?.lucide||n.querySelector?.('[data-lucide]')));
    if(!hasNew)return;
    obs.disconnect();clearTimeout(_ld);
    _ld=setTimeout(()=>{lucide.createIcons();obs.observe(document.body,{childList:true,subtree:true});},80);
  });
  obs.observe(document.body,{childList:true,subtree:true});
});

// ── THREADS / TABS ────────────────────────────────────────────────────────
async function loadThreads(){
  try{
    const data=await fetch(`/api/session/${SESSION_ID}/threads`).then(r=>r.json());
    threads=data.threads||[];
    renderTabs();
    if(threads.length>0) await switchThread(threads[threads.length-1]);
    else await newThread();
  }catch(e){ toast('Could not load chats'); }
}

function renderTabs(){
  const bar=document.getElementById('thread-tabs');
  // NOTE: cannot nest <button> inside <button> — use <div> for tab, <button> only for close
  bar.innerHTML=threads.map(t=>{
    const active=currentThread?.id===t.id;
    return `<div class="thread-tab${active?' active':''}" data-tid="${t.id}" onclick="tabClick('${t.id}')">
      ${active?'<span class="tab-dot"></span>':''}
      <span class="tab-name" title="${esc(t.name)}">${esc(t.name)}</span>
      <button class="tab-close" onclick="event.stopPropagation();deleteThread('${t.id}')" title="Close">&#x2715;</button>
    </div>`;
  }).join('');
}

function tabClick(tid){
  const t=threads.find(x=>x.id===tid);
  if(t) switchThread(t);
}

function updateSlider(){
  const slider=document.getElementById('tab-slider');
  const bar=document.getElementById('tab-bar');
  if(!slider||!bar)return;
  const activeTab=bar.querySelector('.thread-tab.active');
  if(!activeTab){slider.style.width='0';return;}
  const br=bar.getBoundingClientRect(),ar=activeTab.getBoundingClientRect();
  slider.style.left=(ar.left-br.left+bar.scrollLeft)+'px';
  slider.style.width=ar.width+'px';
}

async function switchThread(t){
  currentThread=t;
  chatHistory=[];quizData=[];quizIdx=0;quizAnswers={};
  renderTabs();clearMessages();showEmpty();
  try{
    const data=await fetch(`/api/session/${SESSION_ID}/thread/${t.id}/messages`).then(r=>r.json());
    const msgs=data.messages||[];
    if(!msgs.length)return;
    hideEmpty();
    for(const m of msgs){
      if(m.role==='user') appendUserBubble(m.content,false);
      else if(m.kind==='quiz') appendCompletedQuizNote();
      else appendAiResponse(m.content,false);
      chatHistory.push({role:m.role,content:m.content});
    }
    scrollToBottom();
  }catch(e){ showEmpty(); }
}

async function newThread(){
  try{
    const data=await fetch(`/api/session/${SESSION_ID}/thread/new`,{method:'POST'}).then(r=>r.json());
    const t={id:data.thread_id,name:'New Chat'};
    currentThread=t;chatHistory=[];quizData=[];quizIdx=0;quizAnswers={};
    renderTabs();clearMessages();showEmpty();
  }catch(e){ toast('Could not create chat'); }
}

async function deleteThread(tid){
  try{
    await fetch(`/api/session/${SESSION_ID}/thread/${tid}/delete`,{method:'DELETE'});
    threads=threads.filter(t=>t.id!==tid);
    if(currentThread?.id===tid) await newThread();
    else renderTabs();
    toast('Chat deleted');
  }catch(e){ toast('Delete failed'); }
}

// ── MESSAGES ──────────────────────────────────────────────────────────────
function clearMessages(){
  document.getElementById('chat-messages').innerHTML='';
  appendEmptyHTML();
}
function appendEmptyHTML(){
  document.getElementById('chat-messages').innerHTML=`
    <div class="empty-state" id="empty-state">
      <div class="empty-icon"><i data-lucide="sparkles"></i></div>
      <div class="empty-title">What do you want to learn?</div>
      <div class="empty-sub">Ask anything — I'll explain, quiz you, and help it stick.</div>
      <div class="starter-chips">
        <div class="chip" onclick="sendStarter(this)">Explain recursion simply</div>
        <div class="chip" onclick="sendStarter(this)">Quiz me on photosynthesis</div>
        <div class="chip" onclick="sendStarter(this)">How does the stock market work?</div>
        <div class="chip" onclick="sendStarter(this)">Summarise the French Revolution</div>
      </div>
    </div>`;
}
function showEmpty(){const e=document.getElementById('empty-state');if(e)gsap.to(e,{opacity:1,duration:.35});}
function hideEmpty(){document.getElementById('empty-state')?.remove();}

function wrapRow(cls,inner){
  const row=document.createElement('div');
  row.className=`msg-row ${cls}`;
  row.innerHTML=inner;
  document.getElementById('chat-messages').appendChild(row);
  return row;
}

function appendUserBubble(text,animate=true){
  const row=wrapRow('user',`<div class="bubble-user">${esc(text)}</div>`);
  if(animate)gsap.fromTo(row,{opacity:0,y:10,scale:.97},{opacity:1,y:0,scale:1,duration:.28,ease:'pop'});
  return row;
}

function appendAiResponse(text,animate=true){
  const row=wrapRow('ai',`<div class="bubble-ai">${fmt(text)}</div>`);
  if(animate)gsap.fromTo(row,{opacity:0,y:8},{opacity:1,y:0,duration:.3,ease:'smooth'});
  return row;
}

function appendSystemMsg(text){
  return wrapRow('system',`<div class="bubble-system">${esc(text)}</div>`);
}

function appendThinking(){
  const row=wrapRow('ai',`<div class="thinking"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`);
  row.id='thinking-row';
  scrollToBottom();return row;
}
function removeThinking(){document.getElementById('thinking-row')?.remove();}

function appendCompletedQuizNote(){
  wrapRow('ai',`<div class="bubble-ai" style="color:var(--g4);font-size:12.5px;font-style:italic">Quiz completed — start a new one to practice again.</div>`);
}

function scrollToBottom(){
  const el=document.getElementById('chat-messages');
  el.scrollTo({top:el.scrollHeight,behavior:'smooth'});
}

// ── SEND ──────────────────────────────────────────────────────────────────
async function sendMessage(){
  const inp=document.getElementById('chat-input');
  const text=inp.value.trim();
  if(!text||isLoading||!currentThread)return;
  if(/^quiz me|^take a quiz|^test me|^generate quiz/i.test(text)){
    inp.value='';autoResize(inp);await triggerQuiz(text);return;
  }
  hideEmpty();inp.value='';autoResize(inp);
  isLoading=true;setSend(true);
  appendUserBubble(text);
  chatHistory.push({role:'user',content:text});
  scrollToBottom();appendThinking();
  try{
    const data=await fetch(`/api/session/${SESSION_ID}/thread/${currentThread.id}/chat`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:text,history:chatHistory,thread_name:currentThread.name})
    }).then(r=>r.json());
    removeThinking();
    if(!data.ok) appendSystemMsg('Error: '+(data.error||'Unknown'));
    else{
      appendAiResponse(data.result);
      chatHistory.push({role:'assistant',content:data.result});
      if(data.thread_name&&data.thread_name!==currentThread.name){
        currentThread.name=data.thread_name;
        const ex=threads.find(t=>t.id===currentThread.id);
        if(ex)ex.name=data.thread_name;else threads.push({id:currentThread.id,name:data.thread_name});
        renderTabs();
      }
    }
  }catch(e){removeThinking();appendSystemMsg('Network error.');}
  isLoading=false;setSend(false);scrollToBottom();
  document.getElementById('chat-input').focus();
}

function sendStarter(el){
  const inp=document.getElementById('chat-input');
  inp.value=el.textContent;autoResize(inp);sendMessage();
}
function setSend(disabled){document.getElementById('send-btn').disabled=disabled;}
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,160)+'px';}

// ── QUIZ ──────────────────────────────────────────────────────────────────
async function triggerQuiz(hint=''){
  if(isLoading||!currentThread)return;
  hideEmpty();isLoading=true;setSend(true);
  const topic=hint||SESSION_TOPIC||'the topic';
  appendUserBubble(hint||'Quiz me');
  chatHistory.push({role:'user',content:hint||'Quiz me'});
  appendThinking();
  try{
    const data=await fetch(`/api/session/${SESSION_ID}/thread/${currentThread.id}/quiz`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({topic,num_questions:5,difficulty:'intermediate',thread_name:currentThread.name})
    }).then(r=>r.json());
    removeThinking();
    if(!data.ok){appendSystemMsg('Quiz failed: '+(data.error||''));isLoading=false;setSend(false);return;}
    let qs=null;
    try{qs=JSON.parse(data.result);}catch(e){}
    if(!qs){const m=data.result.match(/\[[\s\S]*\]/);if(m)try{qs=JSON.parse(m[0]);}catch(e){}}
    if(qs&&qs.length){
      quizData=qs;quizIdx=0;quizAnswers={};
      appendQuizCard();
      chatHistory.push({role:'assistant',content:'[Quiz generated]'});
    }else{
      appendAiResponse(data.result);
      chatHistory.push({role:'assistant',content:data.result});
    }
  }catch(e){removeThinking();appendSystemMsg('Network error.');}
  isLoading=false;setSend(false);scrollToBottom();
}

function appendQuizCard(){
  const row=wrapRow('ai','');
  row.id='quiz-card-row';
  row.innerHTML=buildQuizCardHTML(quizIdx);
  gsap.fromTo(row,{opacity:0,y:10},{opacity:1,y:0,duration:.3,ease:'pop'});
  return row;
}

function buildQuizCardHTML(idx){
  const q=quizData[idx];
  if(!q)return'';
  const opts=(q.options||[]).map((opt,oi)=>`
    <div class="quiz-opt" data-qi="${idx}" data-oi="${oi}" onclick="pickOpt(${idx},${oi})">
      <span class="quiz-opt-letter">${String.fromCharCode(65+oi)}</span>${esc(opt)}
    </div>`).join('');
  return `<div class="quiz-card">
    <div class="quiz-card-header">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-ai)" stroke-width="2.5"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <span class="quiz-card-label">Quiz · Question ${idx+1} of ${quizData.length}</span>
    </div>
    <div class="quiz-card-body" id="quiz-card-body">
      <div class="quiz-q-text">${esc(q.question)}</div>
      <div class="quiz-opts" id="quiz-opts-${idx}">${opts}</div>
      <div id="quiz-feedback-${idx}"></div>
      <div class="quiz-nav">
        <span class="quiz-counter">${idx+1} / ${quizData.length}</span>
      </div>
    </div>
  </div>`;
}

function pickOpt(qi,oi){
  const q=quizData[qi];
  if(!q||quizAnswers[qi]!==undefined)return;
  quizAnswers[qi]=oi;
  const ci=resolveCorrectIdx(q);
  const correct=oi===ci;
  document.querySelectorAll(`[data-qi="${qi}"]`).forEach((el,j)=>{
    el.classList.add('answered');
    if(j===ci)el.classList.add('correct');
    else if(j===oi)el.classList.add('wrong');
  });
  const fb=document.getElementById(`quiz-feedback-${qi}`);
  if(fb){
    fb.innerHTML=`
      <div class="quiz-feedback ${correct?'fb-correct':'fb-wrong'}">
        ${correct?'✓ Correct!':'✗ Incorrect.'} ${esc(q.explanation||'')}
      </div>
      <div class="quiz-explain-row">
        <span class="quiz-explain-lbl">Want an explanation?</span>
        <button class="qxbtn yes" onclick="explainAnswer(${qi})">Yes, explain</button>
        <button class="qxbtn" onclick="afterAnswer(${qi})">Skip</button>
      </div>`;
  }
  scrollToBottom();
}

async function explainAnswer(qi){
  const q=quizData[qi];
  const ci=resolveCorrectIdx(q);
  const correct=q.options?.[ci]||'';
  document.getElementById(`quiz-feedback-${qi}`)?.querySelector('.quiz-explain-row')?.remove();
  appendThinking();isLoading=true;setSend(true);
  try{
    const data=await fetch(`/api/session/${SESSION_ID}/thread/${currentThread.id}/chat`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:`Explain why "${correct}" is correct for: "${q.question}"`,history:chatHistory,thread_name:currentThread.name})
    }).then(r=>r.json());
    removeThinking();
    if(data.ok){appendAiResponse(data.result);chatHistory.push({role:'assistant',content:data.result});}
  }catch(e){removeThinking();}
  isLoading=false;setSend(false);
  afterAnswer(qi);
}

function afterAnswer(qi){
  document.getElementById(`quiz-feedback-${qi}`)?.querySelector('.quiz-explain-row')?.remove();
  const nav=document.querySelector(`#quiz-opts-${qi}`)?.closest('.quiz-card-body')?.querySelector('.quiz-nav');
  if(nav){
    const last=qi>=quizData.length-1;
    nav.innerHTML=last
      ? `<span class="quiz-counter">${qi+1} / ${quizData.length}</span>
         <button class="quiz-next-btn" onclick="showResults()">See Results →</button>`
      : `<span class="quiz-counter">${qi+1} / ${quizData.length}</span>
         <button class="quiz-next-btn" onclick="nextQ()">Next →</button>`;
  }
  scrollToBottom();
}

function nextQ(){
  quizIdx++;
  const row=document.getElementById('quiz-card-row');
  if(!row||!quizData[quizIdx])return;
  const body=row.querySelector('.quiz-card-body');
  if(!body)return;
  gsap.to(body,{opacity:0,y:-8,duration:.18,ease:'power2.in',onComplete:()=>{
    row.innerHTML=buildQuizCardHTML(quizIdx);
    gsap.fromTo(row.querySelector('.quiz-card-body'),{opacity:0,y:8},{opacity:1,y:0,duration:.22,ease:'power2.out'});
    scrollToBottom();
  }});
}

function showResults(){
  const correct=Object.entries(quizAnswers).filter(([qi,oi])=>oi===resolveCorrectIdx(quizData[+qi])).length;
  const pct=Math.round(correct/quizData.length*100);
  const row=document.getElementById('quiz-card-row');
  if(!row)return;
  const body=row.querySelector('.quiz-card-body');
  if(body)body.innerHTML=`
    <div class="quiz-results">
      <div class="quiz-score">${pct}%</div>
      <div class="quiz-score-label">${correct}/${quizData.length} correct — ${pct>=80?'Excellent! 🎉':pct>=60?'Good effort! 👍':'Keep studying 📚'}</div>
      <button class="quiz-retry-btn" onclick="retryQuiz()">↺ Retry</button>
    </div>`;
  chatHistory.push({role:'assistant',content:`Quiz: ${correct}/${quizData.length} (${pct}%)`});
  scrollToBottom();
}

function retryQuiz(){
  quizIdx=0;quizAnswers={};
  const row=document.getElementById('quiz-card-row');
  if(row)row.innerHTML=buildQuizCardHTML(0);
  scrollToBottom();
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function fmt(text){
  // Process code blocks first to avoid inline formatting inside them
  const codeBlocks=[];
  text=text.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,lang,code)=>{
    const i=codeBlocks.length;
    codeBlocks.push({lang:lang||'code',code:code.trim()});
    return `\x00CODE${i}\x00`;
  });
  const lines=text.split('\n');
  let html='',ul=false,ol=false;
  for(const raw of lines){
    const line=raw;
    if(line.includes('\x00CODE')){
      cl();
      html=html.replace(/\x00CODE(\d+)\x00/,(_,i)=>{
        const{lang,code}=codeBlocks[+i];
        return `<pre><div class="code-header"><span class="code-lang">${esc(lang)}</span><button class="code-copy" onclick="copyCode(this)">Copy</button></div><code>${esc(code)}</code></pre>`;
      });
      // handle inline in same pass
      const remaining=line.replace(/\x00CODE(\d+)\x00/g,(_,i)=>{
        const{lang,code}=codeBlocks[+i];
        return `<pre><div class="code-header"><span class="code-lang">${esc(lang)}</span><button class="code-copy" onclick="copyCode(this)">Copy</button></div><code>${esc(code)}</code></pre>`;
      });
      if(remaining!==line)html+=remaining;
      continue;
    }
    const el=esc(line);
    if(/^###\s/.test(el)){cl();html+=`<h4>${el.slice(4)}</h4>`;}
    else if(/^##\s/.test(el)){cl();html+=`<h3>${el.slice(3)}</h3>`;}
    else if(/^#\s/.test(el)){cl();html+=`<h2>${el.slice(2)}</h2>`;}
    else if(/^[-*]\s/.test(el)){if(!ul){html+='<ul>';ul=true;}html+=`<li>${il(el.slice(2))}</li>`;}
    else if(/^\d+\.\s/.test(el)){if(!ol){html+='<ol>';ol=true;}html+=`<li>${il(el.replace(/^\d+\.\s/,''))}</li>`;}
    else if(/^&gt;\s/.test(el)){cl();html+=`<blockquote>${il(el.slice(5))}</blockquote>`;}
    else if(el.trim()==='---'){cl();html+='<hr style="border:none;border-top:1px solid var(--g5);margin:10px 0">';}
    else{cl();if(el.trim())html+=`<p>${il(el)}</p>`;}
  }
  cl();
  // Flush remaining code block placeholders
  html=html.replace(/\x00CODE(\d+)\x00/g,(_,i)=>{
    const{lang,code}=codeBlocks[+i];
    return `<pre><div class="code-header"><span class="code-lang">${esc(lang)}</span><button class="code-copy" onclick="copyCode(this)">Copy</button></div><code>${esc(code)}</code></pre>`;
  });
  return html;
  function cl(){if(ul){html+='</ul>';ul=false;}if(ol){html+='</ol>';ol=false;}}
  function il(s){return s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code>$1</code>').replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');}
}

function copyCode(btn){
  const code=btn.closest('pre')?.querySelector('code')?.innerText||'';
  navigator.clipboard.writeText(code).then(()=>{
    const orig=btn.textContent;btn.textContent='Copied!';
    setTimeout(()=>btn.textContent=orig,1800);
  });
}

function resolveCorrectIdx(q){
  const ans=(q.answer||q.correct_answer||'').toString().trim();
  const opts=q.options||[];
  if(!ans)return-1;
  if(/^[A-Da-d]\.?$/.test(ans))return ans.toUpperCase().charCodeAt(0)-65;
  const lm=ans.match(/^([A-Da-d])[.)]/);if(lm)return lm[1].toUpperCase().charCodeAt(0)-65;
  if(/^[0-3]$/.test(ans))return parseInt(ans);
  const ei=opts.findIndex(o=>o===ans);if(ei!==-1)return ei;
  const ci=opts.findIndex(o=>o.toLowerCase()===ans.toLowerCase());if(ci!==-1)return ci;
  return opts.findIndex(o=>o.toLowerCase().includes(ans.toLowerCase())||ans.toLowerCase().includes(o.toLowerCase()));
}

let _tt;
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('on');clearTimeout(_tt);_tt=setTimeout(()=>el.classList.remove('on'),3000);}