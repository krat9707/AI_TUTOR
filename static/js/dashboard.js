/**
 * dashboard.js
 * 
 * ARCHITECTURE (animation ownership):
 *   GSAP   — entrance sequence, sidebar xPercent, divider scaleX
 *   anime  — micro interactions (hover/press), modal open/close, ctx menu
 *   Canvas — ambient orb background (runs forever, independent of everything)
 *   IO     — IntersectionObserver for card scroll reveals (reliable, no ScrollTrigger timing issues)
 *
 * CRITICAL RULE: Nothing is hidden via CSS. GSAP uses gsap.set() at runEntrance()
 * start to hide animated elements. This prevents the "invisible before JS" gap AND
 * the "fromTo resets to 0 mid-sequence" race condition.
 */
'use strict';

/* ─────────────────────────────────────────────
   AMBIENT CANVAS — slow-breathing light orbs
   Runs completely independently of page animations
───────────────────────────────────────────── */
(function initAmbient() {
  const canvas = document.getElementById('ambient-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let W, H;
  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // Orb definition — soft, slow, serene
  const orbs = [
    { x:.18, y:.22, r:.55, hue:200, sat:60,  spd:.00018, phase:0.0,   drift:.07  },
    { x:.78, y:.15, r:.48, hue:220, sat:50,  spd:.00014, phase:1.8,   drift:.06  },
    { x:.50, y:.72, r:.60, hue:185, sat:55,  spd:.00021, phase:3.4,   drift:.08  },
    { x:.85, y:.65, r:.40, hue:210, sat:45,  spd:.00012, phase:5.1,   drift:.05  },
    { x:.12, y:.78, r:.44, hue:195, sat:50,  spd:.00017, phase:2.6,   drift:.06  },
    { x:.62, y:.38, r:.36, hue:230, sat:40,  spd:.00019, phase:4.2,   drift:.04  },
  ];

  let t = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);

    orbs.forEach(o => {
      // sinusoidal drift in both axes
      const cx = (o.x + Math.sin(t * o.spd * 0.7 + o.phase) * o.drift) * W;
      const cy = (o.y + Math.cos(t * o.spd       + o.phase) * o.drift) * H;
      const radius = o.r * Math.min(W, H);

      // Breathe: radius pulses very subtly
      const breathe = 1 + 0.04 * Math.sin(t * o.spd * 3 + o.phase);
      const r = radius * breathe;

      // Opacity pulses between .03 and .065
      const alpha = 0.03 + 0.035 * (0.5 + 0.5 * Math.sin(t * o.spd * 2 + o.phase + 1));

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0,   `hsla(${o.hue}, ${o.sat}%, 72%, ${alpha})`);
      grad.addColorStop(0.4, `hsla(${o.hue}, ${o.sat}%, 68%, ${alpha * .6})`);
      grad.addColorStop(1,   `hsla(${o.hue}, ${o.sat}%, 65%, 0)`);

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });

    t++;
    requestAnimationFrame(draw);
  }
  draw();
})();

/* ─────────────────────────────────────────────
   GSAP SETUP
───────────────────────────────────────────── */
CustomEase.create('settle', 'M0,0 C0.25,0 0.18,0.96 0.44,0.98 0.66,1 0.84,1 1,1');
gsap.registerPlugin(ScrollTrigger);

/* ─────────────────────────────────────────────
   LUCIDE ICONS + MODEL TOGGLE
───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  initModelToggle();
});

/* ─────────────────────────────────────────────
   PAGE LOADER
───────────────────────────────────────────── */
const _loader = document.getElementById('page-loader');

// Init sidebar position immediately (before anything is visible)
gsap.set('#sidebar', { xPercent: -100 });

gsap.timeline()
  .to('.loader-word', { opacity: 1, duration: .55, ease: 'power2.out', delay: .15 })
  .to('.loader-word', { opacity: 0, y: -8, duration: .38, ease: 'power2.in', delay: .6 })
  .to(_loader, {
    autoAlpha: 0, duration: .36, ease: 'power2.inOut',
    onComplete() { _loader.remove(); runEntrance(); }
  });

