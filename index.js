// BizForm -> Vital CRM bridge（階段 2）
// 收到 BizForm「表單送出」通知後：
//   1) 用身分證字號找 CRM 客戶，找到就「合併」基本資料，找不到就新增
//   2) 每一份表單都在該客戶底下新增「一則獨立的記事」（不覆蓋舊的）
// 預設 DRY_RUN=1：只在 log 顯示「準備要做什麼」，不會真的寫入 CRM。
const http = require('http');

const VERSION = 'v5-orders';   // 首頁會顯示，用來確認 Render 跑的是哪一版
const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';       // 網址 ?token= 要一致
const BIZFORM_TOKEN = process.env.BIZFORM_TOKEN || '';       // 選填：BizForm 標頭 x-bizform-token 的值
const CRM_STORE = process.env.CRM_STORE || '';
const CRM_API_KEY = process.env.CRM_API_KEY || '';
const CRM_BASE = process.env.CRM_BASE || 'https://crm-storeapi.vitalyun.com';
const DRY_RUN = process.env.DRY_RUN !== '0';                 // 只有明確設成 0 才會真的寫入
const DEBUG = process.env.DEBUG === '1';                     // 開啟 /debug/last（含個資，測完請關閉）
const ORDERS = process.env.ORDERS === '1';                   // 設成 1 才會建立「消費」（預設關閉）
const ORDER_TYPE = process.env.ORDER_TYPE || '';             // 選填：消費類別（必須已存在於 CRM）
const ORDER_STATUS = process.env.ORDER_STATUS || '';         // 選填：消費狀態（必須已存在於 CRM）
const FORM_IDS = (process.env.FORM_IDS || '').split(',').map(s => s.trim()).filter(Boolean); // 選填：只處理這些 formId

// 表單欄位名稱（displayName）對應；之後欄位改名只要改這裡
const F = {
  name: ['姓名', '消費者姓名(以下簡稱甲方)'],
  idNumber: ['國民身分證統一編號/居留證號碼'],
  phone: ['電話(甲方)'],
  email: ['電子郵件'],
  address: ['通訊地址', '地址(甲方消費者)'],
};
const CRM_EXT_ID_KEY = '國民身分證統一編號/居留證號碼'; // CRM 客戶擴充欄位名稱（你的 CRM 已有）
const CRM_EXT_NAME_KEY = '姓名';

const recent = [];
const done = new Set();
let queue = Promise.resolve();

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
const authed = (url) => WEBHOOK_TOKEN && url.searchParams.get('token') === WEBHOOK_TOKEN;

function fieldsOf(body) {
  const out = [];
  for (const a of body?.document?.attributes || []) {
    const v = (a.value || []).map(norm).filter(Boolean).join('、');
    out.push({ label: norm(a.displayName), value: v, readOnly: !!a.readOnly });
  }
  return out;
}
const pick = (fields, labels) => { for (const l of [].concat(labels)) { const v = fields.find(f => f.label === l)?.value; if (v) return v; } return ''; };

function extract(body) {
  const fields = fieldsOf(body);
  const email = pick(fields, F.email);
  const phone = pick(fields, F.phone).replace(/[\s-]/g, '');
  return {
    fields,
    name: pick(fields, F.name),
    idNumber: pick(fields, F.idNumber).toUpperCase().replace(/\s/g, ''),
    phone: /^\+?\d{8,}$/.test(phone) ? phone : '',
    email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '',
    address: pick(fields, F.address),
  };
}

function buildNote(body, p) {
  const idLabels = new Set(Object.values(F).flat());
  const lines = [
    `**${norm(body.formDisplayName)}**`,
    `- 填寫時間：${body.creationTime}`,
    `- 表單單號：#${body.documentId}（v${body.version}）`,
    `- 原始表單：${body.documentUrl}`,
    '',
  ];
  for (const f of p.fields) {
    if (!f.value || f.readOnly || idLabels.has(f.label)) continue;
    lines.push(`- ${f.label}：${f.value}`);
  }
  lines.push('', `<!-- BizForm ${body.depotId}:${body.formId}:${body.documentId}:v${body.version} -->`);
  return lines.join('\n');
}

// ---- 每份表單 → CRM 一筆「消費」 ----
const SERVICE_GROUPS = ['洗澡', '剪毛', '大美容', '小美容', '其他1', '其他2', '其他3', '其他4', '其他5'];
const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : NaN; };
const taipeiDate = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '/'); };

