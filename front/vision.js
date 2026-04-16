/* vision.js — Vision Chat Interface
   Proxies all RunPod requests through the FastAPI backend to avoid CORS.
   Image is optional — text-only queries work fine.
*/

'use strict';

const API_BASE = 'http://localhost:8000';
marked.setOptions({ breaks: true, gfm: true });

// ── State ──────────────────────────────────────────────────────────
let urlId        = '';
let modelId      = '';
let attachedImage = '';   // base64 data URI — empty = no image
let streaming    = false;

// ── DOM refs ───────────────────────────────────────────────────────
const runpodIdInput     = document.getElementById('runpodId');
const connectBtn        = document.getElementById('connectBtn');
const endpointStatus    = document.getElementById('endpointStatus');
const statusText        = document.getElementById('statusText');
const modelLabel        = document.getElementById('modelLabel');

const chatMessages      = document.getElementById('chatMessages');
const chatEmpty         = document.getElementById('chatEmpty');

const attachedImageWrap = document.getElementById('attachedImageWrap');
const attachedThumb     = document.getElementById('attachedThumb');
const removeImageBtn    = document.getElementById('removeImageBtn');
const attachBtn         = document.getElementById('attachBtn');
const fileInput         = document.getElementById('fileInput');
const questionInput     = document.getElementById('questionInput');
const sendBtn           = document.getElementById('sendBtn');
const chatInputBar      = document.getElementById('chatInputBar');
const dragOverlay       = document.getElementById('dragOverlay');

// ── Endpoint connect ───────────────────────────────────────────────
connectBtn.addEventListener('click', connectEndpoint);
runpodIdInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectEndpoint(); });

async function connectEndpoint() {
  const id = runpodIdInput.value.trim();
  if (!id) return;

  setStatus('connecting', '연결 중…', '');
  connectBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/vision/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url_id: id }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
    }

    const data = await res.json();
    urlId   = id;
    modelId = data.model_id ?? '';

    setStatus('ok', '연결됨', modelId);
    updateSendBtn();
    questionInput.focus();
  } catch (err) {
    setStatus('err', `연결 실패 — ${err.message}`, '');
    urlId = '';
    modelId = '';
  } finally {
    connectBtn.disabled = false;
  }
}

function setStatus(state, text, model) {
  endpointStatus.classList.remove('hidden', 'ok', 'err', 'connecting');
  endpointStatus.classList.add(state);
  statusText.textContent = text;
  modelLabel.textContent = model;
}

// ── Image attachment ───────────────────────────────────────────────
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadImageFile(fileInput.files[0]);
});

removeImageBtn.addEventListener('click', clearAttachedImage);

function loadImageFile(file) {
  if (file.size > 20 * 1024 * 1024) {
    alert('이미지 크기가 20 MB를 초과합니다.');
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    attachedImage = ev.target.result;
    attachedThumb.src = attachedImage;
    attachedImageWrap.classList.remove('hidden');
    attachBtn.classList.add('has-image');
    updateSendBtn();
  };
  reader.readAsDataURL(file);
}

function clearAttachedImage() {
  attachedImage = '';
  attachedThumb.src = '';
  attachedImageWrap.classList.add('hidden');
  attachBtn.classList.remove('has-image');
  fileInput.value = '';
  updateSendBtn();
}

// ── Drag & drop onto input bar ─────────────────────────────────────
document.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    chatInputBar.classList.add('drag-active');
    dragOverlay.classList.remove('hidden');
  }
});

document.addEventListener('dragleave', e => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
    chatInputBar.classList.remove('drag-active');
    dragOverlay.classList.add('hidden');
  }
});

document.addEventListener('drop', e => {
  e.preventDefault();
  chatInputBar.classList.remove('drag-active');
  dragOverlay.classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImageFile(file);
});

// ── Paste image from clipboard ─────────────────────────────────────
document.addEventListener('paste', e => {
  const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    loadImageFile(item.getAsFile());
  }
});

// ── Auto-grow textarea ─────────────────────────────────────────────
questionInput.addEventListener('input', () => {
  questionInput.style.height = 'auto';
  questionInput.style.height = questionInput.scrollHeight + 'px';
  updateSendBtn();
});

questionInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});

// ── Send button state ──────────────────────────────────────────────
function updateSendBtn() {
  // Image-only is not allowed — need at least text
  sendBtn.disabled = !urlId || !questionInput.value.trim() || streaming;
}

// ── Chat message rendering ─────────────────────────────────────────
function hideEmpty() {
  if (chatEmpty) chatEmpty.style.display = 'none';
}

function addUserMessage(text, imgDataUrl) {
  hideEmpty();
  const row = document.createElement('div');
  row.className = 'msg-row user';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = 'YOU';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (imgDataUrl) {
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = imgDataUrl;
    bubble.appendChild(img);
  }

  const textNode = document.createElement('div');
  textNode.textContent = text;
  bubble.appendChild(textNode);

  row.appendChild(bubble);
  row.appendChild(avatar);
  chatMessages.appendChild(row);
  scrollToBottom();
}

function addAssistantMessage() {
  hideEmpty();
  const row = document.createElement('div');
  row.className = 'msg-row assistant';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = 'AI';

  const col = document.createElement('div');
  col.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:0;';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Streaming cursor placeholder
  const cur = document.createElement('span');
  cur.className = 'stream-cursor-el';
  bubble.appendChild(cur);

  // Meta row (hidden until done)
  const meta = document.createElement('div');
  meta.className = 'msg-meta hidden';

  const metaText = document.createElement('span');
  metaText.className = 'msg-meta-text';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-copy-btn';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg> Copy`;

  meta.appendChild(metaText);
  meta.appendChild(copyBtn);
  col.appendChild(bubble);
  col.appendChild(meta);
  row.appendChild(avatar);
  row.appendChild(col);
  chatMessages.appendChild(row);
  scrollToBottom();

  return { bubble, meta, metaText, copyBtn };
}

function renderMarkdownInto(el, text, showCursor) {
  el.innerHTML = marked.parse(text);
  if (showCursor) {
    const cur = document.createElement('span');
    cur.className = 'stream-cursor-el';
    el.appendChild(cur);
  }
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Send & stream ──────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);

async function sendMessage() {
  if (streaming) return;

  const question = questionInput.value.trim();
  if (!question || !urlId) return;

  const imgSnapshot = attachedImage;

  // Render user message
  addUserMessage(question, imgSnapshot);

  // Clear input
  questionInput.value = '';
  questionInput.style.height = 'auto';
  clearAttachedImage();

  streaming = true;
  updateSendBtn();
  sendBtn.classList.add('loading');

  // Add assistant bubble
  const { bubble, meta, metaText, copyBtn } = addAssistantMessage();

  const startTime = Date.now();
  let tokenCount = 0;
  let fullText = '';

  try {
    const res = await fetch(`${API_BASE}/vision/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url_id:         urlId,
        question:       question,
        image_data_url: imgSnapshot || null,
        max_tokens:     2048,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === '[DONE]') continue;

        let chunk;
        try { chunk = JSON.parse(jsonStr); } catch { continue; }

        if (chunk.error) throw new Error(chunk.error);

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          tokenCount++;
          renderMarkdownInto(bubble, fullText, true);
          scrollToBottom();
        }
      }
    }

    if (fullText) renderMarkdownInto(bubble, fullText, false);

  } catch (err) {
    if (fullText) renderMarkdownInto(bubble, fullText, false);
    const errEl = document.createElement('p');
    errEl.style.cssText = 'color:var(--c-bad);margin-top:8px;';
    errEl.textContent = `오류: ${err.message}`;
    bubble.appendChild(errEl);
  } finally {
    streaming = false;
    sendBtn.classList.remove('loading');
    updateSendBtn();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    metaText.textContent = `${tokenCount} tokens · ${elapsed}s`;
    meta.classList.remove('hidden');

    // Wire up copy button with final text
    const rawText = fullText;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rawText);
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg> Copy`;
          copyBtn.classList.remove('copied');
        }, 1800);
      } catch { /* denied */ }
    });

    scrollToBottom();
  }
}
