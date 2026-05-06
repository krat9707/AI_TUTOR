/* session.js — GSAP 3 + CustomEase + Lucide icons */

// ── Custom eases ──────────────────────────────────────────────────────────────
CustomEase.create("smooth", "M0,0 C0.16,0 0.17,0.96 0.48,0.98 0.7,1 0.84,1 1,1");
CustomEase.create("pop",    "M0,0 C0.12,0 0.16,1.12 0.5,1.04 0.7,1 0.84,1 1,1");

// ── Page loader ───────────────────────────────────────────────────────────────
const loaderTL = gsap.timeline();
loaderTL
  .to('.ld', { scale: 1.5, stagger: .1, duration: .3, ease: 'power2.out', yoyo: true, repeat: 1 })
  .to('.ld', { opacity: 0, y: -6, stagger: .06, duration: .22, ease: 'power2.in' }, '+=.05')
  .to('#loader', {
    autoAlpha: 0, duration: .35, ease: 'power2.inOut',
    onComplete: () => { document.getElementById('loader').remove(); entrance(); }
  });

// ── Entrance ──────────────────────────────────────────────────────────────────
function entrance() {
  gsap.set('.layout', { opacity: 1 });
  const tl = gsap.timeline({ defaults: { ease: 'smooth' } });
  tl
    .fromTo('.topbar',       { opacity:0, y:-8 },   { opacity:1, y:0, duration:.4 })
    .fromTo('.panel-left',   { opacity:0, x:-18 },  { opacity:1, x:0, duration:.5 }, '-=.2')
    .fromTo('.panel-right',  { opacity:0, x:18 },   { opacity:1, x:0, duration:.5 }, '<')
    .fromTo('.tab',          { opacity:0, y:6 },     { opacity:1, y:0, duration:.28, stagger:.04 }, '-=.2')
    .fromTo('.yt-embed, .topic-icon', { opacity:0, scale:.93, y:14 }, { opacity:1, scale:1, y:0, duration:.5, ease:'pop' }, .2)
    .fromTo('.msg',          { opacity:0, y:12, scale:.97 }, { opacity:1, y:0, scale:1, duration:.32, stagger:.07, ease:'pop' }, '-=.2')
    .fromTo('.chat-input-wrap', { opacity:0, y:8 },  { opacity:1, y:0, duration:.28 }, '-=.1');

  // Ambient pulse on YouTube embed
  const ytEmbed = document.querySelector('.yt-embed');
  if (ytEmbed) {
    setTimeout(() => {
      gsap.to(ytEmbed, {
        boxShadow: '0 0 0 1px rgba(0,0,0,0.07), 0 8px 28px rgba(200,60,30,0.13), 0 28px 72px rgba(200,60,30,0.09), 0 60px 100px rgba(200,60,30,0.05)',
        duration: 1.4, ease: 'power2.out'
      });
    }, 600);
  }

  // Orbit rings
  document.querySelectorAll('.orbit-ring').forEach((r, i) => {
    gsap.to(r, { rotation: 360, duration: 16 + i*7, ease: 'none', repeat: -1, transformOrigin: 'center' });
  });

  // Load transcript if YouTube
  if (IS_YOUTUBE) loadTranscript();

  // Word count for pasted text
  const textBody = document.getElementById('text-reader-body');
  const wcEl     = document.getElementById('word-count');
  if (textBody && wcEl) {
    const words = textBody.textContent.trim().split(/\s+/).filter(Boolean).length;
    const mins  = Math.ceil(words / 200);
    wcEl.textContent = `${words.toLocaleString()} words · ${mins} min read`;
  }

  // Tab slider initial position
  setTimeout(updateSlider, 50);

  // Check for Supadata pool quota toast
  if (sessionStorage.getItem('pool_quota')) {
    sessionStorage.removeItem('pool_quota');
    const url = sessionStorage.getItem('pool_quota_url') || '';
    sessionStorage.removeItem('pool_quota_url');
    setTimeout(() => {
      const el = document.getElementById('toast');
      if (el) {
        const safeUrl = url.replace(/'/g, "\\'");
        el.innerHTML = `Using app's quota. <a href="javascript:void(0)" onclick="showSupadataModal('To ensure uninterrupted service, please add your own API key.', '${safeUrl}')" style="text-decoration: underline; color: #93c5fd; cursor: pointer; margin-left: 6px;">Add your own key?</a>`;
        el.classList.add('on');
        clearTimeout(_toastT);
        _toastT = setTimeout(() => {
          el.classList.remove('on');
          setTimeout(() => { if (!el.classList.contains('on')) el.textContent = ''; }, 300);
        }, 8000);
        
        // Debug print to terminal
        fetch('/api/debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg: 'TOAST MESSAGE POPPED UP ON YT SESSION PAGE!' })
        }).catch(e => {});
      }
    }, 1000); // Wait 1s after entrance for better visibility
  }
}

