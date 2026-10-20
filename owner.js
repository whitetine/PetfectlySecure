// owner.js — 老闆（管理員）身分：Google 登入管理頁產生綁定碼 → LINE 輸入綁定碼 → 設為老闆
//
// 給 iota C.ai 呼叫（需帶 x-api-token 或 ?token=，跟 index.js 的 API_TOKEN 相同）：
//   POST /api/role   {"userId":"Uxxx"}                    → {"role":"owner"|"customer"}
//   POST /api/bind   {"userId":"Uxxx","text":"綁定 ABCD-EFGH"} → {"status":"ok"|"invalid"|"locked"|"error","message":"..."}
//
// 管理頁（用 Google 帳號登入，只有 ADMIN_EMAILS 裡的 email 能用；每個 API 都驗證 Google 簽發的 ID token）：
//   GET  /admin                  管理頁
//   GET  /admin/api/owners       老闆名單
//   POST /admin/api/code         產生綁定碼（5 分鐘、一次性）
//   GET  /admin/api/code/:code   查詢綁定碼是否已被使用
//   POST /admin/api/remove       移除老闆 {"userId":"Uxxx"}
//
// 老闆名單存在 Cloudflare KV（Render 重啟不會消失）；沒設定 KV 時只存在記憶體，重啟會消失。
const crypto = require('crypto');

const env = (k, d = '') => (process.env[k] ?? d).trim();
const list = (k) => env(k).split(',').map(s => s.trim()).filter(Boolean);

const API_TOKEN = env('API_TOKEN') || env('WEBHOOK_TOKEN');
const LINE_TOKEN = env('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_API_BASE = env('LINE_API_BASE', 'https://api.line.me');
const GOOGLE_CLIENT_ID = env('GOOGLE_CLIENT_ID');                  // Google Cloud Console 建立的 OAuth 用戶端 ID（xxx.apps.googleusercontent.com）
const ADMIN_EMAILS = list('ADMIN_EMAILS').map(s => s.toLowerCase()); // 只有這些 Google 帳號能用管理頁
const BOOT_OWNERS = list('OWNER_LINE_IDS');                         // 選填：永遠是老闆、管理頁無法移除（防止把自己鎖在外面）
const OWNER_RICHMENU_ID = env('OWNER_RICHMENU_ID');                 // 選填：老闆專用圖文選單 ID
const KV = { account: env('CF_ACCOUNT_ID'), ns: env('CF_KV_NAMESPACE_ID'), token: env('CF_KV_API_TOKEN') };
const KV_ON = !!(KV.account && KV.ns && KV.token);

const CODE_TTL = 5 * 60 * 1000;
const CODE_LEN = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉 0/O、1/I
const USER_ID_RE = /^U[0-9a-f]{32}$/;
const HOUR = 3600 * 1000;
const MAX_FAILS_PER_USER = 5;    // 同一個 LINE 帳號一小時內最多錯幾次
const MAX_FAILS_GLOBAL = 30;     // 全部人加起來一小時內最多錯幾次（防止用很多帳號亂猜）

// ---------- 小工具 ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const apiAuthed = (req, url) => !!API_TOKEN && (safeEq(url.searchParams.get('token') || '', API_TOKEN) || safeEq(req.headers['x-api-token'] || '', API_TOKEN));
const mask = (id) => id ? `${id.slice(0, 5)}…${id.slice(-4)}` : '';
const twTime = (t = Date.now()) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 10000) throw new Error('too large'); }
  return JSON.parse(raw || '{}');
}

// ---------- 老闆名單（Cloudflare KV）----------
const kvUrl = (key) => `https://api.cloudflare.com/client/v4/accounts/${KV.account}/storage/kv/namespaces/${KV.ns}/values/${encodeURIComponent(key)}`;
let owners = null, ownersAt = 0;          // { [userId]: { name, boundAt, boundBy } }
let lock = Promise.resolve();
const locked = (fn) => { const p = lock.then(fn); lock = p.catch(() => {}); return p; };

