'use strict';

/* ─────────────────────────────────────────────
   MODEL TOGGLE — initialise label from API
───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initModelToggle();
  setupContextMenus();
});

async function initModelToggle() {
  try {
    const data = await fetch('/api/user/models').then(r => r.json());
    if (!data.ok) return;
    const activeId = window.STUDYAI_PREF_MODEL || '';
    const active = data.models.find(m => m.id === activeId)
                || data.models.find(m => m.available)
                || data.models[0];
    if (active) {
      const label = document.getElementById('mt-label');
      if (label) label.textContent = active.label;
    }
  } catch (e) {}
}

async function selectModel(id, label, color) {
  const el = document.getElementById('mt-label');
  if (el) el.textContent = label;
  try {
    const data = await fetch('/api/user/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: id })
    }).then(r => r.json());
    toast(data.ok ? `Switched to ${label}` : (data.error || 'Failed'));
  } catch { toast('Network error'); }
}

/* ─────────────────────────────────────────────
   CHAT BAR / SEARCH INPUT
───────────────────────────────────────────── */
function chatBarKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doStartChat(); }
}

async function doStartChat() {
  const inp = document.getElementById('chat-bar-input');
  const msg = inp ? inp.value.trim() : '';
  if (!msg) { if (inp) inp.focus(); return; }

  const btn = document.getElementById('chat-send');
  if (btn) btn.disabled = true;
  if (inp) inp.disabled = true;

  prog('Starting session…', 35);
  const topic = msg.length > 60 ? msg.slice(0, 60) + '…' : msg;
  const sd = await api('/api/session/create', {
    topic, category: '', knowledge_level: 'intermediate',
    learning_goal: '', time_available: '5-10 hrs/week',
    learning_style: 'reading', content_type: 'chat'
  });

  if (btn) btn.disabled = false;
  if (inp) inp.disabled = false;
  if (!sd?.ok) { toast(sd?.error || 'Failed.'); hideProg(); return; }
  prog('Done!', 100);
  setTimeout(() => { hideProg(); location.href = `/chat/${sd.sid}?first=${encodeURIComponent(msg)}`; }, 350);
}

/* ─────────────────────────────────────────────
   MODALS
───────────────────────────────────────────── */
function openModal(id) {
  const bg  = document.getElementById(id);
  if (!bg) return;
  const box = bg.querySelector('.modal');
  bg.classList.add('is-open');
  // Simple CSS-transition fallback (no anime.js in new design)
  if (typeof gsap !== 'undefined') {
    gsap.set(bg,  { opacity: 0 });
    gsap.set(box, { opacity: 0, y: 18, scale: 0.94 });
    gsap.to(bg,   { opacity: 1, duration: 0.22, ease: 'power2.out' });
    gsap.to(box,  { opacity: 1, y: 0, scale: 1, duration: 0.34, ease: 'power2.out' });
  }
  setTimeout(() => {
    const f = box.querySelector('input:not([type=file]),textarea,select');
    if (f) f.focus();
  }, 200);
}

function closeModal(id) {
  const bg  = document.getElementById(id);
  if (!bg) return;
  const box = bg.querySelector('.modal');
  if (typeof gsap !== 'undefined') {
    gsap.to(box, { opacity: 0, y: 8, scale: 0.96, duration: 0.19, ease: 'power2.in' });
    gsap.to(bg,  { opacity: 0, duration: 0.24, ease: 'power2.in',
      onComplete: () => bg.classList.remove('is-open') });
  } else {
    bg.classList.remove('is-open');
  }
}

function bgClose(e, id) {
  if (e.target === document.getElementById(id)) closeModal(id);
}

