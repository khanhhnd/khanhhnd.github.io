/**
 * GHN Pick & Pack Checker — app.js
 * Standalone ES-module, no build step required.
 * Uses @zxing/browser via esm.sh CDN for barcode decoding.
 */

import { BrowserMultiFormatReader } from
  'https://esm.sh/@zxing/browser@0.1.4';

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
const LS_KEY = 'ghn_picklist_v1';

let state = {
  codes:       [],   // normalized list (uppercase, unique)
  scanned:     [],   // codes already scanned (in order)
  currentScreen: 'setup',
  isMuted:     false,
};

let scanControls   = null;   // returned by BrowserMultiFormatReader
let debounceTimer  = null;   // debounce between scans
let resultTimer    = null;   // auto-hide result overlay
let isCoolingDown  = false;  // 1.5s cooldown flag
let torchSupported = false;
let torchOn        = false;
let currentFilter  = 'all';

/* ══════════════════════════════════════════════════════
   DOM REFS
══════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const setupScreen        = $('setupScreen');
const scanScreen         = $('scanScreen');
const reviewScreen       = $('reviewScreen');

const codeListInput      = $('codeListInput');
const codeCountBadge     = $('codeCountBadge');
const previewList        = $('previewList');
const startScanBtn       = $('startScanBtn');
const savedNotice        = $('savedNotice');
const savedNoticeText    = $('savedNoticeText');
const clearSavedBtn      = $('clearSavedBtn');

const videoEl            = $('videoEl');
const counterBadge       = $('counterBadge');
const resultOverlay      = $('resultOverlay');
const resultIcon         = $('resultIcon');
const resultStatus       = $('resultStatus');
const resultCode         = $('resultCode');
const cameraError        = $('cameraError');
const goToReviewBtn      = $('goToReviewBtn');
const newBatchFromScanBtn= $('newBatchFromScanBtn');
const muteBtn            = $('muteBtn');
const toggleFlashBtn     = $('toggleFlashBtn');
const retryCamera        = $('retryCamera');

const backToScanBtn      = $('backToScanBtn');
const newBatchFromReview = $('newBatchFromReviewBtn');
const statScanned        = $('statScanned');
const statRemaining      = $('statRemaining');
const progressFill       = $('progressFill');
const progressLabel      = $('progressLabel');
const progressTotal      = $('progressTotal');
const reviewList         = $('reviewList');

const confirmDialog      = $('confirmDialogBackdrop');
const confirmCancelBtn   = $('confirmCancelBtn');
const confirmOkBtn       = $('confirmOkBtn');

const toast              = $('toast');

/* ══════════════════════════════════════════════════════
   AUDIO (Web Audio API — generates tones, no files needed)
══════════════════════════════════════════════════════ */
function playTone(type) {
  if (state.isMuted) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    const makeBeep = (freq, waveType, startAt, duration, volume = 0.35) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = waveType;
      gain.gain.setValueAtTime(volume, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startAt + duration);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + duration + 0.05);
    };

    if (type === 'found') {
      // Pleasant ascending double-beep
      makeBeep(880, 'sine', 0,    0.12);
      makeBeep(1100,'sine', 0.15, 0.15);
    } else if (type === 'duplicate') {
      // Warning: two medium beeps
      makeBeep(520, 'triangle', 0,    0.15);
      makeBeep(520, 'triangle', 0.22, 0.15);
    } else if (type === 'notfound') {
      // Error: low descending buzz
      makeBeep(300, 'sawtooth', 0,    0.18);
      makeBeep(220, 'sawtooth', 0.22, 0.22);
    }
  } catch (e) { /* AudioContext blocked – silent fail */ }
}

/* ══════════════════════════════════════════════════════
   NORMALIZATION
══════════════════════════════════════════════════════ */
function normalizeCodes(raw) {
  const lines = raw.split(/[\n,;]+/);
  const seen  = new Set();
  const out   = [];
  for (const line of lines) {
    const code = line.trim().toUpperCase();
    if (code && !seen.has(code)) { seen.add(code); out.push(code); }
  }
  return out;
}

function normalizeScanned(raw) {
  // raw code coming off barcode reader
  return raw.trim().toUpperCase();
}

/* ══════════════════════════════════════════════════════
   LOCAL STORAGE
══════════════════════════════════════════════════════ */
function saveToLS() {
  localStorage.setItem(LS_KEY, JSON.stringify({
    codes:   state.codes,
    scanned: state.scanned,
  }));
}
function clearLS() { localStorage.removeItem(LS_KEY); }
function loadFromLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/* ══════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════ */
let toastTimer = null;
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