/* ─────────────────────────────────────────────
   ENTRANCE SEQUENCE
   Rule: gsap.set() hides elements first, then gsap.to() reveals.
   Never use fromTo() — the "from" phase can race with CSS.
───────────────────────────────────────────── */
function runEntrance() {
  // ── 1. Set all animated elements to hidden BEFORE starting any tween ──
  gsap.set([
    '.topbar',
    '#hero-greeting',
    '#hero-title',
    '#chat-wrap',
    '.action-btn',
    '#section-divider',
    '#spaces-header'
  ], { opacity: 0 });

  // Cards handled separately by IntersectionObserver
  gsap.set('.space-card', { opacity: 0, y: 24 });

  // ── 2. Topbar fades in (no positional animation — avoids backdrop-filter conflicts) ──
  gsap.to('.topbar', { opacity: 1, duration: .5, ease: 'power2.out', delay: .1 });

  // ── 3. Hero + below: sequential timeline ──
  gsap.timeline({ delay: .3 })
    .to('#hero-greeting', { opacity: 1, y: 0, duration: .7, ease: 'settle' })
    .to('#hero-title',    { opacity: 1, y: 0, duration: .85, ease: 'settle' },     '-=.4')
    .to('#chat-wrap',     { opacity: 1, y: 0, duration: .6,  ease: 'settle' },     '-=.5')
    .to('.action-btn',    { opacity: 1, y: 0, duration: .45, stagger: .07, ease: 'settle' }, '-=.38')
    .to('#section-divider', { opacity: 1, scaleX: 1, duration: .9, ease: 'power2.out' },     '-=.25')
    .to('#spaces-header', { opacity: 1, y: 0, duration: .4,  ease: 'settle' },     '-=.65');

  // ── 4. Cards via IntersectionObserver (fires when card enters viewport, reliable) ──
  setupCardReveal();

  // ── 5. Micro-interactions ──
  initActionBtns();
  initCardHovers();
}

/* ─────────────────────────────────────────────
   CARD SCROLL REVEAL — IntersectionObserver
   Much more reliable than ScrollTrigger for cards
   already near/in the viewport on load.
───────────────────────────────────────────── */
function setupCardReveal() {
  const cards = document.querySelectorAll('.space-card');
  if (!cards.length) return;

  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const card = entry.target;
      const idx  = parseInt(card.dataset.revealIdx || '0');
      gsap.to(card, {
        opacity: 1, y: 0,
        duration: .65,
        delay: (idx % 4) * .08,
        ease: 'settle',
        onComplete() { io.unobserve(card); }
      });
    });
  }, { threshold: 0.05, rootMargin: '0px 0px -20px 0px' });

  cards.forEach((card, i) => {
    card.dataset.revealIdx = i;
    io.observe(card);
  });
}

/* ─────────────────────────────────────────────
   ACTION BUTTON MICRO-INTERACTIONS
───────────────────────────────────────────── */
function initActionBtns() {
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () =>
      anime({ targets: btn, translateY: -3, duration: 200, easing: 'easeOutCubic' }));
    btn.addEventListener('mouseleave', () =>
      anime({ targets: btn, translateY: 0, duration: 420, easing: 'easeOutElastic(1,.6)' }));
    btn.addEventListener('mousedown', () =>
      anime({ targets: btn, scale: .96, duration: 90, easing: 'easeOutQuad' }));
    btn.addEventListener('mouseup', () =>
      anime({ targets: btn, scale: 1, duration: 300, easing: 'easeOutElastic(1,.7)' }));
  });
}

/* ─────────────────────────────────────────────
   CARD HOVER LIFT
───────────────────────────────────────────── */
function initCardHovers() {
  document.querySelectorAll('.space-card').forEach(card => {
    card.addEventListener('mouseenter', () =>
      anime({ targets: card, translateY: -4, duration: 240, easing: 'easeOutCubic' }));
    card.addEventListener('mouseleave', () =>
      anime({ targets: card, translateY: 0, duration: 500, easing: 'easeOutElastic(1,.65)' }));
  });
}

/* ─────────────────────────────────────────────
   CHAT BAR
───────────────────────────────────────────── */
function chatBarKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doStartChat(); }
}

