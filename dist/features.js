const CHAT_STORE = 'shiguang-ai-conversations-v1';
const NOTE_STORE = 'shiguang-structured-notes-v1';
let conversations = JSON.parse(localStorage.getItem(CHAT_STORE) || '[]');
let studyNotes = JSON.parse(localStorage.getItem(NOTE_STORE) || '[]');
let activeConversationId = conversations[0]?.id || null;
let currentNoteId = null;
let networkVisible = false;

function saveConversations() {
  localStorage.setItem(CHAT_STORE, JSON.stringify(conversations));
}
function saveStudyNotes() {
  localStorage.setItem(NOTE_STORE, JSON.stringify(studyNotes));
}
function activeConversation() {
  return conversations.find(item => item.id === activeConversationId) || null;
}
function formatStamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function setApiStatus(message, good = false) {
  const el = document.getElementById('apiStatus');
  if (!el) return;
  el.textContent = message;
  el.style.color = good ? '#617966' : '#a87553';
}

async function refreshApiStatus() {
  try {
    const response = await fetch('/api/status');
    if (response.status === 401) return;
    const result = await response.json();
    if (result.configured) setApiStatus(`已连接 · ${result.model}`, true);
    else setApiStatus('AI 服务尚未配置，请联系管理员');
  } catch {
    setApiStatus('请用“启动拾光日记.bat”打开 AI 对话');
  }
}

function renderConversationList() {
  const list = document.getElementById('chatSessionList');
  if (!list) return;
  list.innerHTML = conversations.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item =>
    `<button class="chat-session ${item.id === activeConversationId ? 'on' : ''}" data-chat-id="${esc(item.id)}" title="${esc(item.title)}">${esc(item.title || '新对话')}<small class="chat-session-author">由 ${esc(item.updatedBy || item.createdBy || '共享成员')} 更新</small></button>`
  ).join('') || '<div class="muted" style="padding:8px">还没有保存的对话</div>';
  list.querySelectorAll('[data-chat-id]').forEach(button => button.onclick = () => {
    activeConversationId = button.dataset.chatId;
    renderConversationList();
    renderConversation();
  });
}

function renderConversation() {
  const panel = document.getElementById('chatMessages');
  const conversation = activeConversation();
  if (!panel) return;
  const messages = conversation?.messages || [];
  panel.innerHTML = messages.length ? messages.map((message, index) =>
    `<article class="message ${message.role === 'user' ? 'user' : 'assistant'}"><span class="message-label">${message.role === 'user' ? esc(message.actorName || conversation?.createdBy || '共享成员') : 'DeepSeek'} · ${esc(formatStamp(message.createdAt))}</span>${esc(message.content).replace(/\n/g, '<br>')}${message.role === 'assistant' && index === messages.length - 1 ? '<br><button class="btn soft tiny capture-single" style="margin-top:8px">✦ 把这段回答摘为笔记</button>' : ''}</article>`
  ).join('') : '<div class="chat-empty">可以从一个问题开始。<br>例如：什么是 RAG？它适合解决哪类产品问题？</div>';
  panel.scrollTop = panel.scrollHeight;
  const canCapture = Boolean(messages.some(message => message.role === 'assistant'));
  document.getElementById('captureNote').disabled = !canCapture;
  panel.querySelectorAll('.capture-single').forEach(button => button.onclick = () => captureKnowledge(messages.slice(-2)));
}

function createConversation() {
  const item = { id: `chat-${Date.now()}`, title: '新对话', messages: [], createdBy: window.collabUser?.name || '', updatedBy: window.collabUser?.name || '', updatedAt: new Date().toISOString() };
  conversations.unshift(item);
  activeConversationId = item.id;
  renderConversationList();
  renderConversation();
  document.getElementById('chatInput').focus();
  return item;
}