/* ══════════════════════════════════════════════════════
   SCREEN NAVIGATION
══════════════════════════════════════════════════════ */
function showScreen(name) {
  [setupScreen, scanScreen, reviewScreen].forEach(s => s.classList.remove('active'));
  if (name === 'setup')  { setupScreen.classList.add('active');  stopCamera(); }
  if (name === 'scan')   { scanScreen.classList.add('active');   startCamera(); }
  if (name === 'review') {
    reviewScreen.classList.add('active');
    // Pause camera but keep stream (resume instantly when going back)
    // Actually stop to save battery; restart on back
    stopCamera();
    renderReview();
  }
  state.currentScreen = name;
}

/* ══════════════════════════════════════════════════════
   SETUP SCREEN
══════════════════════════════════════════════════════ */
function initSetup() {
  const saved = loadFromLS();
  if (saved && saved.codes && saved.codes.length > 0) {
    state.codes   = saved.codes;
    state.scanned = saved.scanned || [];
    savedNoticeText.textContent =
      `${saved.codes.length} mã — Đã scan ${(saved.scanned || []).length}`;
    savedNotice.style.display = 'flex';
    // Pre-fill textarea
    codeListInput.value = saved.codes.join('\n');
    updateCodePreview();
  }
}

codeListInput.addEventListener('input', updateCodePreview);

function updateCodePreview() {
  const codes = normalizeCodes(codeListInput.value);
  const count = codes.length;

  if (count > 0) {
    codeCountBadge.textContent = `${count} mã`;
    codeCountBadge.classList.add('visible');
    startScanBtn.disabled = false;

    // Show preview (first 8 items)
    previewList.innerHTML = '';
    const shown = codes.slice(0, 8);
    shown.forEach(c => {
      const el = document.createElement('div');
      el.className = 'preview-item';
      el.textContent = c;
      previewList.appendChild(el);
    });
    if (codes.length > 8) {
      const more = document.createElement('div');
      more.className = 'preview-item';
      more.style.color = 'var(--text-muted)';
      more.textContent = `... và ${codes.length - 8} mã khác`;
      previewList.appendChild(more);
    }
    previewList.classList.add('visible');
  } else {
    codeCountBadge.classList.remove('visible');
    startScanBtn.disabled = true;
    previewList.classList.remove('visible');
  }
}

startScanBtn.addEventListener('click', () => {
  const codes = normalizeCodes(codeListInput.value);
  if (codes.length === 0) return;
  state.codes   = codes;
  state.scanned = [];
  saveToLS();
  savedNotice.style.display = 'none';
  showScreen('scan');
});

clearSavedBtn.addEventListener('click', () => {
  clearLS();
  state.codes   = [];
  state.scanned = [];
  codeListInput.value = '';
  updateCodePreview();
  savedNotice.style.display = 'none';
});

/* ══════════════════════════════════════════════════════
   CAMERA / SCANNER
══════════════════════════════════════════════════════ */
const codeReader = new BrowserMultiFormatReader();

async function startCamera() {
  cameraError.classList.remove('show');
  videoEl.style.display = 'block';

  try {
    const constraints = {
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }
    };
    scanControls = await codeReader.decodeFromConstraints(
      constraints, videoEl, onDecode
    );

    // Try torch
    const track = videoEl.srcObject?.getVideoTracks?.()[0];
    if (track) {
      const caps = track.getCapabilities?.() || {};
      torchSupported = !!caps.torch;
      toggleFlashBtn.style.display = torchSupported ? '' : 'none';
    }
  } catch (err) {
    console.error('Camera error:', err);
    videoEl.style.display = 'none';
    cameraError.classList.add('show');
  }

  updateCounter();
}

function stopCamera() {
  if (scanControls) {
    try { scanControls.stop(); } catch {}
    scanControls = null;
  }
  torchOn = false;
  toggleFlashBtn.textContent = '🔦';
}

async function onDecode(result, error) {
  if (!result) return;   // NotFoundException and other decode misses are silently ignored
  if (isCoolingDown) return;

  const rawText = result.getText();
  const code    = normalizeScanned(rawText);

  isCoolingDown = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { isCoolingDown = false; }, 1500);

  handleScan(code);
}

