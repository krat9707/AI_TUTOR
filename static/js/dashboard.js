/* dashboard.js — requires GSAP 3 + CustomEase loaded before this */

// ─── CUSTOM EASE ───
CustomEase.create("smooth", "M0,0 C0.16,0 0.17,0.96 0.48,0.98 0.7,1 0.84,1 1,1");
CustomEase.create("pop",    "M0,0 C0.12,0 0.16,1.12 0.5,1.04 0.7,1 0.84,1 1,1");

// ─── PAGE LOADER ───
const loader = document.getElementById('page-loader');
const loaderLogo = loader.querySelector('.loader-logo');

const loaderTL = gsap.timeline({
  onComplete: () => {
    gsap.to(loader, {
      autoAlpha: 0, duration: 0.5, ease: 'power2.inOut',
      onComplete: () => { loader.remove(); runEntrance(); }
    });
  }
});

loaderTL
  .to(loaderLogo, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out' })
  .to(loaderLogo, { autoAlpha: 0, y: -10, duration: 0.35, ease: 'power2.in', delay: 0.3 });

// ─── ENTRANCE SEQUENCE ───
function runEntrance() {
  // Topbar slides in
  gsap.to('.topbar', {
    y: 0, duration: 0.6, ease: 'smooth', delay: 0.0
  });

  const tl = gsap.timeline({ delay: 0.15 });

  tl
    // Title fades up with letter spacing collapse
    .fromTo('.hero-title',
      { opacity: 0, y: 30, letterSpacing: '2px' },
      { opacity: 1, y: 0, letterSpacing: '-0.8px', duration: 0.7, ease: 'smooth' }
    )
    // Action cards stagger in
    .fromTo('.ac',
      { opacity: 0, y: 22, scale: 0.96 },
      { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.06, ease: 'pop' },
      '-=0.4'
    )
    // Search bar
    .fromTo('.search-wrap',
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.45, ease: 'smooth' },
      '-=0.25'
    )
    // Spaces bar
    .fromTo('.spaces-bar',
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.35, ease: 'smooth' },
      '-=0.2'
    )
    // Grid tiles
    .fromTo('.new-tile, .space-card',
      { opacity: 0, y: 16, scale: 0.97 },
      { opacity: 1, y: 0, scale: 1, duration: 0.4, stagger: 0.055, ease: 'pop' },
      '-=0.2'
    );

  const sm = document.querySelector('.show-more-wrap');
  if (sm) tl.fromTo(sm, { opacity: 0 }, { opacity: 1, duration: 0.3 }, '-=0.1');
}

// ─── CARD HOVER PARALLAX ───
document.querySelectorAll('.ac').forEach(card => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / (rect.width / 2);
    const dy = (e.clientY - cy) / (rect.height / 2);
    gsap.to(card, {
      rotateX: -dy * 4, rotateY: dx * 4, scale: 1.03,
      duration: 0.3, ease: 'power2.out',
      transformPerspective: 600, transformOrigin: 'center'
    });
    card.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
    card.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
  });
  card.addEventListener('mouseleave', () => {
    gsap.to(card, {
      rotateX: 0, rotateY: 0, scale: 1,
      duration: 0.5, ease: 'elastic.out(1, 0.7)',
      transformPerspective: 600
    });
  });
});

// ─── SPACE CARD HOVER ───
document.querySelectorAll('.space-card').forEach(card => {
  card.addEventListener('mouseenter', () => {
    gsap.to(card, { y: -4, duration: 0.25, ease: 'power2.out' });
  });
  card.addEventListener('mouseleave', () => {
    gsap.to(card, { y: 0, duration: 0.35, ease: 'elastic.out(1, 0.6)' });
  });
});

// ─── SEARCH BUTTON HOVER ───
const searchBtn = document.querySelector('.search-btn');
if (searchBtn) {
  searchBtn.addEventListener('mouseenter', () => {
    gsap.to(searchBtn, { scale: 1.12, duration: 0.22, ease: 'back.out(2)' });
  });
  searchBtn.addEventListener('mouseleave', () => {
    gsap.to(searchBtn, { scale: 1, duration: 0.3, ease: 'elastic.out(1, 0.6)' });
  });
}

// ─── MODAL SYSTEM ───
function openModal(id) {
  const bg = document.getElementById(id);
  const box = bg.querySelector('.modal');
  bg.classList.add('is-open');
  gsap.fromTo(bg, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: 'power2.out' });
  gsap.fromTo(box,
    { opacity: 0, scale: 0.9, y: 20 },
    { opacity: 1, scale: 1,   y: 0,  duration: 0.38, ease: 'pop' }
  );
  const first = box.querySelector('input:not([type=file]),textarea,select');
  if (first) setTimeout(() => first.focus(), 200);
}

