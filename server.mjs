import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(projectRoot, 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const dataRoot = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'storage'));
const dataFile = path.join(dataRoot, 'shared-data.json');
const maxAccounts = 2;
const allowedKeys = new Set(['shiguang-diary-v1', 'shiguang-ai-conversations-v1', 'shiguang-structured-notes-v1']);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };

let localConfig = {};
try {
  localConfig = (await import(pathToFileURL(path.join(projectRoot, 'deepseek.config.local.mjs')).href)).default || {};
} catch { /* API can be configured with environment variables. */ }
let sharedConfig = {};
try {
  sharedConfig = (await import(pathToFileURL(path.join(projectRoot, 'shared.config.local.mjs')).href)).default || {};
} catch { /* Public deployments should use environment variables. */ }
const apiKey = String(process.env.DEEPSEEK_API_KEY || localConfig.apiKey || '').trim();
const model = String(process.env.DEEPSEEK_MODEL || localConfig.model || 'deepseek-flash').trim();
const baseUrl = String(process.env.DEEPSEEK_BASE_URL || localConfig.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
const inviteCode = String(process.env.APP_INVITE_CODE || sharedConfig.inviteCode || '').trim();
const production = process.env.NODE_ENV === 'production';
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const eventClients = new Set();
const rateBuckets = new Map();
let writeQueue = Promise.resolve();

let store;
try {
  store = JSON.parse(await readFile(dataFile, 'utf8'));
  store.users ||= [];
  store.values ||= {};
  store.revision ||= 0;
  store.activity ||= [];
} catch {
  store = { users: [], values: {}, revision: 0, activity: [] };
}

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(value));
}