function autoResizeChatBar(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

async function doStartChat() {
  const inp = document.getElementById('chat-bar-input');
  const msg = inp.value.trim();
  if (!msg) { inp.focus(); return; }

  const btn = document.getElementById('chat-send');
  btn.disabled = true; inp.disabled = true;

  // pulse send button
  anime({ targets: btn, scale: [1,.88,1.06,1], duration: 400, easing: 'easeOutElastic(1,.7)' });

  prog('Starting session…', 35);
  const topic = msg.length > 60 ? msg.slice(0,60) + '…' : msg;
  const sd = await api('/api/session/create', {
    topic, category: '', knowledge_level: 'intermediate',
    learning_goal: '', time_available: '5-10 hrs/week',
    learning_style: 'reading', content_type: 'chat'
  });

  btn.disabled = false; inp.disabled = false;
  if (!sd?.ok) { toast(sd?.error || 'Failed.'); hideProg(); return; }
  prog('Done!', 100);
  setTimeout(() => { hideProg(); location.href = `/chat/${sd.sid}?first=${encodeURIComponent(msg)}`; }, 350);
}

/* ─────────────────────────────────────────────
   SIDEBAR — GSAP xPercent, visibility toggle
───────────────────────────────────────────── */
let _sidebarOpen = false;
let _sbTween = null;
const _sb = document.getElementById('sidebar');
const _ov = document.getElementById('sidebar-overlay');

function openSidebar() {
  if (_sidebarOpen) return;
  _sidebarOpen = true;
  if (_sbTween) _sbTween.kill();

  _sb.classList.add('is-visible');
  _ov.classList.add('open');
  document.body.style.overflow = 'hidden';

  _sbTween = gsap.to(_sb, { xPercent: 0, duration: .4, ease: 'settle' });

  // stagger nav items in
  anime({
    targets: '.sidebar-link',
    opacity: [0, 1], translateX: [-14, 0],
    duration: 320, delay: anime.stagger(50, { start: 160 }),
    easing: 'easeOutCubic'
  });
}

function closeSidebar() {
  if (!_sidebarOpen) return;
  _sidebarOpen = false;
  if (_sbTween) _sbTween.kill();
  _ov.classList.remove('open');
  document.body.style.overflow = '';
  _sbTween = gsap.to(_sb, {
    xPercent: -100, duration: .3, ease: 'power3.in',
    onComplete: () => _sb.classList.remove('is-visible')
  });
}

/* ─────────────────────────────────────────────
   MODALS
───────────────────────────────────────────── */
function openModal(id) {
  const bg  = document.getElementById(id);
  const box = bg.querySelector('.modal');
  bg.classList.add('is-open');
  // start from transparent for bg and box
  anime.set(bg,  { opacity: 0 });
  anime.set(box, { opacity: 0, translateY: 18, scale: .94 });
  anime({ targets: bg,  opacity: 1, duration: 220, easing: 'easeOutQuad' });
  anime({ targets: box, opacity: 1, translateY: 0, scale: 1, duration: 340, easing: 'easeOutCubic' });
  setTimeout(() => {
    const f = box.querySelector('input:not([type=file]),textarea,select');
    if (f) f.focus();
  }, 200);
}

function closeModal(id) {
  const bg  = document.getElementById(id);
  const box = bg.querySelector('.modal');
  anime({ targets: box, opacity: 0, translateY: 8, scale: .96, duration: 190, easing: 'easeInQuad' });
  anime({ targets: bg, opacity: 0, duration: 240, easing: 'easeInQuad',
    complete: () => bg.classList.remove('is-open')
  });
}

function bgClose(e, id) {
  if (e.target === document.getElementById(id)) closeModal(id);
}

/* ─────────────────────────────────────────────
   FILE UPLOAD
───────────────────────────────────────────── */
const _dz = document.getElementById('drop-zone');
if (_dz) {
  ['dragover','dragenter'].forEach(ev => _dz.addEventListener(ev, e => { e.preventDefault(); _dz.classList.add('is-drag'); }));
  ['dragleave','dragend' ].forEach(ev => _dz.addEventListener(ev, () => _dz.classList.remove('is-drag')));
  _dz.addEventListener('drop', e => { e.preventDefault(); _dz.classList.remove('is-drag'); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
}
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { closeModal('modal-upload'); handleFile(f); } });
function onFilePick(inp) { if (inp.files[0]) { closeModal('modal-upload'); handleFile(inp.files[0]); } }

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf','txt'].includes(ext)) { toast('Only PDF and TXT files are supported.'); return; }
  prog('Creating space…', 15);
  const topic = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g,' ');
  const sd = await api('/api/session/create', { topic, category:'', knowledge_level:'intermediate', learning_goal:'', time_available:'5-10 hrs/week', learning_style:'reading', content_type: ext==='pdf'?'pdf':'text' });
  if (!sd.ok) { toast('Failed.'); hideProg(); return; }
  prog('Uploading…', 48);
  const fd = new FormData(); fd.append('file', file);
  const ud = await fetch(`/api/session/${sd.sid}/upload_doc`, { method:'POST', body:fd }).then(r=>r.json());
  if (!ud.ok) { toast('Upload failed.'); hideProg(); return; }
  prog(`Processed · ${ud.chunks} chunks`, 100);
  setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
}