// ── Tab system ────────────────────────────────────────────────────────────────
const TAB_ORDER = ['chat','summary','quiz','notes'];
let activeTab = 'chat';

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  if (name === activeTab) return;
  const prev = document.getElementById('panel-' + activeTab);
  const next = document.getElementById('panel-' + name);
  const dir  = TAB_ORDER.indexOf(name) > TAB_ORDER.indexOf(activeTab) ? 1 : -1;

  gsap.to(prev, { opacity:0, x: dir * -20, duration:.2, ease:'power2.in',
    onComplete: () => { prev.classList.remove('active'); gsap.set(prev, { x:0 }); }
  });
  next.classList.add('active');
  gsap.fromTo(next, { opacity:0, x: dir * 20 }, { opacity:1, x:0, duration:.28, ease:'smooth' });

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  activeTab = name;
  updateSlider();

  // Animate contents
  const items = next.querySelectorAll('.sum-card, .quiz-card, .gen-btn, .notes-editor');
  if (items.length) {
    gsap.fromTo(items, { opacity:0, y:14 }, { opacity:1, y:0, duration:.35, stagger:.06, ease:'pop', delay:.04 });
  }
}

function updateSlider() {
  const active = document.querySelector('.tab.active');
  const slider = document.getElementById('tab-slider');
  if (!active || !slider) return;
  slider.style.left  = active.offsetLeft + 'px';
  slider.style.width = active.offsetWidth + 'px';
}

// ── Transcript + Key Concepts ─────────────────────────────────────────────────
let transcriptChunks  = [];
let keyConceptsData   = [];
let conceptExplanations = {}; // cache: { conceptName: explanationHTML }
let _conceptTabCounter = 0;   // unique ID for concept tabs
let ytPlayer = null;

function fmtTime(sec) {
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

async function loadTranscript() {
  try {
    const res = await fetch(`/api/session/${SESSION_ID}/transcript`);
    const data = await res.json();
    if (!data.ok) {
      renderTranscript([]);
      return;
    }
    transcriptChunks  = data.chunks || [];
    renderTranscript(transcriptChunks);
  } catch(e) {
    renderTranscript([]);
  }
}

// ── Key Concepts rendering ────────────────────────────────────────────────────

function renderKeyConcepts(concepts) {
  const cont = document.getElementById('transcript-list');
  if (!cont) return;

  if (!concepts || !concepts.length) {
    cont.innerHTML = `<div class="tr-empty">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
      <p>Extract key concepts from this content.</p>
      <button class="gen-btn" id="gen-concepts-btn" onclick="generateKeyConcepts()" style="margin-top:10px;padding:8px 18px;font-size:13px;max-width:220px">
        <div class="gen-sp"></div>
        <span class="gen-lbl" style="display:flex;align-items:center;gap:6px">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
          Extract Key Concepts
        </span>
      </button>
    </div>`;
    return;
  }

  const header = `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px 2px;margin-bottom:2px">
    <span style="font-size:11px;color:var(--g4)">${concepts.length} concepts</span>
    <button onclick="generateKeyConcepts(true)" style="font-size:11px;background:none;border:1px solid var(--g5);border-radius:6px;padding:3px 9px;cursor:pointer;color:var(--g3);transition:all .15s" onmouseenter="this.style.borderColor='var(--g3)';this.style.color='var(--black)'" onmouseleave="this.style.borderColor='var(--g5)';this.style.color='var(--g3)'">↺ Regenerate</button>
  </div>`;

  const buttons = `<div class="kc-grid">${concepts.map((c, i) =>
    `<button class="kc-btn" onclick="openConceptTab('${c.replace(/'/g, "\\'")}')" data-concept="${i}">
      <span class="kc-dot"></span>
      <span class="kc-label">${c}</span>
      <svg class="kc-arrow" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </button>`
  ).join('')}</div>`;

  cont.innerHTML = header + buttons;

  // Animate in
  gsap.fromTo('.kc-btn',
    { opacity: 0, y: 8 },
    { opacity: 1, y: 0, duration: .3, stagger: .04, ease: 'power2.out', delay: .05 }
  );
}