async function loadOwners(force = false) {
  if (!force && owners && Date.now() - ownersAt < 60 * 1000) return owners;
  if (!KV_ON) { owners = owners || {}; ownersAt = Date.now(); return owners; }
  const r = await fetch(kvUrl('owners'), { headers: { Authorization: `Bearer ${KV.token}` }, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) owners = {};
  else if (!r.ok) throw new Error(`KV 讀取失敗 ${r.status}`);
  else { try { owners = JSON.parse(await r.text()) || {}; } catch { owners = {}; } }
  ownersAt = Date.now();
  return owners;
}
async function saveOwners(o) {
  if (KV_ON) {
    const fd = new FormData();
    fd.append('value', JSON.stringify(o));
    fd.append('metadata', '{}');
    const r = await fetch(kvUrl('owners'), { method: 'PUT', headers: { Authorization: `Bearer ${KV.token}` }, body: fd, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`KV 寫入失敗 ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  owners = o; ownersAt = Date.now();
}

// 給 index.js 用：判斷是不是老闆。讀不到名單時一律當成「不是」（寧可擋錯，不可放錯）
async function isOwner(userId) {
  userId = String(userId || '').trim();
  if (!USER_ID_RE.test(userId)) return false;
  if (BOOT_OWNERS.includes(userId)) return true;
  try { return !!(await loadOwners())[userId]; }
  catch (e) { console.error('[owner] 讀取老闆名單失敗', e.message); return false; }
}

// ---------- LINE ----------
async function line(method, path, body) {
  if (!LINE_TOKEN) return null;
  const r = await fetch(`${LINE_API_BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${LINE_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`LINE ${method} ${path.split('/').slice(0, 4).join('/')} -> ${r.status}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
}
async function lineName(userId) {
  try { return (await line('GET', `/v2/bot/profile/${userId}`))?.displayName || '（未知名稱）'; }
  catch { return '（未知名稱）'; }
}
async function setRichMenu(userId, on) {
  if (!OWNER_RICHMENU_ID) return;
  try {
    if (on) await line('POST', `/v2/bot/user/${userId}/richmenu/${OWNER_RICHMENU_ID}`);
    else await line('DELETE', `/v2/bot/user/${userId}/richmenu`);
  } catch (e) { console.warn('[owner] 切換圖文選單失敗', e.message); }
}
async function notifyOwners(text, exceptId) {
  let ids = [...BOOT_OWNERS];
  try { ids.push(...Object.keys(await loadOwners())); } catch {}
  for (const id of [...new Set(ids)].filter(id => id !== exceptId)) {
    try { await line('POST', '/v2/bot/message/push', { to: id, messages: [{ type: 'text', text }] }); }
    catch (e) { console.warn('[owner] 通知失敗', mask(id), e.message); }
  }
}

// ---------- 綁定碼 ----------
const codes = new Map();   // code -> { exp, email, usedBy, usedName, usedAt }
function newCode(email) {
  for (const [c, v] of codes) if (v.exp < Date.now() - HOUR) codes.delete(c);
  let code;
  do { code = Array.from({ length: CODE_LEN }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (codes.has(code));
  codes.set(code, { exp: Date.now() + CODE_TTL, email });
  return code;
}
const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

const fails = new Map(); let globalFails = [];
const recent = (arr) => arr.filter(t => Date.now() - t < HOUR);
function addFail(userId) { fails.set(userId, [...recent(fails.get(userId) || []), Date.now()]); globalFails = [...recent(globalFails), Date.now()]; }
const isLocked = (userId) => recent(fails.get(userId) || []).length >= MAX_FAILS_PER_USER || recent(globalFails).length >= MAX_FAILS_GLOBAL;

async function handleBind(body) {
  const userId = String(body?.userId || '').trim();
  if (!USER_ID_RE.test(userId)) return { status: 'error', message: '無法辨識你的 LINE 身分，請稍後再試。' };
  if (isLocked(userId)) return { status: 'locked', message: '嘗試次數過多，請一小時後再試。' };

  const typed = String(body?.text ?? body?.code ?? '').normalize('NFKC').toUpperCase().replace(/綁定/g, '').replace(/[^A-Z0-9]/g, '');
  const c = codes.get(typed);
  if (!c || c.usedBy || c.exp < Date.now()) {
    addFail(userId);
    console.warn('[owner] 綁定失敗', mask(userId));
    return { status: 'invalid', message: '綁定碼無效或已過期，請到管理頁重新產生。' };   // 不區分哪種失敗，避免給線索
  }
  c.usedBy = userId; c.usedAt = Date.now();   // 先作廢，確保只能用一次

  if (await isOwner(userId)) { c.usedName = '（原本就是管理員）'; return { status: 'ok', role: 'owner', message: '你已經是管理員了，不需要再綁定。' }; }

  const name = await lineName(userId);
  c.usedName = name;
  try {
    await locked(async () => {
      const o = { ...(await loadOwners(true)) };
      o[userId] = { name, boundAt: new Date().toISOString(), boundBy: c.email };
      await saveOwners(o);
    });
  } catch (e) {
    console.error('[owner] 寫入老闆名單失敗', e.message);
    c.usedBy = null; c.usedName = null;   // 沒寫成功就讓這組碼還能再用
    return { status: 'error', message: '系統暫時無法完成綁定，請稍後再試。' };
  }
  console.log('[owner] 綁定成功', mask(userId), name, 'by', c.email);
  await setRichMenu(userId, true);
  notifyOwners(`🔔 新管理員已綁定：${name}（${twTime()}，由 ${c.email} 產生的綁定碼）\n如果不是你們授權的，請立刻到管理頁移除。`, userId);
  return { status: 'ok', role: 'owner', message: `✅ 綁定成功！${name} 已設為管理員。\n請再傳一則訊息，就會進入老闆模式。` };
}

// ---------- Google ID token 驗證 ----------
let certs = [], certsAt = 0;
async function getCerts(force = false) {
  if (!force && certs.length && Date.now() - certsAt < HOUR) return certs;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`讀取 Google 憑證失敗 ${r.status}`);
  certs = (await r.json()).keys || []; certsAt = Date.now();
  return certs;
}
const b64d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// 驗證通過回傳 email，否則回傳 null。token 由管理頁放在 Authorization: Bearer 標頭（不用 cookie，所以不怕跨站請求）
async function verifyAdmin(req) {
  if (!GOOGLE_CLIENT_ID || !ADMIN_EMAILS.length) return null;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(b64d(h).toString('utf8'));
    const payload = JSON.parse(b64d(p).toString('utf8'));
    if (header.alg !== 'RS256') return null;
    let jwk = (await getCerts()).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await getCerts(true)).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64d(s))) return null;
    const now = Date.now() / 1000;
    if (payload.aud !== GOOGLE_CLIENT_ID) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    if (!payload.exp || payload.exp < now) return null;
    if (payload.email_verified !== true && payload.email_verified !== 'true') return null;
    const email = String(payload.email || '').toLowerCase();
    return ADMIN_EMAILS.includes(email) ? email : null;
  } catch (e) { console.warn('[owner] 登入驗證錯誤', e.message); return null; }
}

// ---------- 管理頁 ----------
async function ownerRows() {
  const rows = BOOT_OWNERS.map(id => ({ id, short: mask(id), name: '（設定檔）', boundAt: '', boundBy: '環境變數 OWNER_LINE_IDS', removable: false }));
  const o = await loadOwners(true);
  for (const [id, v] of Object.entries(o)) {
    if (BOOT_OWNERS.includes(id)) continue;
    rows.push({ id, short: mask(id), name: v.name, boundAt: v.boundAt ? twTime(Date.parse(v.boundAt)) : '', boundBy: v.boundBy || '', removable: true });
  }
  return rows;
}

async function removeOwner(userId, email) {
  if (BOOT_OWNERS.includes(userId)) return { ok: false, message: '設定檔裡的管理員無法在這裡移除。' };
  return locked(async () => {
    const o = { ...(await loadOwners(true)) };
    if (!o[userId]) return { ok: false, message: '找不到這位管理員。' };
    if (!BOOT_OWNERS.length && Object.keys(o).length <= 1) return { ok: false, message: '至少要保留一位管理員。' };
    const name = o[userId].name;
    delete o[userId];
    await saveOwners(o);
    console.log('[owner] 已移除', mask(userId), name, 'by', email);
    await setRichMenu(userId, false);
    notifyOwners(`🔔 管理員已移除：${name}（${twTime()}，由 ${email} 操作）`);
    return { ok: true };
  });
}

const PAGE = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理員設定</title><script src="https://accounts.google.com/gsi/client" async defer></script><style>
:root{--bg:#f6f7f5;--card:#fff;--text:#222;--muted:#777;--brand:#4B6B50;--line:#e3e6e2;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#161816;--card:#202320;--text:#eee;--muted:#9a9a9a;--line:#333;--brand:#7fa985}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:16px;cursor:pointer}
button.ghost{background:transparent;color:var(--warn);border:1px solid var(--line);padding:6px 12px;font-size:14px}
.code{font:700 40px/1.2 ui-monospace,monospace;letter-spacing:4px;color:var(--brand);text-align:center;margin:16px 0 8px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}.warn{color:var(--warn)}.ok{color:var(--brand);font-weight:600}
</style></head><body><main>
<h1>管理員設定</h1><div class="muted" id="who"></div>
<div class="card" id="login"><b>請先用 Google 帳號登入</b><p class="muted">只有已授權的老闆帳號可以使用。</p><div id="gbtn"></div><p class="warn" id="loginerr"></p></div>
<div id="app" hidden>
<div class="card"><b>綁定新的管理員</b>
<p class="muted">按下按鈕後，請用要設為管理員的 LINE 帳號，到官方帳號輸入「綁定」，再輸入下面的綁定碼。綁定碼 5 分鐘內有效，只能用一次。</p>
<button id="gen">產生綁定碼</button><div id="codebox"></div></div>
<div class="card"><b>目前的管理員</b><div id="owners" class="muted">讀取中…</div></div>
<div id="kvwarn"></div>
</div>
</main><script>
const CLIENT_ID=__CLIENT_ID__;
let H={'x-admin':'1','Content-Type':'application/json'};
function logout(msg){H.Authorization='';document.getElementById('app').hidden=true;document.getElementById('login').hidden=false;document.getElementById('loginerr').textContent=msg||'';}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:H});if(r.status===403){logout('登入已過期或這個帳號沒有權限，請重新登入。');throw new Error('403')}return r.json();}
window.onload=()=>{google.accounts.id.initialize({client_id:CLIENT_ID,callback:async(res)=>{
  H.Authorization='Bearer '+res.credential;
  try{await loadOwners();document.getElementById('login').hidden=true;document.getElementById('app').hidden=false;}catch{}
}});google.accounts.id.renderButton(document.getElementById('gbtn'),{theme:'outline',size:'large',text:'signin_with'});};
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
let timer=null;
async function loadOwners(){
  const j=await api('/admin/api/owners');
  document.getElementById('who').textContent='登入身分：'+j.email;
  const box=document.getElementById('owners');box.innerHTML='';box.className='';
  if(!j.owners.length){box.append(el('div','muted','還沒有管理員'));}
  for(const o of j.owners){
    const row=el('div','row');const info=el('div');
    info.append(el('div',null,o.name),el('div','muted',o.short+(o.boundAt?'｜'+o.boundAt:'')+(o.boundBy?'｜'+o.boundBy:'')));
    row.append(info);
    if(o.removable){const b=el('button','ghost','移除');b.onclick=async()=>{
      if(!confirm('確定要移除「'+o.name+'」的管理員身分?'))return;
      const j=await api('/admin/api/remove',{method:'POST',body:JSON.stringify({userId:o.id})});if(!j.ok)alert(j.message);loadOwners();};row.append(b);}
    box.append(row);
  }
  document.getElementById('kvwarn').innerHTML='';
  if(!j.persistent)document.getElementById('kvwarn').append(el('p','warn','⚠️ 尚未設定 Cloudflare KV,伺服器重啟後綁定會消失。'));
}
document.getElementById('gen').onclick=async()=>{
  const j=await api('/admin/api/code',{method:'POST'});
  const box=document.getElementById('codebox');box.innerHTML='';
  const c=el('div','code',j.display);const s=el('div','muted');box.append(c,s);
  clearInterval(timer);
  timer=setInterval(async()=>{
    const left=Math.max(0,Math.round((j.expiresAt-Date.now())/1000));
    let st;try{st=await api('/admin/api/code/'+j.code)}catch{clearInterval(timer);return}
    if(st.used){clearInterval(timer);s.className='ok';s.textContent='✅ 已綁定:'+st.name;loadOwners();return}
    if(!left){clearInterval(timer);s.className='warn';s.textContent='已過期,請重新產生';c.style.opacity=.3;return}
    s.textContent='剩下 '+Math.floor(left/60)+' 分 '+(left%60)+' 秒,等待綁定中…';
  },2000);
};
</script></body></html>`;

// ---------- 路由：處理到就回傳 true ----------
async function handle(req, res, url) {
  const path = url.pathname;

  if (req.method === 'POST' && (path === '/api/role' || path === '/api/bind')) {
    if (!apiAuthed(req, url)) { json(res, 401, { status: 'error', message: 'bad token' }); return true; }
    let body; try { body = await readJson(req); } catch { json(res, 400, { status: 'error', message: '請求格式錯誤' }); return true; }
    if (path === '/api/role') { const own = await isOwner(body.userId); json(res, 200, { role: own ? 'owner' : 'customer' }); return true; }
    json(res, 200, await handleBind(body));
    return true;
  }

  if (path === '/admin' && req.method === 'GET') {   // 頁面本身不含任何資料，登入後才呼叫 API
    if (!GOOGLE_CLIENT_ID) { json(res, 503, { error: '尚未設定 GOOGLE_CLIENT_ID' }); return true; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    res.end(PAGE.replace('__CLIENT_ID__', JSON.stringify(GOOGLE_CLIENT_ID))); return true;
  }
  if (path.startsWith('/admin/api/')) {
    const email = await verifyAdmin(req);
    if (!email) { json(res, 403, { error: 'forbidden' }); return true; }
    if (req.headers['x-admin'] !== '1') { json(res, 403, { error: 'forbidden' }); return true; }   // 擋跨站請求
    try {
      if (req.method === 'GET' && path === '/admin/api/owners') { json(res, 200, { email, persistent: KV_ON, owners: await ownerRows() }); return true; }
      if (req.method === 'POST' && path === '/admin/api/code') {
        const code = newCode(email);
        console.log('[owner] 產生綁定碼 by', email);
        json(res, 200, { code, display: showCode(code), expiresAt: codes.get(code).exp }); return true;
      }
      const m = path.match(/^\/admin\/api\/code\/([A-Z0-9]+)$/);
      if (req.method === 'GET' && m) { const c = codes.get(m[1]); json(res, 200, { used: !!c?.usedBy, name: c?.usedName || '' }); return true; }
      if (req.method === 'POST' && path === '/admin/api/remove') {
        const body = await readJson(req);
        json(res, 200, await removeOwner(String(body.userId || ''), email)); return true;
      }
    } catch (e) { console.error('[owner] 管理頁錯誤', e.message); json(res, 500, { ok: false, message: '系統錯誤：' + e.message.slice(0, 100) }); return true; }
    json(res, 404, { error: 'not found' }); return true;
  }
  return false;
}

console.log('[owner] 老闆名單儲存：', KV_ON ? 'Cloudflare KV' : '記憶體（重啟會消失）', '｜管理頁：', GOOGLE_CLIENT_ID && ADMIN_EMAILS.length ? '已設定' : '未設定（無法進入）');
module.exports = { handle, isOwner };