/* ─────────────────────────────────────────────
   FILE UPLOAD
───────────────────────────────────────────── */
const _dz = document.getElementById('drop-zone');
if (_dz) {
  ['dragover', 'dragenter'].forEach(ev => _dz.addEventListener(ev, e => { e.preventDefault(); _dz.classList.add('is-drag'); }));
  ['dragleave', 'dragend' ].forEach(ev => _dz.addEventListener(ev, () => _dz.classList.remove('is-drag')));
  _dz.addEventListener('drop', e => {
    e.preventDefault(); _dz.classList.remove('is-drag');
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  });
}
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) { closeModal('modal-upload'); handleFile(f); }
});
function onFilePick(inp) { if (inp.files[0]) { closeModal('modal-upload'); handleFile(inp.files[0]); } }

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'txt'].includes(ext)) { toast('Only PDF and TXT files are supported.'); return; }
  prog('Creating space…', 15);
  const topic = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const sd = await api('/api/session/create', {
    topic, category: '', knowledge_level: 'intermediate',
    learning_goal: '', time_available: '5-10 hrs/week',
    learning_style: 'reading', content_type: ext === 'pdf' ? 'pdf' : 'text'
  });
  if (!sd.ok) { toast('Failed.'); hideProg(); return; }
  prog('Uploading…', 48);
  const fd = new FormData(); fd.append('file', file);
  const ud = await fetch(`/api/session/${sd.sid}/upload_doc`, { method: 'POST', body: fd }).then(r => r.json());
  if (!ud.ok) { toast('Upload failed.'); hideProg(); return; }
  prog(`Processed · ${ud.chunks} chunks`, 100);
  setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
}

/* ─────────────────────────────────────────────
   YOUTUBE LINK
───────────────────────────────────────────── */
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
      learning_style: 'visual', content_type: 'youtube'
    });
    if (!sd?.ok) { toast(sd?.error || 'Failed.'); hideProg(); resetLinkBtn(); return; }
    prog('Fetching transcript…', 45);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    let yd;
    try {
      const res = await fetch(`/api/session/${sd.sid}/add_youtube`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }), signal: ctrl.signal
      });
      clearTimeout(t); yd = await res.json();
    } catch (err) {
      clearTimeout(t);
      toast(err.name === 'AbortError' ? 'Timed out.' : 'Network error.');
      hideProg(); resetLinkBtn(); return;
    }
    if (!yd?.ok) { toast(yd?.error || 'Could not fetch transcript.'); hideProg(); resetLinkBtn(); return; }
    prog('Indexing…', 85);
    await new Promise(r => setTimeout(r, 400));
    prog('Done!', 100);
    setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
  } catch (e) { toast('Something went wrong.'); hideProg(); resetLinkBtn(); }
}

function resetLinkBtn() {
  const b = document.querySelector('#modal-link .mbtn-go');
  if (b) { b.textContent = 'Start learning →'; b.disabled = false; }
}