let _kcLoading = false;
async function generateKeyConcepts(force) {
  if (_kcLoading) return;
  _kcLoading = true;
  const btn = document.getElementById('gen-concepts-btn');
  if (btn) setLoading(btn, true);
  try {
    const res = await fetch(`/api/session/${SESSION_ID}/key_concepts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!force })
    });
    const data = await res.json();
    if (data.ok && data.concepts?.length) {
      keyConceptsData = data.concepts;
      conceptExplanations = {}; // clear explanation cache on regenerate
      renderKeyConcepts(keyConceptsData);
      toast(`${data.concepts.length} key concepts extracted!`);
    } else {
      toast(data.error || 'Could not extract concepts.');
    }
  } catch(e) {
    toast('Network error extracting concepts.');
  }
  _kcLoading = false;
  if (btn) setLoading(btn, false);
}

// ── Dynamic Concept Tabs (right panel) ────────────────────────────────────────

function openConceptTab(conceptName) {
  const tabId = 'concept-' + conceptName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const panelId = 'panel-' + tabId;

  // If tab already exists, just switch to it
  if (document.getElementById(panelId)) {
    switchTab(tabId);
    return;
  }

  // Create the tab button
  const tabNav = document.querySelector('.tabs');
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab concept-tab';
  tabBtn.dataset.tab = tabId;
  tabBtn.innerHTML = `
    <i data-lucide="lightbulb"></i>
    <span class="concept-tab-name">${conceptName}</span>
    <span class="concept-tab-close" onclick="event.stopPropagation();closeConceptTab('${tabId}')" title="Close">×</span>
  `;
  tabBtn.addEventListener('click', () => switchTab(tabId));
  tabNav.appendChild(tabBtn);

  // Add to TAB_ORDER
  TAB_ORDER.push(tabId);

  // Create the panel
  const panelsContainer = document.querySelector('.tab-panels');
  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.id = panelId;
  panel.innerHTML = `
    <div class="concept-detail">
      <div class="concept-detail-header">
        <div class="concept-detail-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
        </div>
        <h3 class="concept-detail-title">${conceptName}</h3>
      </div>
      <div class="concept-detail-body" id="concept-body-${tabId}">
        <div class="concept-loading">
          <div class="td"></div><div class="td"></div><div class="td"></div>
          <p style="margin-top:10px;font-size:12px;color:var(--g4)">Generating explanation…</p>
        </div>
      </div>
    </div>
  `;
  panelsContainer.appendChild(panel);

  // Re-init lucide icons
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Scroll tabs to make the new tab visible
  tabNav.scrollLeft = tabNav.scrollWidth;

  // Switch to the new tab
  switchTab(tabId);

  // Animate tab button entrance
  gsap.fromTo(tabBtn, { opacity: 0, scale: .9 }, { opacity: 1, scale: 1, duration: .25, ease: 'pop' });

  // Fetch explanation
  fetchConceptExplanation(conceptName, tabId);
}

async function fetchConceptExplanation(conceptName, tabId) {
  const bodyEl = document.getElementById('concept-body-' + tabId);
  if (!bodyEl) return;

  // Check cache
  if (conceptExplanations[conceptName]) {
    bodyEl.innerHTML = `<div class="sum-body markdown-body">${conceptExplanations[conceptName]}</div>`;
    gsap.fromTo(bodyEl.firstChild, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .35, ease: 'pop' });
    return;
  }

  try {
    const res = await fetch(`/api/session/${SESSION_ID}/explain_concept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concept: conceptName })
    });
    const data = await res.json();
    if (data.ok && data.explanation) {
      const html = fmt(data.explanation);
      conceptExplanations[conceptName] = html;
      bodyEl.innerHTML = `<div class="sum-body markdown-body">${html}</div>`;
      gsap.fromTo(bodyEl.firstChild, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .4, ease: 'pop' });
    } else {
      bodyEl.innerHTML = `<div class="tr-empty" style="padding:24px">
        <p>Could not generate explanation. ${data.error || ''}</p>
        <button class="gen-btn" onclick="fetchConceptExplanation('${conceptName.replace(/'/g, "\\'")}','${tabId}')" style="margin-top:10px;padding:8px 18px;font-size:12px;max-width:160px">
          <span class="gen-lbl">↺ Retry</span>
        </button>
      </div>`;
    }
  } catch(e) {
    bodyEl.innerHTML = `<div class="tr-empty" style="padding:24px">
      <p>Network error. Please try again.</p>
      <button class="gen-btn" onclick="fetchConceptExplanation('${conceptName.replace(/'/g, "\\'")}','${tabId}')" style="margin-top:10px;padding:8px 18px;font-size:12px;max-width:160px">
        <span class="gen-lbl">↺ Retry</span>
      </button>
    </div>`;
  }
}