async function persist() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dataRoot, { recursive: true });
    const temp = `${dataFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(store), { mode: 0o600 });
    await rename(temp, dataFile);
  });
  return writeQueue;
}

async function readJson(req, maxBytes = 18_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('提交内容过大。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求格式无法读取。'), { status: 400 }); }
}

function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
  return forwarded.length ? forwarded.at(-1) : (req.socket.remoteAddress || 'unknown');
}

function allowRate(req, res, bucket, limit, windowMs) {
  const now = Date.now();
  const id = `${bucket}:${clientAddress(req)}`;
  let record = rateBuckets.get(id);
  if (!record || now - record.start >= windowMs) record = { start: now, count: 0 };
  record.count++;
  rateBuckets.set(id, record);
  if (rateBuckets.size > 5000) for (const [key, value] of rateBuckets) if (now - value.start > 60 * 60 * 1000) rateBuckets.delete(key);
  if (record.count <= limit) return true;
  sendJson(res, 429, { error: '操作太频繁，请稍后再试。' }, { 'retry-after': String(Math.ceil((windowMs - (now - record.start)) / 1000)) });
  return false;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function currentUser(req) {
  const token = parseCookies(req).shiguang_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return store.users.find(user => user.id === session.userId) || null;
}

function publicUser(user) {
  return user ? { id: user.id, name: user.name } : null;
}

function setSessionCookie(token) {
  return `shiguang_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}${production ? '; Secure' : ''}`;
}

function clearSessionCookie() {
  return `shiguang_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${production ? '; Secure' : ''}`;
}

function verifySameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host && (!production || parsed.protocol === 'https:');
  } catch { return false; }
}

async function authorize(req, res) {
  const user = currentUser(req);
  if (user) return user;
  sendJson(res, 401, { error: '请先登录。' });
  return null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function mergeArray(base, next, current) {
  const idArray = [...base, ...next, ...(Array.isArray(current) ? current : [])].every(item => isRecord(item) && item.id != null);
  if (idArray) {
    const before = new Map(base.map(item => [String(item.id), item]));
    const after = new Map(next.map(item => [String(item.id), item]));
    const merged = new Map((Array.isArray(current) ? current : []).map(item => [String(item.id), item]));
    for (const [id] of before) if (!after.has(id)) merged.delete(id);
    for (const [id, item] of after) {
      if (!before.has(id)) merged.set(id, item);
      else if (!deepEqual(before.get(id), item)) merged.set(id, mergeValue(before.get(id), item, merged.get(id)));
    }
    const order = [...(Array.isArray(current) ? current : []).map(item => String(item.id)), ...next.map(item => String(item.id))];
    return [...new Set(order)].filter(id => merged.has(id)).map(id => merged.get(id));
  }
  if (base.every(item => ['string', 'number', 'boolean'].includes(typeof item)) && next.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
    const removed = new Set(base.filter(item => !next.includes(item)));
    return [...new Set([...(Array.isArray(current) ? current : []).filter(item => !removed.has(item)), ...next.filter(item => !base.includes(item))])];
  }
  return next;
}

function mergeValue(base, next, current) {
  if (deepEqual(base, next)) return current;
  if (Array.isArray(base) && Array.isArray(next)) return mergeArray(base, next, current);
  if (isRecord(base) && isRecord(next)) {
    const result = isRecord(current) ? { ...current } : {};
    for (const key of Object.keys(base)) if (!Object.hasOwn(next, key)) delete result[key];
    for (const [key, value] of Object.entries(next)) {
      if (!Object.hasOwn(base, key)) result[key] = value;
      else if (!deepEqual(base[key], value)) result[key] = mergeValue(base[key], value, result[key]);
    }
    return result;
  }
  return next;
}

function activityLabel(key, baseText, valueText) {
  const base = (() => { try { return baseText ? JSON.parse(baseText) : {}; } catch { return {}; } })();
  const value = (() => { try { return JSON.parse(valueText); } catch { return {}; } })();
  if (key === 'shiguang-ai-conversations-v1') {
    const chats = Array.isArray(value) ? value : [];
    const changed = chats.find(item => !Array.isArray(base) || !deepEqual(base.find(old => old.id === item.id), item));
    return changed?.title ? `AI 对话「${String(changed.title).slice(0, 36)}」` : 'AI 对话';
  }
  if (key === 'shiguang-structured-notes-v1') {
    const notes = Array.isArray(value) ? value : [];
    const changed = notes.find(item => !Array.isArray(base) || !deepEqual(base.find(old => old.id === item.id), item));
    return changed?.title ? `笔记「${String(changed.title).slice(0, 36)}」` : '学习笔记';
  }
  const changedKey = ['plans', 'memos', 'wishes', 'entries', 'photos', 'study'].find(name => !deepEqual(base[name], value[name]));
  const labels = { plans: '计划', memos: '备忘录', wishes: '许愿池', entries: '日历与心情', photos: '日程照片', study: '学习记录' };
  let detail = labels[changedKey] || '每日记录';
  const previous = base[changedKey];
  const current = value[changedKey];
  const arrays = Array.isArray(current) ? current : [];
  const prevArray = Array.isArray(previous) ? previous : [];
  const changedItem = arrays.find(item => !deepEqual(prevArray.find(old => old?.id === item?.id), item));
  const title = changedItem?.title || changedItem?.text || changedItem?.content;
  if (title) detail += `「${String(title).slice(0, 30)}」`;
  return detail;
}

function publish(event) {
  const payload = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    try { client.write(payload); } catch { eventClients.delete(client); }
  }
}

const chatInstructions = '你是拾光日记里的中文 AI 学习助手。用清楚、易懂、准确的中文回答；遇到不确定或时效性内容时说明边界，不编造来源。优先用例子解释 AI、研究、产品与运营问题。';
const noteInstructions = `你是学习笔记整理助手。把用户提供的对话整理为结构化知识点，中文表达，删去闲聊和重复内容，保留关键定义、逻辑关系、例子和疑问。只输出 JSON 对象，字段格式如下：{"title":"简洁标题","summary":"一段概括","keyPoints":["要点"],"concepts":[{"name":"概念名","definition":"易懂解释","related":["相关概念名"]}],"examples":["例子"],"keywords":["关键词"]}。若某字段没有内容，返回空数组；不要补造对话中没有的事实。`;

async function handleDeepSeek(req, res, user) {
  if (!apiKey) return sendJson(res, 503, { error: 'AI 服务尚未配置，请联系管理员。' });
  let body;
  try { body = await readJson(req, 700_000); }
  catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  const mode = body.mode === 'summarize' ? 'summarize' : 'chat';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return sendJson(res, 400, { error: '请先输入一段对话内容。' });
  const messages = body.messages.slice(-40).map(item => {
    const role = ['user', 'assistant'].includes(item?.role) ? item.role : null;
    const content = typeof item?.content === 'string' ? item.content.trim().slice(0, 12_000) : '';
    return role && content ? { role, content } : null;
  }).filter(Boolean);
  if (!messages.length) return sendJson(res, 400, { error: '没有可发送的对话内容。' });
  const payload = { model, messages: [{ role: 'system', content: mode === 'summarize' ? noteInstructions : chatInstructions }, ...messages], stream: false, max_tokens: mode === 'summarize' ? 5000 : 4000, ...(mode === 'summarize' ? { response_format: { type: 'json_object' } } : {}) };
  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return sendJson(res, upstream.status >= 500 ? 502 : upstream.status, { error: result?.error?.message || `DeepSeek 请求失败（${upstream.status}）。` });
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return sendJson(res, 502, { error: '模型没有返回文字，请重试。' });
    if (mode === 'summarize') {
      try { return sendJson(res, 200, { note: JSON.parse(content), model }); }
      catch { return sendJson(res, 502, { error: '模型返回的笔记格式无法解析，请再试一次。' }); }
    }
    return sendJson(res, 200, { reply: content, model, actor: user.name });
  } catch (error) {
    return sendJson(res, 502, { error: error.name === 'TimeoutError' ? '模型响应超时，请稍后重试。' : '暂时无法连接 AI 服务，请检查网络后重试。' });
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    const remaining = Math.max(0, maxAccounts - store.users.length);
    return sendJson(res, 200, { registrationOpen: remaining > 0 && Boolean(inviteCode), remainingAccounts: remaining });
  }
  if (!verifySameOrigin(req) && req.method !== 'GET') return sendJson(res, 403, { error: '请求来源无法验证。' });

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    if (!allowRate(req, res, 'register', 5, 60 * 60 * 1000)) return;
    if (!inviteCode) return sendJson(res, 503, { error: '服务器尚未配置注册邀请码。' });
    let body;
    try { body = await readJson(req, 20_000); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    if (store.users.length >= maxAccounts) return sendJson(res, 403, { error: '共享空间账号已满。' });
    const name = String(body.name || '').trim().slice(0, 24);
    const password = String(body.password || '');
    if (!name || password.length < 10 || password.length > 256) return sendJson(res, 400, { error: '请填写称呼，密码需为 10 至 256 个字符。' });
    if (!['呼呼', '听听'].includes(name)) return sendJson(res, 400, { error: '共享空间的两个称呼为“呼呼”和“听听”。' });
    if (!safeEqual(String(body.inviteCode || ''), inviteCode)) return sendJson(res, 403, { error: '邀请码不正确。' });
    if (store.users.some(user => user.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 409, { error: '这个称呼已被使用。' });
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    const user = { id: randomUUID(), name, salt, passwordHash, createdAt: new Date().toISOString() };
    store.users.push(user);
    await persist();
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + sessionTtlMs });
    return sendJson(res, 201, { user: publicUser(user) }, { 'set-cookie': setSessionCookie(token) });
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    if (!allowRate(req, res, 'login', 10, 15 * 60 * 1000)) return;
    let body;
    try { body = await readJson(req, 20_000); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const name = String(body.name || '').trim();
    const user = store.users.find(item => item.name.toLowerCase() === name.toLowerCase());
    const candidate = user ? (await scrypt(String(body.password || ''), user.salt, 64)).toString('hex') : '';
    if (!user || !safeEqual(candidate, user.passwordHash)) return sendJson(res, 401, { error: '称呼或密码不正确。' });
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + sessionTtlMs });
    return sendJson(res, 200, { user: publicUser(user) }, { 'set-cookie': setSessionCookie(token) });
  }

  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const user = currentUser(req);
    return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: '请先登录。' });
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req).shiguang_session;
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
  }

  const user = await authorize(req, res);
  if (!user) return;

  if (url.pathname === '/api/status' && req.method === 'GET') return sendJson(res, 200, { configured: Boolean(apiKey), model, user: publicUser(user) });
  if (url.pathname === '/api/deepseek/chat' && req.method === 'POST') {
    if (!allowRate(req, res, 'chat', 30, 60_000)) return;
    return handleDeepSeek(req, res, user);
  }
  if (url.pathname === '/api/sync/state' && req.method === 'GET') return sendJson(res, 200, { values: store.values, revision: store.revision, activity: store.activity.slice(-30), user: publicUser(user) });
  if (url.pathname === '/api/sync/update' && req.method === 'POST') {
    if (!allowRate(req, res, 'sync', 120, 60_000)) return;
    let body;
    try { body = await readJson(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const key = String(body.key || '');
    if (!allowedKeys.has(key)) return sendJson(res, 400, { error: '不支持同步这个数据类型。' });
    if (typeof body.value !== 'string' || body.value.length > 8_000_000) return sendJson(res, 413, { error: '同步内容过大。' });
    let nextValue;
    try { nextValue = JSON.parse(body.value); } catch { return sendJson(res, 400, { error: '同步内容格式无法读取。' }); }
    let baseValue = null;
    try { baseValue = body.base == null ? null : JSON.parse(body.base); } catch { return sendJson(res, 400, { error: '同步基准格式无法读取。' }); }
    const currentText = store.values[key];
    let currentValue = null;
    try { currentValue = currentText == null ? null : JSON.parse(currentText); } catch { currentValue = null; }
    const merged = baseValue === null || currentValue === null ? nextValue : mergeValue(baseValue, nextValue, currentValue);
    const mergedText = JSON.stringify(merged);
    if (mergedText === currentText) return sendJson(res, 200, { key, value: mergedText, revision: store.revision, actor: publicUser(user), unchanged: true });
    const label = activityLabel(key, body.base, JSON.stringify(nextValue));
    store.values[key] = mergedText;
    store.revision++;
    const activity = { id: randomUUID(), userId: user.id, userName: user.name, label, at: new Date().toISOString(), revision: store.revision };
    store.activity.push(activity);
    store.activity = store.activity.slice(-100);
    await persist();
    const event = { key, value: mergedText, revision: store.revision, actor: publicUser(user), activity };
    publish(event);
    return sendJson(res, 200, event);
  }
  if (url.pathname === '/api/sync/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.revision, activity: store.activity.slice(-30), user: publicUser(user) })}\n\n`);
    eventClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); eventClients.delete(res); } }, 25_000);
    req.on('close', () => { clearInterval(heartbeat); eventClients.delete(res); });
    return;
  }
  return sendJson(res, 404, { error: '找不到这个接口。' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { return await handleApi(req, res, url); }
    catch (error) { console.error('API error:', error); return sendJson(res, 500, { error: '服务暂时遇到问题，请稍后重试。' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '不支持这个请求方式。' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(publicRoot, `.${pathname}`);
  if (!file.startsWith(publicRoot + path.sep) && file !== path.join(publicRoot, 'index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': pathname === '/app-config.js' ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('找不到这个网页文件。');
  }
});

server.listen(port, host, () => {
  console.log(`拾光日记已启动：http://${host}:${port}`);
  console.log(`账号：${store.users.length}/${maxAccounts}；注册邀请码：${inviteCode ? '已配置' : '尚未配置'}`);
  console.log(`DeepSeek：${apiKey ? `已配置（${model}）` : '尚未配置'}`);
  console.log(`共享数据目录：${dataRoot}`);
});