document.getElementById('newChat').onclick = createConversation;
document.getElementById('chatInput').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    document.getElementById('chatForm').requestSubmit();
  }
};
document.getElementById('chatForm').onsubmit = async event => {
  event.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  let conversation = activeConversation() || createConversation();
  conversation.messages.push({ role: 'user', content: text, actorName: window.collabUser?.name || '共享成员', createdAt: new Date().toISOString() });
  if (conversation.title === '新对话') conversation.title = text.length > 28 ? text.slice(0, 28) + '…' : text;
  conversation.updatedAt = new Date().toISOString();
  conversation.updatedBy = window.collabUser?.name || conversation.updatedBy || '';
  input.value = '';
  saveConversations();
  renderConversationList();
  renderConversation();
  const sendButton = document.getElementById('sendChat');
  sendButton.disabled = true;
  sendButton.textContent = '思考中…';
  const pending = { role: 'assistant', content: '正在整理思路…', createdAt: new Date().toISOString(), pending: true };
  conversation.messages.push(pending);
  renderConversation();
  try {
    const messages = conversation.messages.filter(message => !message.pending).slice(-30).map(({ role, content }) => ({ role, content }));
    const response = await fetch('/api/deepseek/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'chat', messages }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '对话请求失败。');
    pending.content = result.reply;
    pending.pending = false;
    pending.createdAt = new Date().toISOString();
    setApiStatus(`已连接 · ${result.model}`, true);
  } catch (error) {
    conversation.messages.pop();
    say(error.message || '暂时无法连接 DeepSeek');
    setApiStatus(error.message || '连接失败');
  } finally {
    conversation.updatedAt = new Date().toISOString();
    conversation.updatedBy = window.collabUser?.name || conversation.updatedBy || '';
    saveConversations();
    renderConversationList();
    renderConversation();
    sendButton.disabled = false;
    sendButton.textContent = '发送 ↗';
  }
};

async function captureKnowledge(sourceMessages) {
  if (!sourceMessages?.length) return;
  const captureButton = document.getElementById('captureNote');
  captureButton.disabled = true;
  captureButton.textContent = '正在整理…';
  try {
    const response = await fetch('/api/deepseek/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'summarize', messages: sourceMessages.map(({ role, content }) => ({ role, content })) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '知识点整理失败。');
    const raw = result.note || {};
    const conversation = activeConversation();
    const note = {
      id: `note-${Date.now()}`,
      title: String(raw.title || '对话知识摘录').slice(0, 100),
      summary: String(raw.summary || ''),
      keyPoints: Array.isArray(raw.keyPoints) ? raw.keyPoints.map(String) : [],
      concepts: Array.isArray(raw.concepts) ? raw.concepts.map(item => ({ name: String(item.name || ''), definition: String(item.definition || ''), related: Array.isArray(item.related) ? item.related.map(String) : [] })) : [],
      examples: Array.isArray(raw.examples) ? raw.examples.map(String) : [],
      keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String) : [],
      relatedIds: [],
      sourceChatId: conversation?.id || '',
      sourceChatTitle: conversation?.title || '',
      createdAt: new Date().toISOString(),
      createdBy: window.collabUser?.name || '',
      updatedBy: window.collabUser?.name || ''
    };
    studyNotes.unshift(note);
    saveStudyNotes();
    renderNotes();
    openNoteDetail(note.id);
    document.querySelector('[data-pane="notes"]').click();
    say('已整理成结构化笔记');
  } catch (error) {
    say(error.message || '摘录失败，请稍后重试');
  } finally {
    captureButton.disabled = !activeConversation()?.messages.some(message => message.role === 'assistant');
    captureButton.textContent = '✦ 摘录为知识点';
  }
}
document.getElementById('captureNote').onclick = () => captureKnowledge(activeConversation()?.messages || []);

function filteredNotes() {
  const query = document.getElementById('noteSearch').value.trim().toLocaleLowerCase();
  const from = document.getElementById('noteFrom').value;
  const to = document.getElementById('noteTo').value;
  return studyNotes.filter(note => {
    const date = (note.createdAt || '').slice(0, 10);
    const text = [note.title, note.summary, ...(note.keywords || []), ...(note.concepts || []).flatMap(concept => [concept.name, concept.definition])].join(' ').toLocaleLowerCase();
    return (!query || text.includes(query)) && (!from || date >= from) && (!to || date <= to);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function renderNotes() {
  const list = document.getElementById('notesList');
  if (!list) return;
  if (!document.getElementById('noteDetail').hidden) return;
  const notes = filteredNotes();
  list.hidden = networkVisible;
  list.innerHTML = notes.length ? notes.map(note => `<article class="note-card" data-note-card="${esc(note.id)}"><div class="note-meta"><span>${esc(formatStamp(note.createdAt))}</span><span>${esc(note.updatedBy || note.createdBy || '共享笔记')} · ${(note.relatedIds || []).length ? `🔗 ${(note.relatedIds || []).length}` : '知识摘录'}</span></div><h3>${esc(note.title)}</h3><p>${esc(note.summary || (note.keyPoints || []).slice(0, 2).join('；') || '点开查看笔记内容。')}</p><div class="note-tags">${(note.keywords || []).slice(0, 5).map(tag => `<span class="note-tag">${esc(tag)}</span>`).join('')}</div></article>`).join('') : '<div class="empty">没有找到笔记。你可以摘录一段 AI 对话，或手动新建一条。</div>';
  list.querySelectorAll('[data-note-card]').forEach(card => card.onclick = () => openNoteDetail(card.dataset.noteCard));
  if (networkVisible) renderMindMap();
}

function openNoteDetail(id) {
  const note = studyNotes.find(item => item.id === id);
  if (!note) return;
  currentNoteId = id;
  const detail = document.getElementById('noteDetail');
  document.getElementById('notesList').hidden = true;
  document.getElementById('mindMap').hidden = true;
  detail.hidden = false;
  const linked = (note.relatedIds || []).map(linkId => studyNotes.find(item => item.id === linkId)).filter(Boolean);
  detail.innerHTML = `<div class="note-detail-head"><div><span class="eyebrow">${esc(formatStamp(note.createdAt))} · ${esc(note.updatedBy || note.createdBy || '共享成员')}${note.sourceChatTitle ? ` · 来自「${esc(note.sourceChatTitle)}」` : ' · 手动笔记'}</span><h2>${esc(note.title)}</h2></div><div class="note-actions"><button class="btn soft tiny" id="backToNotes">← 返回</button><button class="btn soft tiny" id="editCurrentNote">✎ 编辑 / 关联</button><button class="btn tiny" id="deleteCurrentNote">删除</button></div></div><section class="note-section"><h4>摘要</h4><p>${esc(note.summary || '暂无摘要')}</p></section>${note.keyPoints?.length ? `<section class="note-section"><h4>核心要点</h4><ul>${note.keyPoints.map(point => `<li>${esc(point)}</li>`).join('')}</ul></section>` : ''}${note.concepts?.length ? `<section class="note-section"><h4>概念脉络</h4>${note.concepts.map(concept => `<p><b>${esc(concept.name)}</b>：${esc(concept.definition)}${concept.related?.length ? `<small class="muted"> · 相关：${concept.related.map(esc).join('、')}</small>` : ''}</p>`).join('')}</section>` : ''}${note.examples?.length ? `<section class="note-section"><h4>例子</h4><ul>${note.examples.map(item => `<li>${esc(item)}</li>`).join('')}</ul></section>` : ''}${note.keywords?.length ? `<section class="note-section"><h4>关键词</h4><div class="note-tags">${note.keywords.map(item => `<span class="note-tag">${esc(item)}</span>`).join('')}</div></section>` : ''}<section class="note-section"><h4>关联笔记 · 可从“编辑 / 关联”继续添加</h4><div class="note-related">${linked.length ? linked.map(item => `<button data-related-note="${esc(item.id)}">${esc(item.title)} →</button>`).join('') : '<span class="muted">暂未关联其他笔记</span>'}</div></section>`;
  document.getElementById('backToNotes').onclick = () => { currentNoteId = null; detail.hidden = true; document.getElementById('notesList').hidden = networkVisible; if (networkVisible) document.getElementById('mindMap').hidden = false; renderNotes(); };
  document.getElementById('editCurrentNote').onclick = () => openNoteEditor(note);
  document.getElementById('deleteCurrentNote').onclick = () => {
    if (!confirm(`删除笔记“${note.title}”？`)) return;
    studyNotes = studyNotes.filter(item => item.id !== note.id).map(item => ({ ...item, relatedIds: (item.relatedIds || []).filter(linkId => linkId !== note.id) }));
    saveStudyNotes(); currentNoteId = null; detail.hidden = true; renderNotes(); say('笔记已删除');
  };
  detail.querySelectorAll('[data-related-note]').forEach(button => button.onclick = () => openNoteDetail(button.dataset.relatedNote));
}

function openNoteEditor(existing = null) {
  const note = existing || { title: '', summary: '', keyPoints: [], concepts: [], examples: [], keywords: [], relatedIds: [] };
  const otherNotes = studyNotes.filter(item => item.id !== note.id);
  const conceptText = (note.concepts || []).map(item => `${item.name}：${item.definition}`).join('\n');
  modal(existing ? '编辑笔记与关联' : '新建学习笔记', `<form><label class="muted">标题<input class="field" name="title" maxlength="100" value="${esc(note.title)}" required></label><label class="muted">摘要<textarea class="area" name="summary" maxlength="1500">${esc(note.summary || '')}</textarea></label><label class="muted">核心要点（每行一条）<textarea class="area" name="points">${esc((note.keyPoints || []).join('\n'))}</textarea></label><label class="muted">概念与解释（每行一条，用“概念：解释”分开）<textarea class="area" name="concepts">${esc(conceptText)}</textarea></label><label class="muted">例子（每行一条）<textarea class="area" name="examples">${esc((note.examples || []).join('\n'))}</textarea></label><label class="muted">关键词（用逗号分开）<input class="field" name="keywords" value="${esc((note.keywords || []).join('，'))}"></label><label class="muted">关联其他笔记（可多选，按住 Ctrl / ⌘ 选择多条）<select class="select related-select" name="related" multiple>${otherNotes.map(item => `<option value="${esc(item.id)}" ${(note.relatedIds || []).includes(item.id) ? 'selected' : ''}>${esc(item.title)}</option>`).join('')}</select></label><button class="btn" style="width:100%">保存笔记</button></form>`, body => {
    const form = body.querySelector('form');
    const lines = value => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    const concepts = lines(form.elements.concepts.value).map(item => { const index = item.indexOf('：'); return { name: index < 0 ? item : item.slice(0, index).trim(), definition: index < 0 ? '' : item.slice(index + 1).trim(), related: [] }; });
    const saved = { ...note, id: note.id || `note-${Date.now()}`, title: form.elements.title.value.trim(), summary: form.elements.summary.value.trim(), keyPoints: lines(form.elements.points.value), concepts, examples: lines(form.elements.examples.value), keywords: form.elements.keywords.value.split(/[，,]/).map(item => item.trim()).filter(Boolean), relatedIds: Array.from(form.elements.related.selectedOptions).map(option => option.value), createdAt: note.createdAt || new Date().toISOString(), createdBy: note.createdBy || window.collabUser?.name || '', updatedBy: window.collabUser?.name || note.updatedBy || '', updatedAt: new Date().toISOString() };
    if (note.id) studyNotes = studyNotes.map(item => item.id === note.id ? saved : item); else studyNotes.unshift(saved);
    saveStudyNotes(); renderNotes(); openNoteDetail(saved.id); say('笔记已保存'); return true;
  });
}

function renderMindMap() {
  const map = document.getElementById('mindMap');
  if (!map || !networkVisible) return;
  const nodes = studyNotes.slice(0, 24);
  if (!nodes.length) { map.innerHTML = '<div class="mind-empty">保存几条笔记，再手动建立关联，这里就会长出你的思维网络。</div>'; return; }
  const width = 900, cols = 3, cellW = width / cols, cellH = 138, rows = Math.ceil(nodes.length / cols), height = Math.max(420, rows * cellH + 30);
  const positions = new Map(nodes.map((note, index) => [note.id, { x: (index % cols) * cellW + cellW / 2, y: Math.floor(index / cols) * cellH + 68 }]));
  const edges = new Set();
  nodes.forEach(note => (note.relatedIds || []).forEach(id => { if (positions.has(id)) edges.add([note.id, id].sort().join('|')); }));
  const lines = [...edges].map(edge => { const [a, b] = edge.split('|'), p1 = positions.get(a), p2 = positions.get(b); return `<line class="mind-edge" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"></line>`; }).join('');
  const cards = nodes.map(note => { const p = positions.get(note.id); return `<button class="mind-node" data-mind-note="${esc(note.id)}" style="left:${p.x / width * 100}%;top:${p.y / height * 100}%">${esc(note.title)}</button>`; }).join('');
  map.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>${cards}`;
  map.querySelectorAll('[data-mind-note]').forEach(button => button.onclick = () => openNoteDetail(button.dataset.mindNote));
}

document.getElementById('newNote').onclick = () => openNoteEditor();
document.getElementById('toggleMindMap').onclick = () => {
  networkVisible = !networkVisible;
  document.getElementById('toggleMindMap').textContent = networkVisible ? '☷ 笔记列表' : '🕸 思维网络';
  document.getElementById('mindMap').hidden = !networkVisible;
  document.getElementById('notesList').hidden = networkVisible;
  if (networkVisible) renderMindMap();
};
document.getElementById('noteSearch').oninput = renderNotes;
document.getElementById('noteFrom').onchange = renderNotes;
document.getElementById('noteTo').onchange = renderNotes;
document.getElementById('clearNoteFilters').onclick = () => { document.getElementById('noteSearch').value = ''; document.getElementById('noteFrom').value = ''; document.getElementById('noteTo').value = ''; renderNotes(); };
document.getElementById('tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-pane]');
  if (!button) return;
  if (button.dataset.pane === 'chat') { renderConversationList(); renderConversation(); refreshApiStatus(); }
  if (button.dataset.pane === 'notes') renderNotes();
});

window.addEventListener('shiguang:remote-state', event => {
  const { key, value } = event.detail || {};
  if (typeof value !== 'string') return;
  if (key === CHAT_STORE) {
    try { conversations = JSON.parse(value) || []; } catch { return; }
    if (!conversations.some(item => item.id === activeConversationId)) activeConversationId = conversations[0]?.id || null;
    renderConversationList();
    renderConversation();
  }
  if (key === NOTE_STORE) {
    try { studyNotes = JSON.parse(value) || []; } catch { return; }
    renderNotes();
    if (currentNoteId && !document.getElementById('noteDetail').hidden) openNoteDetail(currentNoteId);
  }
});
document.addEventListener('shiguang:collab-ready', () => refreshApiStatus());

renderConversationList();
renderConversation();
renderNotes();
refreshApiStatus();