document.getElementById('link-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLink(); });

/* ─────────────────────────────────────────────
   PASTE TEXT
───────────────────────────────────────────── */
async function doPaste() {
  const title = document.getElementById('paste-title')?.value.trim() || 'Pasted Content';
  const text  = document.getElementById('paste-text')?.value.trim();
  if (!text) { toast('Paste some content first.'); return; }
  closeModal('modal-paste');
  prog('Creating space…', 20);
  const sd = await api('/api/session/create', {
    topic: title, category: '', knowledge_level: 'intermediate',
    learning_goal: '', time_available: '5-10 hrs/week',
    learning_style: 'reading', content_type: 'text'
  });
  if (!sd.ok) { toast('Failed.'); hideProg(); return; }
  prog('Processing…', 60);
  const fd = new FormData();
  fd.append('file', new File([text], title + '.txt', { type: 'text/plain' }));
  const ud = await fetch(`/api/session/${sd.sid}/upload_doc`, { method: 'POST', body: fd }).then(r => r.json());
  if (!ud.ok) { toast('Failed.'); hideProg(); return; }
  prog('Done!', 100);
  setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
}

/* ─────────────────────────────────────────────
   CREATE TOPIC SPACE
───────────────────────────────────────────── */
async function doCreate() {
  const topic = document.getElementById('m-topic')?.value.trim();
  if (!topic) { document.getElementById('m-topic')?.focus(); return; }
  const btn = document.getElementById('create-btn');
  btn.textContent = 'Creating…'; btn.disabled = true;
  const d = await api('/api/session/create', {
    topic,
    category:        document.getElementById('m-cat')?.value || '',
    knowledge_level: document.getElementById('m-lvl')?.value || 'intermediate',
    learning_goal:   document.getElementById('m-goal')?.value || '',
    time_available: '5-10 hrs/week', learning_style: 'reading', content_type: 'topic'
  });
  if (d.ok) { location.href = `/session/${d.sid}`; }
  else { toast(d.error || 'Failed.'); btn.textContent = 'Create Space →'; btn.disabled = false; }
}

/* ─────────────────────────────────────────────
   DELETE CARD
───────────────────────────────────────────── */
async function deleteCard(e, sid) {
  e.preventDefault(); e.stopPropagation();
  const card = document.querySelector(`[data-sid="${sid}"]`);
  const r = await fetch(`/api/session/${sid}/delete`, { method: 'DELETE' }).then(r => r.json());
  if (r.ok) {
    if (card) {
      if (typeof gsap !== 'undefined') {
        gsap.to(card, {
          opacity: 0, scale: 0.92, y: -8, duration: 0.26, ease: 'power2.in',
          onComplete: () => card.remove()
        });
      } else {
        card.remove();
      }
    }
    toast('Deleted.');
  } else {
    toast('Delete failed.');
  }
}

/* ─────────────────────────────────────────────
   CONTEXT MENU
───────────────────────────────────────────── */
let _ctxSid = null;

function setupContextMenus() {
  document.querySelectorAll('[data-sid]').forEach(c =>
    c.addEventListener('contextmenu', e => openCtx(e, c.dataset.sid)));
}

function openCtx(e, sid) {
  e.preventDefault(); e.stopPropagation();
  _ctxSid = sid;
  const m = document.getElementById('ctx-menu');
  m.style.left = Math.min(e.pageX, window.innerWidth - 170) + 'px';
  m.style.top  = e.pageY + 'px';
  m.classList.add('is-open');
  if (typeof gsap !== 'undefined') {
    gsap.set(m, { opacity: 0, scale: 0.9, y: -4 });
    gsap.to(m, { opacity: 1, scale: 1, y: 0, duration: 0.19, ease: 'power2.out' });
  }
}

function ctxGo() { if (_ctxSid) location.href = `/session/${_ctxSid}`; closeCtx(); }

async function ctxDelete() {
  if (!_ctxSid) return;
  const sid = _ctxSid; closeCtx();
  const r = await fetch(`/api/session/${sid}/delete`, { method: 'DELETE' }).then(r => r.json());
  if (r.ok) {
    const el = document.querySelector(`[data-sid="${sid}"]`);
    if (el) {
      if (typeof gsap !== 'undefined') {
        gsap.to(el, { opacity: 0, scale: 0.9, duration: 0.26, ease: 'power2.in', onComplete: () => el.remove() });
      } else { el.remove(); }
    }
    toast('Deleted.');
  }
}

function closeCtx() {
  const m = document.getElementById('ctx-menu');
  if (!m) return;
  if (typeof gsap !== 'undefined') {
    gsap.to(m, {
      opacity: 0, scale: 0.94, duration: 0.15, ease: 'power2.in',
      onComplete: () => m.classList.remove('is-open')
    });
  } else {
    m.classList.remove('is-open');
  }
  _ctxSid = null;
}

document.addEventListener('click', e => {
  const m = document.getElementById('ctx-menu');
  if (m?.classList.contains('is-open') && !m.contains(e.target)) closeCtx();
});

/* ─────────────────────────────────────────────
   ESC KEY
───────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['modal-upload', 'modal-link', 'modal-paste', 'modal-topic', 'modal-audio'].forEach(id => {
    if (document.getElementById(id)?.classList.contains('is-open')) closeModal(id);
  });
  closeCtx();
});

/* ─────────────────────────────────────────────
   PROGRESS INDICATOR
───────────────────────────────────────────── */
function prog(label, pct) {
  const box = document.getElementById('prog-box');
  box.classList.add('is-on');
  if (typeof gsap !== 'undefined') {
    gsap.to(box, { opacity: 1, y: 0, duration: 0.28, ease: 'power2.out' });
  } else {
    box.style.opacity = '1'; box.style.transform = 'translateY(0)';
  }
  document.getElementById('prog-label').textContent = label;
  document.getElementById('prog-fill').style.width  = pct + '%';
  document.getElementById('prog-sub').textContent   = pct + '% complete';
}

function hideProg() {
  const box = document.getElementById('prog-box');
  if (typeof gsap !== 'undefined') {
    gsap.to(box, {
      opacity: 0, y: 12, duration: 0.24, ease: 'power2.in',
      onComplete: () => box.classList.remove('is-on')
    });
  } else {
    box.classList.remove('is-on');
  }
}

/* ─────────────────────────────────────────────
   TOAST
───────────────────────────────────────────── */
let _tt;
function toast(msg, dur = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('is-on'), dur);
}