function closeConceptTab(tabId) {
  const tabBtn = document.querySelector(`.tab[data-tab="${tabId}"]`);
  const panel  = document.getElementById('panel-' + tabId);

  // If this is the active tab, switch to chat first
  if (activeTab === tabId) {
    switchTab('chat');
  }

  // Animate out then remove
  if (tabBtn) {
    gsap.to(tabBtn, { opacity: 0, scale: .85, duration: .18, ease: 'power2.in', onComplete: () => {
      tabBtn.remove();
      updateSlider();
    }});
  }
  if (panel) {
    gsap.to(panel, { opacity: 0, duration: .15, onComplete: () => panel.remove() });
  }

  // Remove from TAB_ORDER
  const idx = TAB_ORDER.indexOf(tabId);
  if (idx > -1) TAB_ORDER.splice(idx, 1);
}


function groupTranscript(chunks) {
  // Group chunks into ~25s blocks for readability
  const groups = [];
  let cur = null;
  for (const c of chunks) {
    if (!cur || c.start - cur.start > 25) {
      if (cur) groups.push(cur);
      cur = { start: c.start, text: c.text };
    } else {
      cur.text += ' ' + c.text;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

function renderTranscript(chunks) {
  const cont = document.getElementById('transcript-list');
  if (!cont) return;
  if (!chunks || !chunks.length) {
    cont.innerHTML = `<div class="tr-empty">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <p>No transcript available for this video.</p>
    </div>`;
    return;
  }

  const groups = groupTranscript(chunks);
  cont.innerHTML = groups.map((g, i) => `
    <div class="tr-item" data-start="${g.start}" data-idx="${i}" onclick="seekTo(${g.start})">
      <span class="tr-ts">${fmtTime(g.start)}</span>
      <span class="tr-text">${g.text}</span>
    </div>
  `).join('');

  // Animate in
  gsap.fromTo('.tr-item',
    { opacity:0, x:-8 },
    { opacity:1, x:0, duration:.28, stagger:.025, ease:'power2.out', delay:.1 }
  );
}

// Transcript tab toggle
document.querySelectorAll('.tr-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tr-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Seek YouTube iframe
function seekTo(seconds) {
  const iframe = document.getElementById('yt-iframe');
  if (!iframe) return;
  // Use YouTube IFrame API postMessage
  iframe.contentWindow.postMessage(
    JSON.stringify({ event: 'command', func: 'seekTo', args: [Math.floor(seconds), true] }),
    '*'
  );
  // Highlight active item
  document.querySelectorAll('.tr-item').forEach(el => {
    el.classList.toggle('active', parseFloat(el.dataset.start) === seconds);
  });
}

// ── Chat ──────────────────────────────────────────────────────────────────────
const chatMsgs = document.getElementById('chat-msgs');
const chatTa   = document.getElementById('chat-ta');
const sendBtn  = document.getElementById('chat-send');
let streaming  = false;

chatTa?.addEventListener('input', () => {
  chatTa.style.height = 'auto';
  chatTa.style.height = Math.min(chatTa.scrollHeight, 110) + 'px';
});
chatTa?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
sendBtn?.addEventListener('click', sendMsg);

document.querySelectorAll('.chat-hint').forEach(h => {
  h.addEventListener('click', () => { chatTa.value = h.textContent.trim(); sendMsg(); });
});

async function sendMsg() {
  const text = chatTa?.value.trim();
  if (!text || streaming) return;
  streaming = true;
  sendBtn.disabled = true;
  chatTa.value = '';
  chatTa.style.height = 'auto';

  appendMsg('user', text);
  const typingEl = appendTyping();
  scrollChat();

  try {
    const res = await fetch(`/api/session/${SESSION_ID}/tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text, context: '' })
    });
    const data = await res.json();
    typingEl.remove();
    appendMsg('ai', data.ok ? data.result : (data.error || 'Something went wrong.'));
  } catch(e) {
    typingEl.remove();
    appendMsg('ai', 'Network error. Please try again.');
  }
  streaming = false;
  sendBtn.disabled = false;
  scrollChat();
}

function appendMsg(role, text) {
  const isAI = role === 'ai';
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="msg-av">${isAI ? 'AI' : 'Me'}</div><div class="msg-bub">${fmt(text)}</div>`;
  chatMsgs.appendChild(div);
  gsap.fromTo(div, { opacity:0, y:12, scale:.97 }, { opacity:1, y:0, scale:1, duration:.3, ease:'pop' });
  return div;
}

function appendTyping() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `<div class="msg-av">AI</div><div class="typing-ind"><div class="td"></div><div class="td"></div><div class="td"></div></div>`;
  chatMsgs.appendChild(div);
  gsap.fromTo(div, { opacity:0, y:8 }, { opacity:1, y:0, duration:.22 });
  return div;
}

function scrollChat() {
  gsap.to(chatMsgs, { scrollTop: chatMsgs.scrollHeight, duration:.35, ease:'power2.out' });
}

function fmt(text) {
  if (!text) return '';
  try {
    return marked.parse(text, { breaks: true, gfm: true });
  } catch(e) {
    // Fallback: escape and return as paragraphs
    return '<p>' + text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p>';
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
document.getElementById('btn-summary')?.addEventListener('click', async function() {
  setLoading(this, true);
  try {
    const res  = await fetch(`/api/session/${SESSION_ID}/summarize`, { method:'POST' });
    const data = await res.json();
    if (data.ok) {
      renderSummary(data.result);
      this.style.display = 'none';
      toast('Summary generated!');
    } else toast(data.error || 'Failed.');
  } catch { toast('Network error.'); }
  setLoading(this, false);
});

function renderSummary(text) {
  const cont = document.getElementById('summary-content');
  if (!cont) return;
  cont.innerHTML = `<div class="sum-card"><div class="sum-label">Summary</div><div class="sum-body">${fmt(text)}</div></div>`;
  gsap.fromTo('.sum-card', { opacity:0, y:14 }, { opacity:1, y:0, duration:.4, ease:'pop' });
}

// ── Quiz ──────────────────────────────────────────────────────────────────────
let quizData  = [];
let quizCount = '5';

document.querySelectorAll('.qpill').forEach(p => {
  p.addEventListener('click', () => {
    document.querySelectorAll('.qpill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    quizCount = p.dataset.count;
  });
});

document.getElementById('btn-quiz')?.addEventListener('click', async function() {
  setLoading(this, true);
  try {
    const res  = await fetch(`/api/session/${SESSION_ID}/quiz`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ num_questions: parseInt(quizCount), difficulty:'intermediate' })
    });
    if (!res.ok) { toast(`Server error ${res.status}`); setLoading(this, false); return; }
    const data = await res.json();
    if (data.ok) {
      let qs = null;
      if (data.questions) qs = data.questions;
      else if (data.result) { try { qs = JSON.parse(data.result); } catch {} }
      if (qs && Array.isArray(qs)) renderQuiz(qs);
      else renderQuizText(data.result || '');
      toast('Quiz ready!');
    } else toast(data.error || 'Failed.');
  } catch(e) { toast('Network error.'); }
  setLoading(this, false);
});

function renderQuiz(qs) {
  const cont = document.getElementById('quiz-content');
  if (!cont) return;
  quizData = qs;
  cont.innerHTML = qs.map((q, i) => `
    <div class="quiz-card" id="qc-${i}">
      <div class="quiz-q">Q${i+1}. ${q.question}</div>
      <div class="quiz-options">
        ${(q.options||[]).map((opt,j) => `
          <div class="quiz-opt" onclick="pickOpt(${i},${j})" data-qi="${i}" data-oi="${j}">
            ${String.fromCharCode(65+j)}. ${opt}
          </div>
        `).join('')}
        <div class="quiz-exp">${q.explanation||''}</div>
      </div>
    </div>
  `).join('');
  gsap.fromTo('.quiz-card', { opacity:0, y:14, scale:.97 }, { opacity:1, y:0, scale:1, duration:.38, stagger:.07, ease:'pop' });
  document.getElementById('btn-quiz').style.display = 'none';
}

function renderQuizText(text) {
  const cont = document.getElementById('quiz-content');
  if (!cont) return;
  cont.innerHTML = `<div class="quiz-card"><div class="quiz-q" style="white-space:pre-wrap;font-weight:400;line-height:1.75">${text}</div></div>`;
  gsap.fromTo('.quiz-card', { opacity:0, y:14 }, { opacity:1, y:0, duration:.4, ease:'pop' });
}

function pickOpt(qi, oi) {
  const q = quizData[qi];
  if (!q) return;
  const correctIdx = resolveCorrectIdx(q);
  document.querySelectorAll(`[data-qi="${qi}"]`).forEach((el, j) => {
    el.classList.remove('correct', 'wrong');
    if (j === correctIdx) el.classList.add('correct');
    else if (j === oi)    el.classList.add('wrong');
  });
  gsap.fromTo(`[data-qi="${qi}"][data-oi="${oi}"]`,
    { scale:.96 }, { scale:1, duration:.22, ease:'back.out(2)' }
  );
}

// ── Answer resolution helper ────────────────────────────────────────────────
// Models return answer in many formats:
//   "A"  |  "A."  |  "A. Option text"  |  "Option text"  |  0 (index)
function resolveCorrectIdx(q) {
  const ans = (q.answer || q.correct_answer || '').toString().trim();
  const opts = q.options || [];
  if (!ans) return -1;

  // 1. Single letter: "A" / "B" / "C" / "D"
  if (/^[A-Da-d]\.?$/.test(ans)) {
    return ans.toUpperCase().charCodeAt(0) - 65;
  }
  // 2. "A. some text" or "A) some text"
  const letterMatch = ans.match(/^([A-Da-d])[.)]/);
  if (letterMatch) {
    return letterMatch[1].toUpperCase().charCodeAt(0) - 65;
  }
  // 3. Numeric index
  if (/^[0-3]$/.test(ans)) return parseInt(ans);

  // 4. Full text match (exact or case-insensitive)
  const exactIdx = opts.findIndex(o => o === ans);
  if (exactIdx !== -1) return exactIdx;
  const ciIdx = opts.findIndex(o => o.toLowerCase() === ans.toLowerCase());
  if (ciIdx !== -1) return ciIdx;

  // 5. Partial match — answer is contained in option or vice versa
  const partIdx = opts.findIndex(o =>
    o.toLowerCase().includes(ans.toLowerCase()) ||
    ans.toLowerCase().includes(o.toLowerCase())
  );
  return partIdx; // -1 if nothing matches
}

// ── Notes ─────────────────────────────────────────────────────────────────────
// Notes are user-written — no AI generation

function applyNote(type) {
  const ta = document.getElementById('notes-ta');
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.substring(s, e);
  const map = { bold:`**${sel}**`, italic:`_${sel}_`, h:`\n## ${sel}`, bullet:`\n- ${sel}` };
  ta.setRangeText(map[type] || sel, s, e, 'end');
  ta.focus();
  updateNotesPreview();
}

function switchNotesMode(mode) {
  document.querySelectorAll('.notes-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const ta = document.getElementById('notes-ta');
  const preview = document.getElementById('notes-preview');
  const fmtBtns = document.getElementById('notes-fmt-btns');
  if (mode === 'preview') {
    ta.style.display = 'none';
    preview.style.display = 'block';
    if (fmtBtns) fmtBtns.style.display = 'none';
    updateNotesPreview();
  } else {
    ta.style.display = '';
    preview.style.display = 'none';
    if (fmtBtns) fmtBtns.style.display = '';
    ta.focus();
  }
}

function updateNotesPreview() {
  const ta = document.getElementById('notes-ta');
  const preview = document.getElementById('notes-preview');
  if (!ta || !preview) return;
  const text = ta.value || '';
  try {
    preview.innerHTML = text.trim() ? marked.parse(text, { breaks: true, gfm: true }) : '';
  } catch(e) {
    preview.textContent = text;
  }
}

async function saveNotes() {
  const notes = document.getElementById('notes-ta')?.value;
  if (notes === undefined) return;
  const res = await fetch(`/api/session/${SESSION_ID}/save_notes`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ notes })
  });
  const d = await res.json();
  toast(d.ok ? 'Saved!' : 'Failed to save.');
}

// ── Exam ──────────────────────────────────────────────────────────────────────
let examData    = [];
let examIdx     = 0;
let examAnswers = {};
let examTimer   = null;
let examSecs    = 0;
let examDone    = false;

function openExamModal() {
  const bg = document.getElementById('exam-modal');
  bg.classList.add('open');
  gsap.fromTo(bg, { opacity:0 }, { opacity:1, duration:.22, ease:'power2.out' });
  gsap.fromTo(bg.querySelector('.modal'),
    { opacity:0, scale:.9, y:18 },
    { opacity:1, scale:1, y:0, duration:.36, ease:'pop' }
  );
}

function closeExamModal() {
  const bg = document.getElementById('exam-modal');
  gsap.to(bg.querySelector('.modal'), { opacity:0, scale:.93, y:10, duration:.2, ease:'power2.in' });
  gsap.to(bg, { opacity:0, duration:.26, ease:'power2.in', onComplete: () => bg.classList.remove('open') });
}

async function startExam() {
  const nq   = parseInt(document.getElementById('exam-nq')?.value || 10);
  const diff = document.getElementById('exam-diff')?.value || 'mixed';
  const tlim = parseInt(document.getElementById('exam-time')?.value || 30);

  const btn = document.getElementById('exam-start-btn');
  btn.textContent = 'Generating…'; btn.disabled = true;

  try {
    const res  = await fetch(`/api/session/${SESSION_ID}/exam`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ num_questions: nq, difficulty: diff, time_limit: tlim })
    });
    const data = await res.json();
    if (!data.ok) {
      toast(data.error || 'Failed to generate exam.');
      btn.textContent = 'Start Exam'; btn.disabled = false;
      return;
    }

    let qs = null;
    if (data.questions) qs = data.questions;
    else if (data.result) { try { qs = JSON.parse(data.result); } catch {} }
    if (!qs || !Array.isArray(qs) || !qs.length) {
      toast('Could not parse exam questions. Try again.');
      btn.textContent = 'Start Exam'; btn.disabled = false;
      return;
    }

    // Full reset before launching
    examData    = qs;
    examIdx     = 0;
    examAnswers = {};
    examDone    = false;
    examSecs    = tlim * 60;

    closeExamModal();
    setTimeout(() => launchExam(), 350);

  } catch(e) { toast('Network error: ' + e.message); }
  btn.textContent = 'Start Exam'; btn.disabled = false;
}