function closeModal(id) {
  const bg = document.getElementById(id);
  const box = bg.querySelector('.modal');
  gsap.to(box, { opacity: 0, scale: 0.92, y: 12, duration: 0.22, ease: 'power2.in' });
  gsap.to(bg, {
    opacity: 0, duration: 0.28, ease: 'power2.in',
    onComplete: () => bg.classList.remove('is-open')
  });
}

function bgClose(e, id) {
  if (e.target === document.getElementById(id)) closeModal(id);
}

// ─── SEARCH ───
document.querySelector('.search-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

function doSearch() {
  const q = document.querySelector('.search-input').value.trim();
  if (!q) return;
  const inp = document.getElementById('m-topic');
  if (inp) inp.value = q;
  openModal('modal-topic');
}

// ─── DRAG & DROP ───
const dropZone = document.getElementById('drop-zone');
if (dropZone) {
  ['dragover','dragenter'].forEach(e =>
    dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.add('is-drag'); })
  );
  ['dragleave','dragend'].forEach(e =>
    dropZone.addEventListener(e, () => dropZone.classList.remove('is-drag'))
  );
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('is-drag');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
}

// Body-level drop
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) { closeModal('modal-upload'); handleFile(f); }
});

function onFilePick(inp) {
  if (inp.files[0]) { closeModal('modal-upload'); handleFile(inp.files[0]); }
}

// ─── FILE HANDLER ───
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf','txt'].includes(ext)) { toast('Only PDF and TXT supported.'); return; }
  prog('Creating space…', 15);
  const topic = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const sd = await api('/api/session/create', {
    topic, category: '', knowledge_level: 'intermediate',
    learning_goal: '', time_available: '5-10 hrs/week',
    learning_style: 'reading', provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    content_type: ext === 'pdf' ? 'pdf' : 'text'
  });
  if (!sd.ok) { toast('Failed to create space.'); hideProg(); return; }
  prog('Uploading file…', 48);
  const fd = new FormData(); fd.append('file', file);
  const ud = await fetch(`/api/session/${sd.sid}/upload_doc`, { method: 'POST', body: fd }).then(r => r.json());
  if (!ud.ok) { toast('Upload failed.'); hideProg(); return; }
  prog('Done!', 100);
  setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
}