/* ─────────────────────────────────────────────
   LINK / YOUTUBE
───────────────────────────────────────────── */
async function doLink() {
  const url = document.getElementById('link-url')?.value.trim();
  if (!url) { toast('Enter a URL first.'); return; }
  const goBtn = document.querySelector('#modal-link .mbtn-go');
  if (goBtn) { goBtn.textContent = 'Fetching…'; goBtn.disabled = true; }
  closeModal('modal-link');
  prog('Creating space…', 15);
  try {
    const sd = await api('/api/session/create', { topic:'YouTube Video', category:'', knowledge_level:'intermediate', learning_goal:'', time_available:'5-10 hrs/week', learning_style:'visual', content_type:'youtube' });
    if (!sd?.ok) { toast(sd?.error||'Failed.'); hideProg(); resetLinkBtn(); return; }
    prog('Fetching transcript…', 45);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    let yd;
    try {
      const res = await fetch(`/api/session/${sd.sid}/add_youtube`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url}), signal:ctrl.signal });
      clearTimeout(t); yd = await res.json();
    } catch(err) { clearTimeout(t); toast(err.name==='AbortError'?'Timed out.':'Network error.'); hideProg(); resetLinkBtn(); return; }
    if (!yd?.ok) { toast(yd?.error||'Could not fetch transcript.'); hideProg(); resetLinkBtn(); return; }
    prog('Indexing…', 85);
    await new Promise(r=>setTimeout(r,400));
    prog('Done!', 100);
    setTimeout(() => { hideProg(); location.href=`/session/${sd.sid}`; }, 500);
  } catch(e) { toast('Something went wrong.'); hideProg(); resetLinkBtn(); }
}
function resetLinkBtn() { const b=document.querySelector('#modal-link .mbtn-go'); if(b){b.textContent='Start learning →';b.disabled=false;} }
document.getElementById('link-url')?.addEventListener('keydown', e => { if(e.key==='Enter') doLink(); });

/* ─────────────────────────────────────────────
   PASTE
───────────────────────────────────────────── */
async function doPaste() {
  const title = document.getElementById('paste-title')?.value.trim() || 'Pasted Content';
  const text  = document.getElementById('paste-text')?.value.trim();
  if (!text) { toast('Paste some content first.'); return; }
  closeModal('modal-paste');
  prog('Creating space…', 20);
  const sd = await api('/api/session/create', { topic:title, category:'', knowledge_level:'intermediate', learning_goal:'', time_available:'5-10 hrs/week', learning_style:'reading', content_type:'text' });
  if (!sd.ok) { toast('Failed.'); hideProg(); return; }
  prog('Processing…', 60);
  const fd = new FormData();
  fd.append('file', new File([text], title+'.txt', {type:'text/plain'}));
  const ud = await fetch(`/api/session/${sd.sid}/upload_doc`, {method:'POST',body:fd}).then(r=>r.json());
  if (!ud.ok) { toast('Failed.'); hideProg(); return; }
  prog('Done!', 100);
  setTimeout(() => { hideProg(); location.href=`/session/${sd.sid}`; }, 500);
}

/* ─────────────────────────────────────────────
   CREATE TOPIC SPACE
───────────────────────────────────────────── */
async function doCreate() {
  const topic = document.getElementById('m-topic')?.value.trim();
  if (!topic) { document.getElementById('m-topic')?.focus(); return; }
  const btn = document.getElementById('create-btn');
  btn.textContent='Creating…'; btn.disabled=true;
  const d = await api('/api/session/create', {
    topic,
    category:        document.getElementById('m-cat')?.value||'',
    knowledge_level: document.getElementById('m-lvl')?.value||'intermediate',
    learning_goal:   document.getElementById('m-goal')?.value||'',
    time_available:'5-10 hrs/week', learning_style:'reading', content_type:'topic'
  });
  if (d.ok) { location.href=`/session/${d.sid}`; }
  else { toast(d.error||'Failed.'); btn.textContent='Create Space →'; btn.disabled=false; }
}