function launchExam() {
  // Restore exam body structure in case it was replaced by results
  const body = document.querySelector('.exam-body');
  body.innerHTML = `
    <div class="exam-q-num" id="exam-q-num"></div>
    <div class="exam-question" id="exam-question"></div>
    <div class="exam-opts" id="exam-opts"></div>
  `;

  const screen = document.getElementById('exam-screen');
  screen.classList.add('open');
  gsap.fromTo(screen, { opacity:0 }, { opacity:1, duration:.3, ease:'smooth' });

  updateNavBtns();
  renderExamQ();
  startExamTimer();
}

function updateNavBtns() {
  const nextBtn   = document.getElementById('exam-next-btn');
  const finishBtn = document.getElementById('exam-finish-btn');
  if (!nextBtn || !finishBtn) return;
  const isLast = examIdx >= examData.length - 1;
  nextBtn.style.display   = isLast ? 'none' : '';
  finishBtn.style.display = isLast ? '' : 'none';
}

function renderExamQ() {
  const q = examData[examIdx];
  if (!q) return;

  document.getElementById('exam-q-num').textContent    = `Question ${examIdx+1} of ${examData.length}`;
  document.getElementById('exam-question').textContent  = q.question;
  document.getElementById('exam-opts').innerHTML = (q.options||[]).map((opt, j) => `
    <div class="exam-opt${examAnswers[examIdx] === j ? ' selected' : ''}"
         onclick="selectExamOpt(${j})" data-oi="${j}">
      ${String.fromCharCode(65+j)}. ${opt}
    </div>
  `).join('');

  const pct = (examIdx / examData.length * 100).toFixed(1);
  document.getElementById('exam-progress-fill').style.width = pct + '%';

  updateNavBtns();

  gsap.fromTo('#exam-question', { opacity:0, y:10 }, { opacity:1, y:0, duration:.3, ease:'smooth' });
  gsap.fromTo('.exam-opt', { opacity:0, x:-8 }, { opacity:1, x:0, duration:.28, stagger:.05, ease:'power2.out' });
}