// ─── LINK ───
async function doLink() {
  const url = document.getElementById('link-url')?.value.trim();
  if (!url) { toast('Enter a URL first.'); return; }

  const goBtn = document.querySelector('#modal-link .mbtn-go');
  if (goBtn) { goBtn.textContent = 'Fetching…'; goBtn.disabled = true; }

  closeModal('modal-link');
  prog('Creating space…', 15);

  try {
    const sd = await api('/api/session/create', {
      topic: 'YouTube Video', category: '', knowledge_level: 'intermediate',
      learning_goal: '', time_available: '5-10 hrs/week',
      learning_style: 'visual', provider: 'groq',
      model: 'llama-3.3-70b-versatile', content_type: 'youtube'
    });

    if (!sd || !sd.ok) {
      toast(sd?.error || 'Failed to create space.');
      hideProg(); resetLinkBtn(); return;
    }

    prog('Fetching transcript…', 45);

    // Give backend time — transcript fetch can take 5-15s for long videos
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    let yd;
    try {
      const res = await fetch(`/api/session/${sd.sid}/add_youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      yd = await res.json();
    } catch (fetchErr) {
      clearTimeout(timeout);
      if (fetchErr.name === 'AbortError') {
        toast('Request timed out. The video may have no captions — try another URL.');
      } else {
        toast('Network error while fetching transcript.');
      }
      hideProg(); resetLinkBtn(); return;
    }

    if (!yd || !yd.ok) {
      toast(yd?.error || 'Could not fetch transcript. Try a video with captions enabled.');
      hideProg(); resetLinkBtn(); return;
    }

    prog('Indexing content…', 85);
    await new Promise(r => setTimeout(r, 400)); // brief visual pause

    prog('Done!', 100);
    setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);

  } catch (err) {
    toast('Something went wrong. Please try again.');
    hideProg(); resetLinkBtn();
  }
}

function resetLinkBtn() {
  const goBtn = document.querySelector('#modal-link .mbtn-go');
  if (goBtn) { goBtn.textContent = 'Start learning →'; goBtn.disabled = false; }
}

document.getElementById('link-url')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') doLink();
});

// ─── PASTE ───
async function doPaste() {
  const title = document.getElementById('paste-title')?.value.trim() || 'Pasted Content';
  const text  = document.getElementById('paste-text')?.value.trim();
  if (!text) { toast('Paste some content first.'); return; }
  closeModal('modal-paste');
  prog('Creating space…', 20);
  const sd = await api('/api/session/create', {
    topic: title, category: '', knowledge_level: 'intermediate',
    learning_goal: '', time_available: '5-10 hrs/week',
    learning_style: 'reading', provider: 'groq',
    model: 'llama-3.3-70b-versatile', content_type: 'text'
  });
  if (!sd.ok) { toast('Failed.'); hideProg(); return; }
  prog('Processing text…', 60);
  const blob = new Blob([text], { type: 'text/plain' });
  const f = new File([blob], title + '.txt', { type: 'text/plain' });
  const fd = new FormData(); fd.append('file', f);
  const ud = await fetch(`/api/session/${sd.sid}/upload_doc`, { method: 'POST', body: fd }).then(r => r.json());
  if (!ud.ok) { toast('Failed.'); hideProg(); return; }
  prog('Done!', 100);
  setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
}

// ─── CREATE TOPIC SPACE ───
async function doCreate() {
  const topic = document.getElementById('m-topic')?.value.trim();
  if (!topic) { document.getElementById('m-topic')?.focus(); return; }
  const btn = document.getElementById('create-btn');
  btn.textContent = 'Creating…'; btn.disabled = true;
  const d = await api('/api/session/create', {
    topic,
    category:        document.getElementById('m-cat')?.value   || '',
    knowledge_level: document.getElementById('m-lvl')?.value   || 'intermediate',
    learning_goal:   document.getElementById('m-goal')?.value  || '',
    time_available:  document.getElementById('m-time')?.value  || '5-10 hrs/week',
    learning_style:  document.getElementById('m-style')?.value || 'reading',
    provider: 'groq', model: 'llama-3.3-70b-versatile', content_type: 'topic'
  });
  if (d.ok) {
    location.href = `/session/${d.sid}`;
  } else {
    toast(d.error || 'Failed.');
    btn.textContent = 'Create Space →'; btn.disabled = false;
  }
}

// ─── CONTEXT MENU ───
let _ctxSid = null;

function openCtx(e, sid) {
  e.preventDefault(); e.stopPropagation();
  _ctxSid = sid;
  const m = document.getElementById('ctx-menu');
  m.style.left = Math.min(e.pageX, window.innerWidth - 180) + 'px';
  m.style.top  = e.pageY + 'px';
  m.classList.add('is-open');
  gsap.fromTo(m,
    { autoAlpha: 0, scale: 0.88, y: -6 },
    { autoAlpha: 1, scale: 1,    y: 0,  duration: 0.22, ease: 'pop' }
  );
}

function ctxGo() {
  if (_ctxSid) location.href = `/session/${_ctxSid}`;
  closeCtx();
}

async function ctxDelete() {
  if (!_ctxSid) return;
  const sid = _ctxSid;
  closeCtx();
  const r = await fetch(`/api/session/${sid}/delete`, { method: 'DELETE' }).then(r => r.json());
  if (r.ok) {
    const el = document.querySelector(`[data-sid="${sid}"]`);
    if (el) {
      gsap.to(el, {
        autoAlpha: 0, scale: 0.9, y: -8, duration: 0.3, ease: 'power2.in',
        onComplete: () => el.remove()
      });
    }
    toast('Space deleted.');
  }
}

function closeCtx() {
  const m = document.getElementById('ctx-menu');
  gsap.to(m, {
    autoAlpha: 0, scale: 0.9, duration: 0.15, ease: 'power2.in',
    onComplete: () => m.classList.remove('is-open')
  });
  _ctxSid = null;
}

document.addEventListener('click', e => {
  const m = document.getElementById('ctx-menu');
  if (m && !m.contains(e.target)) closeCtx();
});

// ─── PROGRESS ───
function prog(label, pct) {
  const box = document.getElementById('prog-box');
  box.classList.add('is-on');
  gsap.to(box, { opacity: 1, y: 0, duration: 0.35, ease: 'pop' });
  document.getElementById('prog-label').textContent = label;
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('prog-sub').textContent = pct + '% complete';
}

function hideProg() {
  const box = document.getElementById('prog-box');
  gsap.to(box, {
    opacity: 0, y: 16, duration: 0.28, ease: 'power2.in',
    onComplete: () => box.classList.remove('is-on')
  });
}

// ─── TOAST ───
let _toastTimer;
function toast(msg, dur = 3200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('is-on'), dur);
}

// ─── API HELPER ───
async function api(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

// ─── LOGOUT ───
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/';
}

// ─── ESC ───
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['modal-upload','modal-link','modal-paste','modal-topic'].forEach(id => {
    const el = document.getElementById(id);
    if (el?.classList.contains('is-open')) closeModal(id);
  });
  closeCtx();
});