/* ─────────────────────────────────────────────
   DELETE CARD
───────────────────────────────────────────── */
async function deleteCard(e, sid) {
  e.preventDefault(); e.stopPropagation();
  const card = document.querySelector(`[data-sid="${sid}"]`);
  const r = await fetch(`/api/session/${sid}/delete`,{method:'DELETE'}).then(r=>r.json());
  if (r.ok) {
    anime({ targets:card, opacity:0, scale:.92, translateY:-8, duration:260, easing:'easeInCubic', complete:()=>card.remove() });
    toast('Deleted.');
  } else toast('Delete failed.');
}

/* ─────────────────────────────────────────────
   CONTEXT MENU
───────────────────────────────────────────── */
let _ctxSid = null;
document.querySelectorAll('.space-card').forEach(c =>
  c.addEventListener('contextmenu', e => openCtx(e, c.dataset.sid)));

function openCtx(e, sid) {
  e.preventDefault(); e.stopPropagation();
  _ctxSid = sid;
  const m = document.getElementById('ctx-menu');
  m.style.left = Math.min(e.pageX, window.innerWidth-170)+'px';
  m.style.top  = e.pageY+'px';
  m.classList.add('is-open');
  anime.set(m, { opacity:0, scale:.9, translateY:-4 });
  anime({ targets:m, opacity:1, scale:1, translateY:0, duration:190, easing:'easeOutCubic' });
}
function ctxGo() { if(_ctxSid) location.href=`/session/${_ctxSid}`; closeCtx(); }
async function ctxDelete() {
  if(!_ctxSid) return;
  const sid=_ctxSid; closeCtx();
  const r=await fetch(`/api/session/${sid}/delete`,{method:'DELETE'}).then(r=>r.json());
  if(r.ok){ const el=document.querySelector(`[data-sid="${sid}"]`); if(el) anime({targets:el,opacity:0,scale:.9,duration:260,easing:'easeInCubic',complete:()=>el.remove()}); toast('Deleted.'); }
}
function closeCtx() {
  const m=document.getElementById('ctx-menu');
  anime({ targets:m, opacity:0, scale:.94, duration:150, easing:'easeInQuad', complete:()=>m.classList.remove('is-open') });
  _ctxSid=null;
}
document.addEventListener('click', e => {
  const m=document.getElementById('ctx-menu');
  if(m?.classList.contains('is-open')&&!m.contains(e.target)) closeCtx();
});

/* ─────────────────────────────────────────────
   ESC KEY
───────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if(e.key!=='Escape') return;
  ['modal-upload','modal-link','modal-paste','modal-topic','modal-audio'].forEach(id => {
    if(document.getElementById(id)?.classList.contains('is-open')) closeModal(id);
  });
  closeCtx();
  if(_sidebarOpen) closeSidebar();
});

/* ─────────────────────────────────────────────
   PROGRESS
───────────────────────────────────────────── */
function prog(label, pct) {
  const box = document.getElementById('prog-box');
  box.classList.add('is-on');
  anime({ targets:box, opacity:1, translateY:0, duration:280, easing:'easeOutCubic' });
  document.getElementById('prog-label').textContent = label;
  document.getElementById('prog-fill').style.width  = pct+'%';
  document.getElementById('prog-sub').textContent   = pct+'% complete';
}
function hideProg() {
  const box = document.getElementById('prog-box');
  anime({ targets:box, opacity:0, translateY:12, duration:240, easing:'easeInQuad',
    complete:()=>box.classList.remove('is-on') });
}

/* ─────────────────────────────────────────────
   TOAST
───────────────────────────────────────────── */
let _tt;
function toast(msg, dur=3000) {
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('is-on');
  clearTimeout(_tt);
  _tt=setTimeout(()=>el.classList.remove('is-on'),dur);
}

/* ─────────────────────────────────────────────
   API HELPER
───────────────────────────────────────────── */
async function api(url, body) {
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}

/* ─────────────────────────────────────────────
   LOGOUT
───────────────────────────────────────────── */
async function logout() { await fetch('/api/auth/logout',{method:'POST'}); location.href='/'; }

/* ─────────────────────────────────────────────
   MODEL TOGGLE
───────────────────────────────────────────── */
let _modelOpen = false;