function selectExamOpt(oi) {
  examAnswers[examIdx] = oi;
  document.querySelectorAll('.exam-opt').forEach((el, j) => {
    el.classList.toggle('selected', j === oi);
  });
  gsap.fromTo(`.exam-opt:nth-child(${oi+1})`, { scale:.97 }, { scale:1, duration:.2, ease:'back.out(2)' });
}

function examNext() {
  if (examDone || examIdx >= examData.length - 1) return;
  examIdx++;
  gsap.to('#exam-question, .exam-opt', {
    opacity:0, x:-16, duration:.18, ease:'power2.in',
    onComplete: renderExamQ
  });
}

function examPrev() {
  if (examIdx <= 0) return;
  examIdx--;
  gsap.to('#exam-question, .exam-opt', {
    opacity:0, x:16, duration:.18, ease:'power2.in',
    onComplete: renderExamQ
  });
}

function finishExam() {
  if (examDone) return;
  examDone = true;
  clearInterval(examTimer);

  let correct = 0;
  examData.forEach((q, i) => {
    const ai = examAnswers[i];
    if (ai !== undefined) {
      const correctIdx = resolveCorrectIdx(q);
      if (ai === correctIdx) correct++;
    }
  });
  const pct = Math.round(correct / examData.length * 100);
  const emoji = pct >= 80 ? '🎉' : pct >= 60 ? '👍' : '📚';
  const msg   = pct >= 80 ? 'Excellent work!' : pct >= 60 ? 'Good effort!' : 'Keep studying!';

  document.getElementById('exam-progress-fill').style.width = '100%';

  document.querySelector('.exam-body').innerHTML = `
    <div class="results-wrap">
      <div class="results-score">${pct}%</div>
      <div class="results-label">${correct} / ${examData.length} correct</div>
      <div class="results-detail">${emoji} ${msg}</div>
      <button class="exam-nav-btn" onclick="closeExam()" style="margin-top:24px">
        Close Exam
      </button>
    </div>
  `;
  // Hide nav buttons on results screen
  document.getElementById('exam-next-btn').style.display   = 'none';
  document.getElementById('exam-finish-btn').style.display = 'none';
  document.querySelector('.exam-nav .exam-nav-btn.secondary').style.display = 'none';

  gsap.fromTo('.results-wrap > *', { opacity:0, y:18 }, { opacity:1, y:0, duration:.4, stagger:.08, ease:'pop' });
}

