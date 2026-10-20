'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const overlay = $('overlay');
const address = $('address');
const kbd = $('kbd');

const isTouch = matchMedia('(pointer: coarse)').matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
if (isTouch) document.body.classList.add('touch');

const prefs = loadPrefs();
$('mobileMode').checked = prefs.mobile ?? isTouch;
$('hidpi').checked = prefs.hidpi ?? false;

let ws = null;
let frameSize = { w: 1280, h: 800 }; // CSS px of the remote viewport for the latest frame
let pendingHeader = null;
let decoding = false;
let queuedFrame = null;
let tabs = [];
let reconnectDelay = 500;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = 'blob';

  ws.onopen = () => {
    reconnectDelay = 500;
    $('status').classList.add('ok');
    overlay.textContent = 'Loading…';
    sendResize(true);
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      if (pendingHeader) drawFrame(ev.data, pendingHeader);
      pendingHeader = null;
      return;
    }
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
      case 'frame': pendingHeader = msg; break;
      case 'tabs': renderTabs(msg.tabs); break;
      case 'clipboard': copyToLocalClipboard(msg.text); break;
      case 'dialog': showJsDialog(msg); break;
      case 'dialogClosed': if ($('jsDialog').open) $('jsDialog').close('remote'); break;
      case 'error': toast(msg.message); break;
    }
  };

  ws.onclose = async () => {
    $('status').classList.remove('ok');
    overlay.hidden = false;
    overlay.textContent = 'Disconnected — reconnecting…';
    // If our session expired, go log in again.
    try {
      const r = await fetch('/', { redirect: 'manual' });
      if (r.type === 'opaqueredirect' || r.redirected) return location.assign('/login');
    } catch {}
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function drawFrame(blob, header) {
  frameSize = { w: header.w, h: header.h };
  // Only decode the newest frame; skip ones that pile up while we're busy.
  if (decoding) { queuedFrame = blob; return; }
  decoding = true;
  createImageBitmap(blob).then((bmp) => {
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    overlay.hidden = true;
  }).catch(() => {}).finally(() => {
    decoding = false;
    if (queuedFrame) { const b = queuedFrame; queuedFrame = null; drawFrame(b, { w: frameSize.w, h: frameSize.h }); }
  });
}

let resizeTimer = null;
function sendResize(now) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const r = stage.getBoundingClientRect();
    send({
      t: 'resize',
      width: Math.round(r.width),
      height: Math.round(r.height),
      dpr: $('hidpi').checked ? window.devicePixelRatio || 1 : 1,
      mobile: $('mobileMode').checked,
      touch: isTouch,
    });
  }, now ? 0 : 200);
}
new ResizeObserver(() => sendResize()).observe(stage);

// Map a point on our canvas to CSS pixels in the remote page.
function toRemote(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round(((clientX - r.left) / r.width) * frameSize.w),
    y: Math.round(((clientY - r.top) / r.height) * frameSize.h),
  };
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];

function modifiers(e) {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= isMac ? 2 : 4; // Cmd acts as Ctrl on the Linux browser
  if (e.shiftKey) m |= 8;
  return m;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  e.preventDefault();
  canvas.focus();
  canvas.setPointerCapture(e.pointerId);
  send({ t: 'mouse', type: 'mousePressed', ...toRemote(e.clientX, e.clientY), button: BUTTONS[e.button] || 'left', buttons: e.buttons, clickCount: clickCount(e), modifiers: modifiers(e) });
});

canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') return;
  e.preventDefault();
  send({ t: 'mouse', type: 'mouseReleased', ...toRemote(e.clientX, e.clientY), button: BUTTONS[e.button] || 'left', buttons: e.buttons, clickCount: lastClick.count, modifiers: modifiers(e) });
});

let moveQueued = null;
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const first = !moveQueued;
  moveQueued = { t: 'mouse', type: 'mouseMoved', ...toRemote(e.clientX, e.clientY), buttons: e.buttons, button: e.buttons & 1 ? 'left' : e.buttons & 2 ? 'right' : 'none', modifiers: modifiers(e) };
  if (first) requestAnimationFrame(() => { send(moveQueued); moveQueued = null; });
});