async function initModelToggle() {
  try {
    const data = await fetch('/api/user/models').then(r=>r.json());
    if (!data.ok) return;
    const activeId = document.querySelector('.mt-item.active')?.dataset.id;
    const active   = data.models.find(m=>m.id===activeId)
                  || data.models.find(m=>m.available)
                  || data.models[0];
    if (active) {
      document.getElementById('mt-label').textContent    = active.label;
      document.getElementById('mt-dot').style.background = active.badge_color;
    }
  } catch(e) {}
}

function toggleModelMenu() {
  _modelOpen = !_modelOpen;
  const menu = document.getElementById('mt-menu');
  const trig = document.getElementById('mt-trigger');
  if (_modelOpen) {
    menu.classList.add('open'); trig.classList.add('open');
    anime.set(menu, { opacity:0, translateY:-6, scale:.96 });
    anime({ targets:menu, opacity:1, translateY:0, scale:1, duration:200, easing:'easeOutCubic' });
  } else {
    anime({ targets:menu, opacity:0, translateY:-4, scale:.97, duration:160, easing:'easeInQuad',
      complete:()=>{ menu.classList.remove('open'); trig.classList.remove('open'); }
    });
  }
}

async function selectModel(id, label, color) {
  document.getElementById('mt-label').textContent    = label;
  document.getElementById('mt-dot').style.background = color;
  document.querySelectorAll('.mt-item').forEach(b=>b.classList.toggle('active',b.dataset.id===id));
  toggleModelMenu();
  try {
    const data = await fetch('/api/user/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_id:id})}).then(r=>r.json());
    toast(data.ok?`Switched to ${label}`:(data.error||'Failed'));
  } catch { toast('Network error'); }
}

document.addEventListener('click', e => {
  if (!_modelOpen) return;
  if (!document.getElementById('model-toggle')?.contains(e.target)) toggleModelMenu();
});

/* ─────────────────────────────────────────────
   AUDIO LECTURES
───────────────────────────────────────────── */
let _selectedAudioFile = null;
let _recordedBlob      = null;
let _mediaRecorder     = null;
let _audioChunks       = [];
let _recTimerInterval  = null;
let _recSeconds        = 0;
let _recBarInterval    = null;

function switchAudioTab(tab) {
  document.getElementById('atab-upload').classList.toggle('active', tab === 'upload');
  document.getElementById('atab-record').classList.toggle('active', tab === 'record');
  document.getElementById('audio-upload-pane').style.display = tab === 'upload' ? '' : 'none';
  document.getElementById('audio-record-pane').style.display = tab === 'record' ? '' : 'none';
}

function onAudioFilePick(inp) {
  const f = inp.files[0]; if (!f) return;
  _selectedAudioFile = f;
  document.getElementById('audio-sel-name').textContent = f.name;
  document.getElementById('audio-sel-file').style.display = 'flex';
  document.getElementById('audio-drop-zone').style.display = 'none';
  if (!document.getElementById('audio-title').value.trim())
    document.getElementById('audio-title').value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

function onAudioDrop(e) {
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  if (!['mp3','wav','m4a','ogg','flac','webm','mp4'].includes(ext)) {
    toast('Unsupported format. Use MP3, WAV, M4A, OGG, FLAC, or WEBM.'); return;
  }
  const picker = document.getElementById('audio-file-picker');
  // Synthetic assignment for display only; store the File reference directly
  _selectedAudioFile = f;
  document.getElementById('audio-sel-name').textContent = f.name;
  document.getElementById('audio-sel-file').style.display = 'flex';
  document.getElementById('audio-drop-zone').style.display = 'none';
  if (!document.getElementById('audio-title').value.trim())
    document.getElementById('audio-title').value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

function clearAudioFile() {
  _selectedAudioFile = null;
  document.getElementById('audio-file-picker').value = '';
  document.getElementById('audio-sel-file').style.display = 'none';
  document.getElementById('audio-drop-zone').style.display = '';
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    _audioChunks = [];
    _recSeconds  = 0;
    document.getElementById('rec-timer').textContent = '0:00';

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';

    _mediaRecorder = new MediaRecorder(stream, { mimeType });
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _audioChunks.push(e.data); };
    _mediaRecorder.onstop = () => {
      _recordedBlob = new Blob(_audioChunks, { type: mimeType });
      const url = URL.createObjectURL(_recordedBlob);
      const aud = document.getElementById('rec-audio');
      aud.src = url;
      document.getElementById('rec-preview').style.display = '';
      stream.getTracks().forEach(t => t.stop());
    };
    _mediaRecorder.start(200);

    // UI
    document.getElementById('rec-start-btn').style.display = 'none';
    document.getElementById('rec-stop-btn').style.display  = '';
    document.getElementById('rec-clear-btn').style.display = 'none';
    document.getElementById('rec-preview').style.display   = 'none';

    _recTimerInterval = setInterval(() => {
      _recSeconds++;
      const m = Math.floor(_recSeconds / 60), s = _recSeconds % 60;
      document.getElementById('rec-timer').textContent = `${m}:${String(s).padStart(2,'0')}`;
    }, 1000);

    _animateRecBars(true);
  } catch(err) {
    toast('Microphone access denied — please allow microphone in browser settings.');
  }
}

function stopRecording() {
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
  clearInterval(_recTimerInterval);
  _animateRecBars(false);
  document.getElementById('rec-start-btn').style.display = '';
  document.getElementById('rec-start-btn').innerHTML = '<i data-lucide="mic" width="14" height="14"></i> Record Again';
  document.getElementById('rec-stop-btn').style.display  = 'none';
  document.getElementById('rec-clear-btn').style.display = '';
  lucide.createIcons();
}

function clearRecording() {
  _recordedBlob = null; _audioChunks = []; _recSeconds = 0;
  document.getElementById('rec-audio').src = '';
  document.getElementById('rec-preview').style.display   = 'none';
  document.getElementById('rec-clear-btn').style.display = 'none';
  document.getElementById('rec-start-btn').style.display = '';
  document.getElementById('rec-start-btn').innerHTML = '<i data-lucide="mic" width="14" height="14"></i> Start Recording';
  document.getElementById('rec-timer').textContent = '0:00';
  lucide.createIcons();
}

function _animateRecBars(on) {
  const bars = document.querySelectorAll('.rec-bar');
  clearInterval(_recBarInterval);
  if (!on) { bars.forEach(b => { b.style.height = '4px'; b.style.opacity = '.3'; }); return; }
  _recBarInterval = setInterval(() => {
    bars.forEach(b => {
      b.style.height  = (Math.random() * 28 + 4) + 'px';
      b.style.opacity = (0.4 + Math.random() * 0.6).toFixed(2);
    });
  }, 90);
}

async function doAudio() {
  const title  = document.getElementById('audio-title')?.value.trim() || 'Audio Lecture';
  const isUploadTab = document.getElementById('audio-upload-pane')?.style.display !== 'none';
  let audioFile = null;

  if (isUploadTab) {
    audioFile = _selectedAudioFile;
    if (!audioFile) { toast('Please select an audio file first.'); return; }
  } else {
    if (!_recordedBlob) { toast('Please record audio first.'); return; }
    const ext = _recordedBlob.type.includes('webm') ? 'webm'
              : _recordedBlob.type.includes('ogg')  ? 'ogg' : 'webm';
    audioFile = new File([_recordedBlob], `recording.${ext}`, { type: _recordedBlob.type });
  }

  const btn = document.getElementById('audio-go-btn');
  btn.textContent = 'Processing…'; btn.disabled = true;
  closeModal('modal-audio');
  prog('Creating space…', 15);

  const sd = await api('/api/session/create', {
    topic: title, category: '', knowledge_level: 'intermediate',
    learning_goal: '', time_available: '5-10 hrs/week',
    learning_style: 'listening', content_type: 'audio'
  });
  if (!sd?.ok) { toast(sd?.error || 'Failed to create session.'); hideProg(); btn.textContent='Transcribe & Study →'; btn.disabled=false; return; }

  prog('Transcribing audio with Voxtral…', 38);
  try {
    const fd = new FormData();
    fd.append('audio', audioFile);
    fd.append('title', title);
    const res = await fetch(`/api/session/${sd.sid}/upload_audio`, { method: 'POST', body: fd });
    const ud  = await res.json();
    if (!ud.ok) {
      toast(ud.error || 'Transcription failed. Check your Mistral API key.');
      hideProg(); btn.textContent='Transcribe & Study →'; btn.disabled=false;
      // Clean up orphan session
      fetch(`/api/session/${sd.sid}/delete`, { method: 'DELETE' }).catch(()=>{});
      return;
    }
    prog('Indexing…', 85);
    await new Promise(r => setTimeout(r, 300));
    prog('Done!', 100);
    setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
  } catch(e) {
    toast('Network error during transcription.');
    hideProg();
  }
  btn.textContent = 'Transcribe & Study →'; btn.disabled = false;
}