function closeExam() {
  clearInterval(examTimer);
  examDone = false;
  const screen = document.getElementById('exam-screen');
  gsap.to(screen, {
    opacity:0, duration:.28, ease:'power2.in',
    onComplete: () => {
      screen.classList.remove('open');
      // Restore nav buttons for next attempt
      const nextBtn   = document.getElementById('exam-next-btn');
      const finishBtn = document.getElementById('exam-finish-btn');
      const prevBtn   = document.querySelector('.exam-nav .exam-nav-btn.secondary');
      if (nextBtn)   { nextBtn.style.display = ''; }
      if (finishBtn) { finishBtn.style.display = 'none'; }
      if (prevBtn)   { prevBtn.style.display = ''; }
    }
  });
}

function startExamTimer() {
  clearInterval(examTimer); // safety — clear any leftover timer
  const el = document.getElementById('exam-timer-display');
  function tick() {
    if (examSecs <= 0) { clearInterval(examTimer); finishExam(); return; }
    examSecs--;
    const m = Math.floor(examSecs / 60), s = examSecs % 60;
    el.textContent = `${m}:${String(s).padStart(2,'0')}`;
    document.getElementById('exam-timer').classList.toggle('warning', examSecs <= 60);
  }
  tick();
  examTimer = setInterval(tick, 1000);
}