// The browser's own e.detail resets oddly with pointer capture, so count clicks ourselves.
const lastClick = { time: 0, x: 0, y: 0, count: 0 };
function clickCount(e) {
  const now = performance.now();
  if (now - lastClick.time < 500 && Math.abs(e.clientX - lastClick.x) < 5 && Math.abs(e.clientY - lastClick.y) < 5) lastClick.count++;
  else lastClick.count = 1;
  Object.assign(lastClick, { time: now, x: e.clientX, y: e.clientY });
  return lastClick.count;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? frameSize.h : 1;
  send({ t: 'wheel', ...toRemote(e.clientX, e.clientY), dx: e.deltaX * scale, dy: e.deltaY * scale, modifiers: modifiers(e) });
}, { passive: false });

// ---------------------------------------------------------------------------
// Touch (forwarded as real touch events so pages scroll/pinch natively)
// ---------------------------------------------------------------------------

function touchPoints(e) {
  return [...e.touches].map((t) => ({ id: t.identifier, ...toRemote(t.clientX, t.clientY) }));
}
let touchMoveQueued = false;
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); send({ t: 'touch', type: 'touchStart', points: touchPoints(e) }); }, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (touchMoveQueued) return;
  touchMoveQueued = true;
  requestAnimationFrame(() => { touchMoveQueued = false; send({ t: 'touch', type: 'touchMove', points: touchPoints(e) }); });
}, { passive: false });
canvas.addEventListener('touchend', (e) => { e.preventDefault(); send({ t: 'touch', type: e.touches.length ? 'touchMove' : 'touchEnd', points: touchPoints(e) }); }, { passive: false });
canvas.addEventListener('touchcancel', (e) => { e.preventDefault(); send({ t: 'touch', type: 'touchCancel', points: [] }); }, { passive: false });

// ---------------------------------------------------------------------------
// Keyboard (desktop)
// ---------------------------------------------------------------------------

function isPasteShortcut(e) {
  return (e.ctrlKey || (isMac && e.metaKey)) && e.code === 'KeyV' && !e.altKey;
}

function keyMsg(e, type) {
  return {
    t: 'key', type,
    key: e.key, code: e.code, keyCode: e.keyCode,
    text: e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : undefined,
    modifiers: modifiers(e), location: e.location, repeat: e.repeat,
  };
}

canvas.addEventListener('keydown', (e) => {
  if (e.key === 'Meta' && isMac) return;
  if (isPasteShortcut(e)) return; // let the native paste event fire; handled below
  e.preventDefault();
  send(keyMsg(e, 'keyDown'));
});
canvas.addEventListener('keyup', (e) => {
  if (e.key === 'Meta' && isMac) return;
  if (isPasteShortcut(e)) return;
  e.preventDefault();
  send(keyMsg(e, 'keyUp'));
});

document.addEventListener('paste', (e) => {
  if (document.activeElement !== canvas && document.activeElement !== kbd) return;
  const text = e.clipboardData?.getData('text/plain');
  if (text) { e.preventDefault(); send({ t: 'text', text }); }
});

function copyToLocalClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Copied to your clipboard')).catch(() => toast('Copied text: ' + text.slice(0, 200)));
  } else {
    toast('Copied text: ' + text.slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
// Keyboard (phone): a hidden textarea captures the on-screen keyboard.
// ---------------------------------------------------------------------------

const SENTINEL = ' '; // keeps Backspace working when the field would otherwise be empty
kbd.value = SENTINEL;
let composing = false;

function sendKeyPress(key, code, keyCode, text) {
  send({ t: 'key', type: 'keyDown', key, code, keyCode, text, modifiers: 0 });
  send({ t: 'key', type: 'keyUp', key, code, keyCode, modifiers: 0 });
}

function resetKbd() { kbd.value = SENTINEL; kbd.setSelectionRange(1, 1); }

$('keyboard').addEventListener('click', () => {
  resetKbd();
  kbd.focus();
});

kbd.addEventListener('compositionstart', () => { composing = true; });
kbd.addEventListener('compositionend', (e) => {
  composing = false;
  if (e.data) send({ t: 'text', text: e.data });
  resetKbd();
});
kbd.addEventListener('input', (e) => {
  if (composing || e.isComposing) return;
  switch (e.inputType) {
    case 'insertText': if (e.data) send({ t: 'text', text: e.data }); break;
    case 'insertLineBreak':
    case 'insertParagraph': sendKeyPress('Enter', 'Enter', 13, '\r'); break;
    case 'deleteContentBackward': sendKeyPress('Backspace', 'Backspace', 8); break;
    case 'deleteContentForward': sendKeyPress('Delete', 'Delete', 46); break;
    default: {
      const v = kbd.value.replace(SENTINEL, '');
      if (v) send({ t: 'text', text: v });
    }
  }
  resetKbd();
});
kbd.addEventListener('keydown', (e) => {
  // Physical/special keys that don't produce input events.
  const special = { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  if (special[e.key] && !composing) {
    e.preventDefault();
    sendKeyPress(e.key, e.code || e.key, special[e.key], e.key === 'Enter' ? '\r' : undefined);
  }
});

// ---------------------------------------------------------------------------
// Tabs, toolbar, menu
// ---------------------------------------------------------------------------

function renderTabs(list) {
  tabs = list;
  const box = $('tabs');
  box.replaceChildren(...list.map((tab) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.active ? ' active' : '');
    el.title = tab.url;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || tab.url || 'New tab';
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.onclick = (e) => { e.stopPropagation(); send({ t: 'closeTab', id: tab.id }); };
    el.append(title, close);
    el.onclick = () => send({ t: 'switchTab', id: tab.id });
    el.onauxclick = (e) => { if (e.button === 1) send({ t: 'closeTab', id: tab.id }); };
    return el;
  }));
  const active = list.find((t) => t.active);
  if (active) {
    if (document.activeElement !== address) address.value = active.url === 'about:blank' ? '' : active.url;
    document.title = (active.title || 'Remote Browser') + ' — Remote';
    box.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}

$('addressForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ t: 'navigate', url: address.value });
  address.blur();
  canvas.focus();
});
address.addEventListener('focus', () => address.select());

$('back').onclick = () => send({ t: 'back' });
$('forward').onclick = () => send({ t: 'forward' });
$('reload').onclick = () => send({ t: 'reload' });
$('newTab').onclick = () => { send({ t: 'newTab' }); setTimeout(() => { address.focus(); }, 100); };

$('menuBtn').onclick = (e) => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; };
document.addEventListener('click', (e) => { if (!$('menu').contains(e.target)) $('menu').hidden = true; });

$('mobileMode').onchange = () => { savePrefs(); sendResize(true); };
$('hidpi').onchange = () => { savePrefs(); sendResize(true); };
$('fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
  $('menu').hidden = true;
};
$('hideChrome').onclick = () => {
  document.body.classList.add('no-chrome');
  $('showChrome').hidden = false;
  $('menu').hidden = true;
};
$('showChrome').onclick = () => {
  document.body.classList.remove('no-chrome');
  $('showChrome').hidden = true;
};
$('pasteBtn').onclick = async () => {
  $('menu').hidden = true;
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!text) text = prompt('Text to type into the remote page:') || '';
  if (text) send({ t: 'text', text });
  canvas.focus();
};

// Browser-level shortcuts that should act on the remote browser instead.
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || (isMac && e.metaKey);
  if (mod && e.key === 'l') { e.preventDefault(); address.focus(); }
  if (e.key === 'Escape' && document.activeElement === address) { address.blur(); canvas.focus(); }
});

// ---------------------------------------------------------------------------
// JS dialogs (alert/confirm/prompt) from the remote page
// ---------------------------------------------------------------------------

function showJsDialog(msg) {
  const dlg = $('jsDialog');
  $('jsDialogMsg').textContent = msg.message;
  $('jsDialogInput').hidden = msg.type !== 'prompt';
  $('jsDialogInput').value = msg.defaultValue || '';
  $('jsDialogCancel').hidden = msg.type === 'alert';
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue === 'remote') return;
    send({ t: 'dialog', accept: dlg.returnValue === 'ok', text: $('jsDialogInput').value });
    canvas.focus();
  };
  if (!dlg.open) dlg.showModal();
}

// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('rb-prefs')) || {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem('rb-prefs', JSON.stringify({ mobile: $('mobileMode').checked, hidpi: $('hidpi').checked })); } catch {}
}

connect();
canvas.focus();
