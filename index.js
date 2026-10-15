// BizForm -> Vital CRM bridge（階段 2）
// 收到 BizForm「表單送出」通知後：
//   1) 用身分證字號找 CRM 客戶，找到就「合併」基本資料，找不到就新增
//   2) 每一份表單都在該客戶底下新增「一則獨立的記事」（不覆蓋舊的）
// 預設 DRY_RUN=1：只在 log 顯示「準備要做什麼」，不會真的寫入 CRM。
const http = require('http');

const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';       // 網址 ?token= 要一致
const BIZFORM_TOKEN = process.env.BIZFORM_TOKEN || '';       // 選填：BizForm 標頭 x-bizform-token 的值
const CRM_STORE = process.env.CRM_STORE || '';
const CRM_API_KEY = process.env.CRM_API_KEY || '';
const CRM_BASE = process.env.CRM_BASE || 'https://crm-storeapi.vitalyun.com';
const DRY_RUN = process.env.DRY_RUN !== '0';                 // 只有明確設成 0 才會真的寫入
const DEBUG = process.env.DEBUG === '1';                     // 開啟 /debug/last（含個資，測完請關閉）
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

function customerBody(p, isNew) {
  const mech = (SubType, Name, Value) => ({ SubType, Name, Value, IsPrimary: isNew ? 'true' : 'false' });
  const b = { CurrentName: p.name || p.idNumber || p.phone, ContactMechs: [] };
  if (p.idNumber) b.ExtendedField = { [CRM_EXT_ID_KEY]: p.idNumber };
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
// 找同一個人：先用身分證，再用電話；電話相同但身分證不同 → 視為不同人，不合併
async function findCustomer(p) {
  const noOf = (h) => h && (h.CustomerNo ?? h.customerNo);
  if (p.idNumber) {
    const hits = (await searchCustomers({ ExtendedField: p.idNumber })).filter(x => deepHas(x, p.idNumber));
    if (hits.length > 1) console.warn('[warn] 身分證對到多位客戶，使用第一位', hits.length);
    if (hits[0]) return noOf(hits[0]);
  }
  if (p.phone) {
    const byTel = (await searchCustomers({ TelecomNum: p.phone })).filter(x => deepHas(x, p.phone));
    const byName = (await searchCustomers({ CurrentName: p.phone })).filter(x => (x.CurrentName ?? x.currentName) === p.phone); // 舊資料：姓名欄放手機
    const sameOrUnknown = (x) => !p.idNumber || (JSON.stringify(x).match(ID_RE) || []).every(id => id === p.idNumber);
    const cand = [...byTel, ...byName].filter(sameOrUnknown);
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
  done.add(key);
  return { key, customerNo: no, customer: action, note: 'created' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { ok: true, dryRun: DRY_RUN });

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
server.listen(PORT, () => console.log('listening on', PORT, DRY_RUN ? '(DRY_RUN)' : '(LIVE)'));