function buildOrder(body, p, customerNo) {
  const get = (l) => pick(p.fields, l);
  const products = [];
  for (const g of SERVICE_GROUPS) {
    const desc = get(`服務內容(${g})`), price = num(get(`單價(${g})`)), times = num(get(`次數(${g})`)), period = get(`期間(${g})`);
    if (!desc && isNaN(price) && isNaN(times)) continue;
    products.push({
      ProductName: g.startsWith('其他') && desc ? desc.slice(0, 50) : g,
      Quantity: isNaN(times) || times <= 0 ? 1 : times,
      UnitPrice: isNaN(price) ? 0 : price,
      ItemDesc: [desc, period && `期間：${period}`].filter(Boolean).join('；'),
    });
  }
  // CRM 規定消費至少要有一筆產品；沒有服務項目的表單（例如契約）放一筆 0 元的代表項目
  if (!products.length) products.push({ ProductName: norm(body.formDisplayName), Quantity: 1, UnitPrice: 0 });
  // 擴充欄位：用「表單欄位名稱」當名稱；CRM「消費」擴充欄位有建同名的才會被填入，沒建的 CRM 會自動忽略
  const skip = new Set(Object.values(F).flat());
  const ext = {};
  for (const f of p.fields) {
    if (!f.value || f.readOnly || skip.has(f.label)) continue;
    if (/^(服務內容|單價|次數|總費用|期間)\(/.test(f.label)) continue;
    ext[f.label] = f.value;
  }
  ext['表單名稱'] = norm(body.formDisplayName);
  ext['表單單號'] = `#${body.documentId}`;
  ext['原始表單'] = body.documentUrl;
  const o = {
    OrderNo: `BF-${body.formId}-${body.documentId}`,   // 同一份表單重送只會更新、不會重複
    CustomerType: 'PersonAccount',
    CustomerNo: customerNo,
    OrderDate: taipeiDate(body.creationTime),
    Products: products,
    ExtendedField: ext,
  };
  if (ORDER_TYPE) o.Type = ORDER_TYPE;
  if (ORDER_STATUS) o.OrderStatusName = ORDER_STATUS;
  return o;
}

function customerBody(p, isNew) {
  const mech = (SubType, Name, Value) => ({ SubType, Name, Value, IsPrimary: isNew ? 'true' : 'false' });
  // 你們的慣例：客戶「姓名」欄放電話（當主鍵），真實姓名放擴充欄位「姓名」
  const b = { CurrentName: p.phone || p.name || p.idNumber, ContactMechs: [], ExtendedField: {} };
  if (p.name) b.ExtendedField[CRM_EXT_NAME_KEY] = p.name;
  if (p.idNumber) b.ExtendedField[CRM_EXT_ID_KEY] = p.idNumber;
  if (p.phone) b.ContactMechs.push(mech('MobilePhone', '手機', p.phone));
  if (p.email) b.ContactMechs.push(mech('Email', '電子郵件', p.email));
  if (p.address) b.ContactMechs.push(mech('PostalAddress', '通訊地址', p.address));
  return b;
}

async function crm(method, path, body) {
  const r = await fetch(`${CRM_BASE}/${CRM_STORE}/api/${path}`, {
    method,
    headers: { Authorization: `ApiKey ${CRM_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let json = null; try { json = await r.json(); } catch {}
  if (!r.ok) throw new Error(`CRM ${method} ${path} -> ${r.status} ${JSON.stringify(json)?.slice(0, 300)}`);
  return json;
}
const deepHas = (v, s) => v === s || (v && typeof v === 'object' && Object.values(v).some(x => deepHas(x, s)));

const ID_RE = /\b[A-Z][12489]\d{8}\b/g;
async function searchCustomers(criteria) {
  const j = await crm('POST', 'customers/search', criteria);
  const arr = Array.isArray(j) ? j : (j?.data ?? j?.Data ?? []);
  return Array.isArray(arr) ? arr : [];
}
// 依「擴充欄位」查客戶。文件寫「字串」，但實際 CRM 回 400，所以依序嘗試幾種格式，找到能用的就記住；
// 全部被拒絕時不丟錯，回傳空陣列，讓流程改用電話比對。
const EXT_FORMATS = [
  (k, v) => ({ [k]: v }),
  (k, v) => [v],
  (k, v) => [{ Key: k, Value: v }],
  (k, v) => [{ Name: k, Value: v }],
];
let extFmt = -1; // -1 尚未確定；>=0 已確定可用的格式；-2 全部被拒絕
async function searchByExtended(key, value) {
  if (extFmt === -2) return [];
  const order = extFmt >= 0 ? [extFmt] : EXT_FORMATS.map((_, i) => i);
  for (const i of order) {
    try {
      const r = await searchCustomers({ ExtendedField: EXT_FORMATS[i](key, value) });
      if (extFmt < 0) { extFmt = i; console.log('[info] ExtendedField 查詢格式可用，編號', i); }
      return r;
    } catch (e) {
      if (!/-> 400/.test(e.message)) throw e;
    }
  }
  if (extFmt < 0) extFmt = -2;
  console.warn('[warn] ExtendedField 查詢格式都被 CRM 拒絕，改用電話比對');
  return [];
}
// 找同一個人：先用身分證，再用電話；電話相同但身分證不同 → 視為不同人，不合併
async function findCustomer(p) {
  const noOf = (h) => h && (h.CustomerNo ?? h.customerNo);
  if (p.idNumber) {
    const hits = (await searchByExtended(CRM_EXT_ID_KEY, p.idNumber)).filter(x => deepHas(x, p.idNumber));
    if (hits.length > 1) console.warn('[warn] 身分證對到多位客戶，使用第一位', hits.length);
    if (hits[0]) return noOf(hits[0]);
  }
  if (p.phone) {
    const byTel = (await searchCustomers({ TelecomNum: p.phone })).filter(x => deepHas(x, p.phone));
    const byName = (await searchCustomers({ CurrentName: p.phone })).filter(x => (x.CurrentName ?? x.currentName) === p.phone); // 舊資料：姓名欄放手機
    const sameOrUnknown = (x) => !p.idNumber || (JSON.stringify(x).match(ID_RE) || []).every(id => id === p.idNumber);
    const seen = new Set();
    const cand = [...byTel, ...byName].filter(sameOrUnknown).filter(x => { const n = noOf(x); if (seen.has(n)) return false; seen.add(n); return true; });
    if (cand.length > 1) console.warn('[warn] 電話對到多位客戶，使用第一位', cand.length);
    if (cand[0]) return noOf(cand[0]);
  }
  return null;
}

async function handleDocument(body) {
  const key = `${body.depotId}:${body.formId}:${body.documentId}:v${body.version}`;
  if (done.has(key)) return { key, skipped: 'duplicate' };
  const p = extract(body);
  if (!p.idNumber && !p.phone) return { key, skipped: '表單沒有身分證字號也沒有有效電話，無法辨識客戶' };
  const note = buildNote(body, p);
  const plan = { key, idNumber: p.idNumber, phone: p.phone, customerCreate: customerBody(p, true), customerMerge: customerBody(p, false), note };
  if (ORDERS) plan.order = buildOrder(body, p, '(客戶編號)');
  if (DRY_RUN) return { ...plan, dryRun: true };

  let no = await findCustomer(p);
  let action = 'merged';
  if (no) {
    await crm('PATCH', `customers/${encodeURIComponent(no)}`, customerBody(p, false));
  } else {
    const j = await crm('POST', 'customers', { CustomerNo: `BF-${p.idNumber || p.phone}`, ...customerBody(p, true) });
    no = j?.data?.CustomerNo ?? j?.CustomerNo;
    if (!no) throw new Error('建立客戶後沒拿到 CustomerNo：' + JSON.stringify(j).slice(0, 200));
    action = 'created';
  }
  await crm('POST', 'notes', { CustomerNo: no, Content: note, IsPublic: false, IsMarkdown: true });
  let order = 'off';
  if (ORDERS) {
    try { await crm('POST', 'orders', buildOrder(body, p, no)); order = 'created'; }
    catch (e) { order = 'failed'; console.error('[error-order]', e.message); }   // 消費失敗不影響客戶與記事
  }
  done.add(key);
  return { key, customerNo: no, customer: action, note: 'created', order };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { ok: true, version: VERSION, dryRun: DRY_RUN });

  if (req.method === 'GET' && url.pathname === '/check-crm') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    const r = await fetch(`${CRM_BASE}/${CRM_STORE}/api/apikey`, { headers: { Authorization: `ApiKey ${CRM_API_KEY}` } });
    return send(res, 200, { crmStatus: r.status, meaning: r.status === 200 ? 'ApiKey 合法' : 'ApiKey 不合法或店點識別碼錯誤' });
  }

  if (req.method === 'POST' && url.pathname === '/webhook/bizform') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    if (BIZFORM_TOKEN && req.headers['x-bizform-token'] !== BIZFORM_TOKEN) return send(res, 401, { error: 'bad bizform token' });
    let raw = ''; for await (const c of req) raw += c;
    let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }
    send(res, 200, { received: true }); // 先回覆，避免 BizForm 等太久
    if (body.eventType !== 'documentCreated') return console.log('[skip] eventType', body.eventType);
    if (FORM_IDS.length && !FORM_IDS.includes(String(body.formId))) return console.log('[skip] formId', body.formId);
    console.log('[webhook] form', body.formId, 'doc', body.documentId, 'v', body.version);
    queue = queue.then(() => handleDocument(body)).then(
      (r) => { console.log('[result]', JSON.stringify(r).slice(0, 600)); if (DEBUG) { recent.unshift({ at: new Date().toISOString(), result: r }); recent.length = Math.min(recent.length, 20); } },
      (e) => console.error('[error]', e.message));   // 單線程依序處理（CRM API 規範）
    return;
  }

  if (req.method === 'GET' && url.pathname === '/debug/last') {
    if (!DEBUG || !authed(url)) return send(res, 404, { error: 'not found' });
    return send(res, 200, recent);
  }
  send(res, 404, { error: 'not found' });
});
server.listen(PORT, () => console.log('listening on', PORT, VERSION, DRY_RUN ? '(DRY_RUN)' : '(LIVE)'));