/* ─────────────────────────────────────────────
   API HELPER
───────────────────────────────────────────── */
async function api(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

/* ─────────────────────────────────────────────
   LOGOUT
───────────────────────────────────────────── */
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/';
}

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
  const f = e.dataTransfer.files[0]; if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  if (!['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm', 'mp4'].includes(ext)) {
    toast('Unsupported format. Use MP3, WAV, M4A, OGG, FLAC, or WEBM.'); return;
  }
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
    _audioChunks = []; _recSeconds = 0;
    document.getElementById('rec-timer').textContent = '0:00';

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';

    _mediaRecorder = new MediaRecorder(stream, { mimeType });
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _audioChunks.push(e.data); };
    _mediaRecorder.onstop = () => {
      _recordedBlob = new Blob(_audioChunks, { type: mimeType });
      const url = URL.createObjectURL(_recordedBlob);
      document.getElementById('rec-audio').src = url;
      document.getElementById('rec-preview').style.display = '';
      stream.getTracks().forEach(t => t.stop());
    };
    _mediaRecorder.start(200);

    document.getElementById('rec-start-btn').style.display = 'none';
    document.getElementById('rec-stop-btn').style.display  = '';
    document.getElementById('rec-clear-btn').style.display = 'none';
    document.getElementById('rec-preview').style.display   = 'none';

    _recTimerInterval = setInterval(() => {
      _recSeconds++;
      const m = Math.floor(_recSeconds / 60), s = _recSeconds % 60;
      document.getElementById('rec-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);

    _animateRecBars(true);
  } catch (err) {
    toast('Microphone access denied — please allow microphone in browser settings.');
  }
}

function stopRecording() {
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
  clearInterval(_recTimerInterval);
  _animateRecBars(false);
  document.getElementById('rec-start-btn').style.display = '';
  document.getElementById('rec-start-btn').innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">mic</span> Record Again';
  document.getElementById('rec-stop-btn').style.display  = 'none';
  document.getElementById('rec-clear-btn').style.display = '';
}

function clearRecording() {
  _recordedBlob = null; _audioChunks = []; _recSeconds = 0;
  document.getElementById('rec-audio').src = '';
  document.getElementById('rec-preview').style.display   = 'none';
  document.getElementById('rec-clear-btn').style.display = 'none';
  document.getElementById('rec-start-btn').style.display = '';
  document.getElementById('rec-start-btn').innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">mic</span> Start Recording';
  document.getElementById('rec-timer').textContent = '0:00';
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
  const title = document.getElementById('audio-title')?.value.trim() || 'Audio Lecture';
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
  if (!sd?.ok) { toast(sd?.error || 'Failed to create session.'); hideProg(); btn.textContent = 'Transcribe & Study →'; btn.disabled = false; return; }

  prog('Transcribing audio with Voxtral…', 38);
  try {
    const fd = new FormData();
    fd.append('audio', audioFile);
    fd.append('title', title);
    const res = await fetch(`/api/session/${sd.sid}/upload_audio`, { method: 'POST', body: fd });
    const ud  = await res.json();
    if (!ud.ok) {
      toast(ud.error || 'Transcription failed. Check your Mistral API key.');
      hideProg(); btn.textContent = 'Transcribe & Study →'; btn.disabled = false;
      fetch(`/api/session/${sd.sid}/delete`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    prog('Indexing…', 85);
    await new Promise(r => setTimeout(r, 300));
    prog('Done!', 100);
    setTimeout(() => { hideProg(); location.href = `/session/${sd.sid}`; }, 500);
  } catch (e) {
    toast('Network error during transcription.');
    hideProg();
  }
  btn.textContent = 'Transcribe & Study →'; btn.disabled = false;
}