// ── Hover effects ─────────────────────────────────────────────────────────────
sendBtn?.addEventListener('mouseenter', () => gsap.to(sendBtn, { scale:1.1, duration:.2, ease:'back.out(2)' }));
sendBtn?.addEventListener('mouseleave', () => gsap.to(sendBtn, { scale:1, duration:.28, ease:'elastic.out(1,.6)' }));

document.querySelector('.exam-btn')?.addEventListener('mouseenter', e => {
  gsap.to(e.currentTarget, { y:-2, duration:.18, ease:'power2.out' });
});
document.querySelector('.exam-btn')?.addEventListener('mouseleave', e => {
  gsap.to(e.currentTarget, { y:0, duration:.28, ease:'elastic.out(1,.6)' });
});

// ── Modal background click ────────────────────────────────────────────────────
document.getElementById('exam-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('exam-modal')) closeExamModal();
});

// ── ESC ───────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeExamModal();
  if (document.getElementById('supadata-modal')?.classList.contains('open')) {
    closeSupadataModal();
  }
});

// ── Supadata Quota Modal ──────────────────────────────────────────────────────
let _supadataRetryUrl = '';

window.showSupadataModal = function(msg, retryUrl) {
  _supadataRetryUrl = retryUrl || '';
  document.getElementById('supadata-popup-msg').textContent = msg || 'To continue loading transcripts, please provide your Supadata API key.';
  const bg = document.getElementById('supadata-modal');
  bg.classList.add('open');
  gsap.fromTo(bg, { opacity:0 }, { opacity:1, duration:.22, ease:'power2.out' });
  gsap.fromTo(bg.querySelector('.modal'),
    { opacity:0, scale:.9, y:18 },
    { opacity:1, scale:1, y:0, duration:.36, ease:'pop' }
  );
};

window.closeSupadataModal = function() {
  const bg = document.getElementById('supadata-modal');
  if (!bg) return;
  gsap.to(bg.querySelector('.modal'), { opacity:0, scale:.93, y:10, duration:.2, ease:'power2.in' });
  gsap.to(bg, { opacity:0, duration:.26, ease:'power2.in', onComplete: () => bg.classList.remove('open') });
};

window.saveSupadataKey = async function() {
  const keyInput = document.getElementById('supadata-api-key').value.trim();
  if (!keyInput) {
    toast('Please enter a valid API key.');
    return;
  }
  const btn = document.getElementById('supadata-save-btn');
  const oldText = btn.textContent;
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/user/supadata_key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: keyInput })
    });
    const data = await res.json();
    if (data.ok) {
      toast('API key saved!');
      closeSupadataModal();
    } else {
      toast(data.error || 'Failed to save API key.');
    }
  } catch (err) {
    toast('Network error. Could not save key.');
  }
  btn.textContent = oldText;
  btn.disabled = false;
};

document.getElementById('supadata-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('supadata-modal')) closeSupadataModal();
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function setLoading(btn, on) {
  btn.classList.toggle('loading', on);
  btn.disabled = on;
}

let _toastT;
function toast(msg, dur = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('on'), dur);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('panel-chat')?.classList.add('active');
  document.querySelector('.tab[data-tab="chat"]')?.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();
});