function handleScan(code) {
  const inList    = state.codes.includes(code);
  const inScanned = state.scanned.includes(code);

  let type, icon, statusText;

  if (!inList) {
    type = 'notfound'; icon = '❌'; statusText = 'KHÔNG CÓ';
    playTone('notfound');
  } else if (inScanned) {
    type = 'duplicate'; icon = '⚠️'; statusText = 'ĐÃ SCAN';
    playTone('duplicate');
  } else {
    type = 'found'; icon = '✅'; statusText = 'CÓ';
    state.scanned.push(code);
    saveToLS();
    playTone('found');
    updateCounter();

    // Check completion
    if (state.scanned.length === state.codes.length) {
      setTimeout(() => showToast('🎉 Hoàn tất 100%! Tất cả đơn đã được scan.', 5000), 400);
    }
  }

  showResult(type, icon, statusText, code);
}

function showResult(type, icon, statusText, code) {
  resultOverlay.className = `result-overlay ${type} show`;
  resultIcon.textContent   = icon;
  resultStatus.textContent = statusText;
  resultCode.textContent   = code;

  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    resultOverlay.className = 'result-overlay';
  }, 2000);
}

function updateCounter() {
  counterBadge.textContent =
    `${state.scanned.length} / ${state.codes.length}`;
}

/* Flash / torch */
toggleFlashBtn.addEventListener('click', async () => {
  const track = videoEl.srcObject?.getVideoTracks?.()[0];
  if (!track) return;
  torchOn = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    toggleFlashBtn.textContent = torchOn ? '💡' : '🔦';
  } catch (e) { torchOn = !torchOn; }
});

/* Mute */
muteBtn.addEventListener('click', () => {
  state.isMuted = !state.isMuted;
  muteBtn.textContent  = state.isMuted ? '🔇' : '🔔';
  document.body.classList.toggle('muted', state.isMuted);
});

/* Retry camera */
retryCamera.addEventListener('click', () => {
  cameraError.classList.remove('show');
  startCamera();
});

/* ══════════════════════════════════════════════════════
   REVIEW SCREEN
══════════════════════════════════════════════════════ */
function renderReview() {
  const total    = state.codes.length;
  const scannedN = state.scanned.length;
  const remainN  = total - scannedN;
  const pct      = total ? Math.round((scannedN / total) * 100) : 0;

  statScanned.textContent   = scannedN;
  statRemaining.textContent = remainN;
  progressFill.style.width  = pct + '%';
  progressLabel.textContent = pct + '%';
  progressTotal.textContent = `${scannedN} / ${total} đơn`;

  renderFilteredList();
}

function renderFilteredList() {
  const scannedSet = new Set(state.scanned);
  let items = state.codes.map(code => ({
    code, done: scannedSet.has(code)
  }));

  if (currentFilter === 'scanned') items = items.filter(i => i.done);
  if (currentFilter === 'pending') items = items.filter(i => !i.done);

  reviewList.innerHTML = '';
  if (items.length === 0) {
    reviewList.innerHTML =
      '<div style="text-align:center;color:var(--text-muted);padding:40px 0;font-size:14px;">Không có mục nào</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(({ code, done }) => {
    const div = document.createElement('div');
    div.className = `review-item ${done ? 'scanned' : 'pending'}`;
    div.innerHTML = `
      <span class="review-item-icon">${done ? '✅' : '⏳'}</span>
      <span class="review-item-code">${code}</span>
      <span class="review-item-badge">${done ? 'Đã scan' : 'Chưa scan'}</span>
    `;
    frag.appendChild(div);
  });
  reviewList.appendChild(frag);
}

document.querySelectorAll('.filter-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderFilteredList();
  });
});

/* ══════════════════════════════════════════════════════
   NAVIGATION BUTTONS
══════════════════════════════════════════════════════ */
goToReviewBtn.addEventListener('click', () => showScreen('review'));
backToScanBtn.addEventListener('click', () => showScreen('scan'));

newBatchFromScanBtn.addEventListener('click', () => confirmDialog.classList.add('show'));
newBatchFromReview.addEventListener('click',  () => confirmDialog.classList.add('show'));

confirmCancelBtn.addEventListener('click', () => confirmDialog.classList.remove('show'));
confirmOkBtn.addEventListener('click', () => {
  confirmDialog.classList.remove('show');
  state.codes   = [];
  state.scanned = [];
  clearLS();
  codeListInput.value = '';
  updateCodePreview();
  savedNotice.style.display = 'none';
  showScreen('setup');
});

/* Close dialog on backdrop click */
confirmDialog.addEventListener('click', e => {
  if (e.target === confirmDialog) confirmDialog.classList.remove('show');
});

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
initSetup();
