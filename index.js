// BizForm -> Vital CRM bridge（階段 2）
// 收到 BizForm「表單送出」通知後：
//   1) 用身分證字號找 CRM 客戶，找到就「合併」基本資料，找不到就新增
//   2) 每一份表單都在該客戶底下新增「一則獨立的記事」（不覆蓋舊的）
// 預設 DRY_RUN=1：只在 log 顯示「準備要做什麼」，不會真的寫入 CRM。
// v7 新增「老闆助手」API（給 iota C.ai 呼叫）：
//   POST /api/segment      依 AI 解析出的條件，合併「顧客 + 消費/預約」資料後用程式篩選名單
//   POST /api/coupon/send  老闆確認後，對選定的顧客發送優惠券
//   GET  /api/status       檢查資料是否讀得到（只回筆數，不含個資）
const http = require('http');
const crypto = require('crypto');

const VERSION = 'v7-boss-coupon';     // 首頁會顯示，用來確認 Render 跑的是哪一版
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

// ---- 一次性：在 CRM 建立「訂單」擴充欄位（只新增欄位，不動任何資料）----
// 欄位名稱 = 表單欄位名稱（過長的契約條文、服務項目、身分欄位不建）。已存在的會被 CRM 拒絕(400)，視為「已存在」。
const BASE_ORDER_FIELDS = ["姓名", "國民身分證統一編號/居留證號碼", "電話(甲方)", "緊急聯絡人", "緊急聯絡人電話", "通訊地址", "是否為飼主本人", "與飼主關係", "公司/商號名稱", "代表人/負責人姓名", "營業時間", "電話(乙方)", "營業地址", "寵物名", "性別(公、母)", "犬、貓年齡", "犬、貓品種", "種類(貓、狗)", "絕育(有、無)", "晶片號碼", "犬、貓個性傾向(其他)", "外觀", "異常狀況", "其他", "病史(其他)", "金額(新臺幣)", "名稱(甲)", "名稱(乙)", "電話(甲)", "電話(乙)", "地址(甲)", "地址(乙)", "乙方指定獸醫診療機構", "親近人", "親近狗", "親近貓", "有攻擊性", "會咬貓", "會咬狗", "會咬人", "容易緊張", "心臟病", "氣喘", "氣管塌陷", "白內障", "癲癇", "手術外傷未癒合", "髖關節問題", "骨折", "腸炎", "血便", "腹膜炎", "艾利希體", "心絲蟲", "腹積水", "傳染性疾病", "懷孕", "血尿", "支付方式(現金、信用卡、其他)", "有無外寄生蟲", "電子郵件", "地址(甲方消費者)", "現金", "其他付款方式", "信用卡", "消費者姓名(以下簡稱甲方)", "年(簽約)"];
const seenLabels = new Set();   // webhook 進來時順便記下看過的欄位名稱（只記名稱，不記內容）
async function createOrderFields(extra = [], dry = false) {
  const skip = new Set(Object.values(F).flat());
  const all = [...new Set([...BASE_ORDER_FIELDS, '表單名稱', '表單單號', '原始表單', ...seenLabels, ...extra])]
    .filter(l => l && l.length <= 30 && !skip.has(l) && !/^(服務內容|單價|次數|總費用|期間)\(/.test(l));
  const out = { created: [], exists_or_rejected: [], planned: dry ? all : undefined };
  if (dry) return out;
  for (const name of all) {   // 單線程依序
    try {
      await crm('POST', 'extendedattrs', { Name: name, DefaultValue: '', IsRequired: 'False', Domain: 'Order', AttrType: 'TextBox', IsMultiLines: 'False', MaxLength: '255' });
      out.created.push(name);
    } catch (e) { out.exists_or_rejected.push(name + ' :: ' + e.message.slice(0, 120)); }
  }
  return out;
}

// =====================================================================
// v7：老闆助手（篩選顧客名單 + 發送優惠券）
// 設計原則：AI 只負責「把老闆的話翻成條件 JSON」，篩選與計算全部由這裡的程式做，
//           顧客資料（含 CustomerNo）不會送給任何 LLM。
// =====================================================================
const API_TOKEN = process.env.API_TOKEN || WEBHOOK_TOKEN;                  // iota 呼叫時帶 header x-api-token 或 ?token=
const ORDER_SEARCH_PATH = process.env.ORDER_SEARCH_PATH || 'orders/search'; // ⚠ 請對照 Vital CRM API 文件確認
const ORDER_SEARCH_BODY = (() => { try { return JSON.parse(process.env.ORDER_SEARCH_BODY || '{"OrderDateFrom":"2000/01/01"}'); } catch { return { OrderDateFrom: '2000/01/01' }; } })();
const CUSTOMER_SEARCH_BODY = { CreateDateFrom: '2000/01/01' };
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const SNAPSHOT_TTL = 5 * 60 * 1000;     // CRM 資料快取 5 分鐘，避免每問一句就把 CRM 全部重抓
const SEGMENT_TTL = 30 * 60 * 1000;     // 篩出來的名單保留 30 分鐘等老闆確認
const LIST_SHOW_MAX = 30;               // LINE 訊息最多列出幾位（其餘仍可「全部發送」）
const DEFAULT_COUPON = process.env.DEFAULT_COUPON || '回娘家優惠券';
const COUPON_DRY_RUN = process.env.COUPON_DRY_RUN !== '0';   // 優惠券獨立的測試開關：只有設成 0 才會真的發（不影響 BizForm 的 DRY_RUN）
const DAY = 86400000;

const apiAuthed = (req, url) => !!API_TOKEN && (url.searchParams.get('token') === API_TOKEN || req.headers['x-api-token'] === API_TOKEN);
const sendCompact = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
async function readJson(req) { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw || '{}'); }
// 跟 webhook 共用同一條佇列：CRM API 規範要求單線程依序呼叫
function serial(fn) { const p = queue.then(() => fn()); queue = p.then(() => {}, () => {}); return p; }

// ---- 日期工具（支援 2026/10/16、2026-10-16、民國 115/10/16）----
function parseDay(s) {
  const m = String(s ?? '').match(/(\d{2,4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  if (!m) return null;
  let y = +m[1]; if (y < 1911) y += 1911;
  const t = Date.UTC(y, +m[2] - 1, +m[3]);
  return Number.isNaN(t) ? null : t;
}
const todayDay = () => parseDay(taipeiDate(new Date().toISOString()));
const fmtDay = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`; };
const numOrNull = (s) => { const n = num(s); return Number.isFinite(n) ? n : null; };
const money = (n) => 'NT$' + Math.round(n || 0).toLocaleString('en-US');

// ---- 讀取全部頁數 ----
async function fetchAll(path, criteria, keyOf) {
  const all = [], seen = new Set();
  for (let page = 1; page <= 200; page++) {
    const j = await crm('POST', path, { ...criteria, Page: page, PageSize: PAGE_SIZE });
    const arr = Array.isArray(j) ? j : (j?.data ?? j?.Data ?? []);
    if (!Array.isArray(arr) || !arr.length) break;
    let added = 0;
    for (const x of arr) { const k = keyOf(x) ?? JSON.stringify(x); if (seen.has(k)) continue; seen.add(k); all.push(x); added++; }
    if (!added) break;   // 沒有新資料（API 忽略 Page）。注意：orders/search 每頁固定 10 筆，不能用「少於 PageSize」判斷最後一頁
  }
  return all;
}

// ---- 訂單（預約）：查詢條件格式不確定，依序試幾種，第一個抓得到資料的就記住 ----
const ORDER_BODY_CANDIDATES = [
  ...(process.env.ORDER_SEARCH_BODY ? [ORDER_SEARCH_BODY] : []),
  { CustomerType: 'PersonAccount', CreateDate: { From: '2000/01/01', To: '2099/12/31' } },   // LINE 綁定 Apps Script 實測可用的格式
  { CustomerType: 'PersonAccount' },
  {},
  { OrderDateFrom: '2000/01/01' },
  { CreateDateFrom: '2000/01/01' },
  { OrderDateFrom: '2000/01/01', OrderDateTo: '2099/12/31' },
  { CreateDateFrom: '2000/01/01', CreateDateTo: '2099/12/31' },
];
let orderBodyIdx = -1;
const orderKey = (o) => o.OrderNo ?? o.orderNo ?? o.Number ?? o.number ?? o.OrderNumber ?? o.OrderId ?? o.Id;
async function fetchOrders() {
  const order = orderBodyIdx >= 0 ? [orderBodyIdx] : ORDER_BODY_CANDIDATES.map((_, i) => i);
  let lastErr = null;
  for (const i of order) {
    try {
      const arr = await fetchAll(ORDER_SEARCH_PATH, ORDER_BODY_CANDIDATES[i], orderKey);
      if (arr.length) {
        if (orderBodyIdx !== i) console.log('[info] 訂單查詢條件可用，編號', i);
        orderBodyIdx = i;
        // 列表資料可能沒有擴充欄位／產品明細 → 用編號讀完整資料（跟 LINE 綁定 Apps Script 的 getOrder_ 一樣）
        const full = [];
        for (const o of arr) {
          const no = orderKey(o);
          const hasExt = Object.keys(extOf(o)).length > 0;
          const hasItems = (o.Products || o.products || o.Items || o.items || []).length > 0;
          if (no && (!hasExt || !hasItems)) {
            try {
              const j = await crm('GET', `orders/${encodeURIComponent(no)}`);
              const d = j?.data ?? j?.Data ?? j;
              const one = Array.isArray(d) ? d[0] : d;
              full.push(one && typeof one === 'object' ? { ...o, ...one } : o);
              continue;
            } catch (e) { console.warn('[warn-order-detail]', no, e.message.slice(0, 120)); }
          }
          full.push(o);
        }
        return full;
      }
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return [];
}

// ---- 合併「顧客」與「消費/預約」→ 每位顧客一筆特徵 ----
const SERVICES = ['洗澡', '剪毛', '大美容', '小美容'];
const extOf = (o) => (o && (o.ExtendedField || o.extendedField)) || {};
const custNoOf = (o) => o && (o.CustomerNo ?? o.customerNo ?? o.Customer?.CustomerNo);
const isPhoneLike = (s) => /^[0-9+\-\s()]{8,}$/.test(String(s ?? '').trim());
const firstVal = (...vals) => vals.find(v => v !== undefined && v !== null && String(v).trim() !== '');
const normKind = (s) => { const t = String(s ?? ''); return /犬|狗/.test(t) ? '狗' : /貓/.test(t) ? '貓' : t.trim(); };
// LINE userId：跟 LINE 綁定 Apps Script 的 getLineId_ 讀法一樣（存在客戶的 GeneralIdentities.Line）
function lineIdOf(c) {
  for (const k of ['GeneralIdentities', 'generalIdentities', 'Identities', 'ExternalIdentities']) {
    const box = c?.[k];
    if (!box) continue;
    if (Array.isArray(box)) {
      for (const it of box) {
        const key = it?.Key ?? it?.key ?? it?.Name ?? it?.name ?? it?.Type ?? it?.type ?? it?.IdentityType;
        if (/^line$/i.test(String(key || ''))) { const v = it?.Value ?? it?.value ?? it?.Id ?? it?.id ?? it?.Identity; if (v) return String(v); }
      }
    } else if (typeof box === 'object') {
      const v = box.Line ?? box.line ?? box.LINE;
      if (v) return String(v);
    }
  }
  return '';
}
const labelText = (l) => typeof l === 'string' ? l : (l?.Name ?? l?.name ?? l?.LabelName ?? '');

function buildProfiles(customers, orders) {
  const today = todayDay();
  const byCust = new Map();
  for (const o of orders) { const no = custNoOf(o); if (!no) continue; if (!byCust.has(no)) byCust.set(no, []); byCust.get(no).push(o); }

  return customers.map((c) => {
    const no = custNoOf(c), ce = extOf(c);
    const counts = { 洗澡: 0, 剪毛: 0, 大美容: 0, 小美容: 0, 其他: 0 };
    const visits = []; let upcoming = false; let latest = null;

    for (const o of byCust.get(no) || []) {
      const oe = extOf(o);
      if (/取消/.test(String(oe['確認/取消'] ?? '') + String(o.OrderStatusName ?? o.OrderStatus ?? o.Status ?? ''))) continue;
      // 預約日：優先用「預約時段」（例如 2026-10-18 16:00），沒有才用來訪日期、訂單日期
      const day = parseDay(oe['預約時段']) ?? parseDay(o['預約時段']) ?? parseDay(oe['來訪日期']) ?? parseDay(o.OrderDate ?? o.orderDate);
      if (day == null) continue;
      if (day > today) { upcoming = true; continue; }          // 未來的日期 = 已預約、還沒來
      const items = o.Products || o.products || o.OrderItems || o.Items || [];
      let sum = 0, isService = false;
      for (const p of items) {
        const name = String(p.ProductName ?? p.productName ?? p.Name ?? '');
        const qty = Number(p.Quantity ?? p.quantity ?? 1) || 1;
        const price = Number(p.UnitPrice ?? p.unitPrice ?? p.Price ?? 0) || 0;
        sum += qty * price;
        if (SERVICES.includes(name)) { counts[name] += qty; isService = true; }
        else if (price > 0) { counts.其他 += qty; isService = true; }   // 契約等 0 元代表項目不算服務
      }
      const total = Number(o.TotalAmount ?? o.OrderTotal ?? o.OrderAmount ?? o.Amount ?? o.Total ?? NaN);
      const amount = Number.isFinite(total) && total > 0 ? total : sum;
      if (!isService && amount <= 0) continue;                  // 純契約/資料表單不算一次來訪
      visits.push({ day, amount });
      if (!latest || day >= latest.day) latest = { day, ext: oe };
    }

    let source = 'orders';
    let visitCount = visits.length;
    let total = visits.reduce((s, v) => s + v.amount, 0);
    let last = visits.length ? Math.max(...visits.map(v => v.day)) : null;
    let first = visits.length ? Math.min(...visits.map(v => v.day)) : null;
    let recent90 = visits.filter(v => today - v.day <= 90 * DAY).reduce((s, v) => s + v.amount, 0);

    if (!visitCount) {
      // 後備：還沒有消費紀錄時，改讀顧客擴充欄位上的彙總（舊版資料放法）
      source = 'customer';
      for (const s of SERVICES) counts[s] = numOrNull(ce[`次數(${s})`]) || 0;
      for (let i = 1; i <= 5; i++) counts.其他 += numOrNull(ce[`次數(其他${i})`]) || 0;
      const fees = SERVICE_GROUPS.map(g => numOrNull(ce[`總費用(${g})`])).filter(v => v != null);
      total = fees.length ? fees.reduce((a, b) => a + b, 0) : (numOrNull(ce['金額(新臺幣)']) || 0);
      last = parseDay(ce['來訪日期']);
      if (last != null && last > today) { upcoming = true; last = null; }
      first = null; recent90 = null;
      const svc = Object.values(counts).reduce((a, b) => a + b, 0);
      visitCount = svc || (last != null ? 1 : 0);
    }

    const le = latest?.ext || {};
    return {
      id: no,                                   // 內部用，不會出現在給老闆的訊息裡，也不會給 LLM
      姓名: firstVal(ce['姓名'], isPhoneLike(c.CurrentName) ? undefined : c.CurrentName) || '（未填姓名）',
      寵物名: firstVal(ce['寵物名'], le['寵物名']) || '',
      種類: normKind(firstVal(ce['種類(貓、狗)'], le['種類(貓、狗)'])),
      品種: String(firstVal(ce['犬、貓品種'], le['犬、貓品種']) || ''),
      寵物年齡: numOrNull(firstVal(ce['犬、貓年齡'], le['犬、貓年齡'])),
      RFM分群: String(ce['RFM模型分群'] || ''),
      標籤: (Array.isArray(c.Labels) ? c.Labels : []).map(labelText).filter(Boolean),
      來訪次數: visitCount,
      總消費: total,
      平均客單價: visitCount ? Math.round(total / visitCount) : null,
      近90天消費: recent90,
      最後來訪日: last,
      距上次來訪天數: last != null ? Math.round((today - last) / DAY) : null,
      距首次來訪天數: first != null ? Math.round((today - first) / DAY) : null,
      有未來預約: upcoming,
      洗澡次數: counts.洗澡, 剪毛次數: counts.剪毛, 大美容次數: counts.大美容, 小美容次數: counts.小美容, 其他服務次數: counts.其他,
      lineId: lineIdOf(c),
      _source: source,
    };
  });
}

let snapshot = null;
async function loadSnapshot(force = false) {
  if (!force && snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL) return snapshot;
  return serial(async () => {
    const customers = await fetchAll('customers/search', CUSTOMER_SEARCH_BODY, custNoOf);
    let orders = [], warning = '';
    try {
      orders = await fetchOrders();
    } catch (e) {
      warning = '讀不到消費/預約資料，暫時改用顧客欄位上的彙總資料';
      console.warn('[warn-orders]', e.message);
    }
    snapshot = { at: Date.now(), customers: customers.length, orders: orders.length, warning, profiles: buildProfiles(customers, orders) };
    return snapshot;
  });
}

// ---- 條件驗證與篩選（白名單：AI 給錯欄位或運算子一律擋掉）----
const FIELD_TYPES = {
  距上次來訪天數: 'number', 距首次來訪天數: 'number', 來訪次數: 'number', 總消費: 'number', 平均客單價: 'number', 近90天消費: 'number',
  洗澡次數: 'number', 剪毛次數: 'number', 大美容次數: 'number', 小美容次數: 'number', 其他服務次數: 'number', 寵物年齡: 'number',
  種類: 'text', 品種: 'text', RFM分群: 'text', 寵物名: 'text', 姓名: 'text',
  標籤: 'list', 有未來預約: 'bool', 最後來訪日: 'date',
};
const OP_TEXT = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '=': '=', '!=': '≠', contains: '包含', not_contains: '不包含', is_empty: '沒有資料', not_empty: '有資料' };
const NO_VALUE_OPS = ['is_empty', 'not_empty'];

function validateFilters(list) {
  const ok = [], bad = [];
  for (const f of Array.isArray(list) ? list : []) {
    const type = FIELD_TYPES[f?.field];
    const value = f?.value == null ? '' : String(f.value).trim();
    if (!type || !OP_TEXT[f?.op]) { bad.push(f); continue; }
    if (!NO_VALUE_OPS.includes(f.op)) {
      if (type === 'number' && !Number.isFinite(num(value))) { bad.push(f); continue; }
      if (type === 'date' && parseDay(value) == null) { bad.push(f); continue; }
      if ((type === 'number' || type === 'date') && /contains/.test(f.op)) { bad.push(f); continue; }
      if (type !== 'bool' && value === '') { bad.push(f); continue; }
    }
    ok.push({ field: f.field, op: f.op, value: f.field === '種類' ? normKind(value) : value });
  }
  return { ok, bad };
}

function matchOne(p, f) {
  const type = FIELD_TYPES[f.field], v = p[f.field];
  const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  if (f.op === 'is_empty') return empty;
  if (f.op === 'not_empty') return !empty;
  if (type === 'bool') { const eq = !!v === /^(true|是|有|1)$/i.test(f.value); return f.op === '!=' ? !eq : eq; }
  if (empty) return false;                                  // 沒資料的不算符合（不把空白當 0）
  if (type === 'number' || type === 'date') {
    const t = type === 'date' ? parseDay(f.value) : num(f.value);
    switch (f.op) { case '>=': return v >= t; case '<=': return v <= t; case '>': return v > t; case '<': return v < t; case '=': return v === t; case '!=': return v !== t; default: return false; }
  }
  const vals = (Array.isArray(v) ? v : [v]).map(x => String(x));
  const has = vals.some(x => x.includes(f.value)), eq = vals.some(x => x === f.value);
  switch (f.op) { case '=': return eq; case '!=': return !eq; case 'contains': return has; case 'not_contains': return !has; default: return false; }
}

const condText = (f) => `${f.field} ${OP_TEXT[f.op]}${NO_VALUE_OPS.includes(f.op) ? '' : ' ' + f.value}`;
// 名單不存在伺服器記憶體（Render 重啟或休眠就會消失）。segmentId 只放「篩選條件＋人數」並加上簽章，
// 長度約 80 字元，不怕 iota 變數長度限制；發送時用同樣條件重新篩一次，人數不同就請老闆重新查詢。
const SIGN_KEY = () => API_TOKEN || CRM_API_KEY || 'dev-only-key';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (data) => b64u(crypto.createHmac('sha256', SIGN_KEY()).update(data).digest()).slice(0, 12);
const FIELD_LIST = Object.keys(FIELD_TYPES), OP_LIST = Object.keys(OP_TEXT);
function packSegment(q) {
  const arr = [Math.floor(Date.now() / 1000).toString(36), q.coupon === DEFAULT_COUPON ? '' : q.coupon,
    q.sortField ? FIELD_LIST.indexOf(q.sortField) : -1, q.sortOrder === 'asc' ? 1 : 0, q.limit, q.count,
    q.filters.map(f => [FIELD_LIST.indexOf(f.field), OP_LIST.indexOf(f.op), f.value])];
  const data = b64u(JSON.stringify(arr));
  return data + '.' + sign(data);
}
function unpackSegment(token) {
  const [data, sig] = String(token || '').trim().split('.');
  if (!data || !sig || sign(data) !== sig) return null;
  try {
    const [t, c, si, so, limit, count, fs] = JSON.parse(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return {
      at: parseInt(t, 36) * 1000, coupon: c || DEFAULT_COUPON, limit, count,
      sortField: si >= 0 ? FIELD_LIST[si] : null, sortOrder: so === 1 ? 'asc' : 'desc',
      filters: fs.map(([fi, oi, value]) => ({ field: FIELD_LIST[fi], op: OP_LIST[oi], value })),
    };
  } catch { return null; }
}
function runSegment(profiles, q) {
  let list = profiles.filter(p => q.filters.every(f => matchOne(p, f)));
  if (q.sortField) {
    const dir = q.sortOrder === 'asc' ? 1 : -1;
    list = list.filter(p => p[q.sortField] != null).sort((a, b) => (a[q.sortField] - b[q.sortField]) * dir);
  }
  return q.limit ? list.slice(0, q.limit) : list;
}
const usedSegments = new Set();   // 盡量避免同一份名單被重複發送（伺服器重啟後會清空）

function profileLine(p, i) {
  const pet = [p.寵物名, p.種類].filter(Boolean).join(' ');
  const last = p.最後來訪日 != null ? `上次 ${fmtDay(p.最後來訪日)}（${p.距上次來訪天數} 天前）` : '無來訪日期';
  return `${i + 1}. ${p.姓名}${pet ? '｜' + pet : ''}｜${last}｜來 ${p.來訪次數} 次｜${money(p.總消費)}`;
}

async function handleSegment(body) {
  if (body?.error) return { status: 'error', message: 'AI 沒有成功理解這句話，請換個說法再試一次。' };
  if (body?.intent === 'other') return { status: 'other', message: '這個問題不是「篩選顧客」的需求喔。\n\n可以試試：\n• 找出半年沒來、洗澡 5 次以上的狗狗\n• 消費最高的前 10 位顧客\n• 這個月有來、但還沒預約下次的貓咪' };
  if (body?.intent === 'clarify') return { status: 'clarify', message: body.clarify_question || '可以再說清楚一點要找哪些顧客嗎？' };

  const { ok, bad } = validateFilters(body?.filters);
  const sortField = (FIELD_TYPES[body?.sort_field] === 'number' || body?.sort_field === '最後來訪日') ? body.sort_field : null;
  const limit = Math.max(0, Math.min(500, parseInt(body?.limit, 10) || 0));
  if (!ok.length && !(sortField && limit)) {
    return { status: 'clarify', message: '我沒辦法從這句話整理出篩選條件 🙏\n請說明要找哪些顧客，例如「三個月沒來的貓咪」。' };
  }

  const snap = await loadSnapshot();
  const q = { filters: ok, sortField, sortOrder: body.sort_order === 'asc' ? 'asc' : 'desc', limit };
  const list = runSegment(snap.profiles, q);

  const head = [`🎯 條件：${body.summary || ok.map(condText).join('、')}`];
  const detail = ok.map(condText);
  if (sortField) detail.push(`依${sortField}${body.sort_order === 'asc' ? '由低到高' : '由高到低'}${limit ? `取前 ${limit} 位` : ''}`);
  head.push('（' + detail.join('；') + '）');
  if (bad.length) head.push(`⚠️ 有 ${bad.length} 個條件無法辨識，已略過`);
  if (snap.warning) head.push(`⚠️ ${snap.warning}`);

  if (!list.length) return { status: 'empty', message: [...head, '', '👤 沒有符合條件的顧客。'].join('\n') };

  const coupon = String(body.coupon_name || '').trim() || DEFAULT_COUPON;
  const segmentId = packSegment({ ...q, coupon, count: list.length });

  const lines = [...head, `👤 符合 ${list.length} 位顧客`, ''];
  list.slice(0, LIST_SHOW_MAX).forEach((p, i) => lines.push(profileLine(p, i)));
  if (list.length > LIST_SHOW_MAX) lines.push(`…其餘 ${list.length - LIST_SHOW_MAX} 位未列出（選「全部發送」會一起發）`);
  lines.push('', `🎟️ 優惠券：${coupon}`);
  return { status: 'ok', segmentId, count: list.length, message: lines.join('\n') };
}

// ---- 實際發券：有綁 LINE 的顧客推播 LINE 訊息，每位顧客都在 CRM 留一則記事（可追蹤誰拿過券）----
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';   // LINE Developers → 你的 Messaging API channel → Channel access token
const LINE_API_BASE = process.env.LINE_API_BASE || 'https://api.line.me';
const SHOP_NAME = process.env.SHOP_NAME || '寵此安心';
const COUPON_VALID_DAYS = Number(process.env.COUPON_VALID_DAYS || 30);

function couponText(target, coupon, expire) {
  const pet = target.寵物名 ? `${target.寵物名}好久不見，我們很想念牠喔！\n` : '';
  return `🎟️ ${SHOP_NAME}送您一張「${coupon}」\n\n${pet}預約時出示這則訊息即可使用。\n有效期限：${expire}\n\n期待再次見到你們 🐾`;
}

async function pushLine(userId, text) {
  const r = await fetch(`${LINE_API_BASE}/v2/bot/message/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`LINE ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function deliverCoupon(target, coupon) {
  const expire = fmtDay(todayDay() + COUPON_VALID_DAYS * DAY);
  let line = 'none';      // none = 沒綁 LINE；sent = 已推播；failed = 推播失敗；off = 伺服器沒設定 LINE token
  let lineErr = '';
  if (target.lineId) {
    if (!LINE_TOKEN) line = 'off';
    else {
      try { await pushLine(target.lineId, couponText(target, coupon, expire)); line = 'sent'; }
      catch (e) { line = 'failed'; lineErr = e.message; console.error('[error-line]', target.id, e.message); }
    }
  }
  const lineText = { none: '顧客未綁定 LINE', sent: '已推播', failed: `推播失敗（${lineErr.slice(0, 80)}）`, off: '伺服器未設定 LINE，未推播' }[line];
  await crm('POST', 'notes', {
    CustomerNo: target.id,
    Content: `**🎟️ 發送優惠券：${coupon}**\n- 有效期限：${expire}\n- LINE：${lineText}\n- 發送時間：${new Date().toISOString()}\n- 來源：老闆助手（iota C.ai）`,
    IsPublic: false, IsMarkdown: true,
  });
  return line;
}

async function handleSend(body) {
  const seg = unpackSegment(body?.segmentId);
  if (!seg) {
    console.warn('[warn-segment] 無法辨識的 segmentId，長度', String(body?.segmentId || '').length, String(body?.segmentId || '').slice(0, 20));
    return { status: 'expired', message: `這份名單無法辨識，請重新查詢一次。（收到的名單代碼長度：${String(body?.segmentId || '').length}）` };
  }
  if (Date.now() - seg.at > SEGMENT_TTL) return { status: 'expired', message: '這份名單已超過 30 分鐘，請重新查詢一次，確保名單是最新的。' };
  if (usedSegments.has(body.segmentId)) return { status: 'expired', message: '這份名單已經發送過了，不會重複發送。' };
  // 用同樣的條件重新篩一次，人數要跟老闆看到的一樣才發
  const items = runSegment((await loadSnapshot()).profiles, seg).map(p => ({ id: p.id, 姓名: p.姓名, 寵物名: p.寵物名, lineId: p.lineId }));
  if (items.length !== seg.count) return { status: 'expired', message: `名單有變動（原本 ${seg.count} 位，現在 ${items.length} 位），請重新查詢一次再發送。` };
  const n = items.length;
  let idx = body.pick === 'all' ? items.map((_, i) => i + 1) : (Array.isArray(body.pick) ? body.pick : []).map(Number);
  const ex = new Set((Array.isArray(body.exclude) ? body.exclude : []).map(Number));
  idx = [...new Set(idx)].filter(i => Number.isInteger(i) && i >= 1 && i <= n && !ex.has(i));
  if (!idx.length) return { status: 'invalid', message: `沒有選到任何顧客，請輸入 1～${n} 之間的編號，例如：1,3,5 或 1-10。` };

  const targets = idx.map(i => items[i - 1]);
  const coupon = String(body.coupon || seg.coupon).slice(0, 50);
  const preview = targets.slice(0, 10).map(t => '• ' + t.姓名 + (t.lineId ? '（LINE ✓）' : '（未綁 LINE）')).join('\n') + (targets.length > 10 ? `\n…等 ${targets.length} 位` : '');

  if (COUPON_DRY_RUN) return { status: 'dry_run', message: `🧪 測試模式：預計發送「${coupon}」給 ${targets.length} 位顧客\n${preview}\n\n（Render 環境變數 COUPON_DRY_RUN=0 才會真的發送）${LINE_TOKEN ? '' : '\n⚠️ 尚未設定 LINE_CHANNEL_ACCESS_TOKEN，發送時不會推播 LINE'}` };

  usedSegments.add(body.segmentId);   // 先記下來，避免老闆連按兩次重複發送
  const r = await serial(async () => {
    const out = { ok: 0, fail: [], line: { sent: 0, none: 0, failed: 0, off: 0 } };
    for (const t of targets) {
      try { const l = await deliverCoupon(t, coupon); out.line[l]++; out.ok++; }
      catch (e) { out.fail.push(t.姓名); console.error('[error-coupon]', e.message); }
    }
    return out;
  });
  return {
    status: 'sent',
    message: `✅ 已發送「${coupon}」給 ${r.ok} 位顧客（已記錄在 CRM）`
      + `\n📱 LINE 推播成功 ${r.line.sent} 位` + (r.line.none ? `，${r.line.none} 位未綁定 LINE` : '')
      + (r.line.failed ? `\n⚠️ LINE 推播失敗 ${r.line.failed} 位` : '')
      + (r.line.off ? `\n⚠️ 伺服器尚未設定 LINE，有 ${r.line.off} 位綁定 LINE 的顧客沒有推播` : '')
      + (r.fail.length ? `\n⚠️ ${r.fail.length} 位失敗：${r.fail.slice(0, 10).join('、')}` : ''),
  };
}

// =====================================================================
// 測試資料：12 位測試顧客 + 30 筆「過去」的預約訂單
// - 全部是過去日期、不填行事曆事件ID → 不會佔用 Google 日曆上 open 的時段
// - 顧客編號 TEST-C01…、訂單編號 TEST-ORD-001…、姓名前面加「測試-」，之後好找好刪
// - 日期以「執行當天」往前推，所以「幾天前」永遠符合設計
// - 預設 dry=1 只顯示計畫；網址加 &dry=0 才寫入。重跑同一個訂單編號只會更新、不會重複
// =====================================================================
const PRICE = { 洗澡: 600, 剪毛: 900, 大美容: 1500, 小美容: 1000 };
// [編號, 姓名, 寵物名, 種類, 品種, 年齡, 預約紀錄: [幾天前, 服務, 是否取消]]
const SEED = [
  ['01', '王小明', '小柴', '狗', '柴犬', '4歲',   [[440,'洗澡'],[380,'洗澡'],[320,'洗澡'],[260,'洗澡'],[200,'洗澡']]],  // 洗澡熟客，半年沒來
  ['02', '陳美玲', '奶油', '狗', '貴賓', '3歲',   [[140,'大美容'],[95,'大美容'],[55,'大美容'],[20,'大美容']]],        // 高消費、活躍
  ['03', '林志豪', '咪咪', '貓', '英短', '2歲',   [[250,'洗澡'],[170,'洗澡'],[100,'洗澡']]],                          // 貓，三個月沒來
  ['04', '張雅婷', '阿福', '狗', '米克斯', '1歲', [[10,'洗澡']]],                                                    // 新客
  ['05', '黃俊傑', '雪球', '貓', '布偶', '5歲',   [[360,'大美容'],[300,'洗澡']]],                                     // 流失
  ['06', '吳佩珊', '豆豆', '狗', '柴犬', '6歲',   [[180,'剪毛'],[120,'剪毛'],[60,'剪毛']]],                           // 剪毛，兩個月沒來
  ['07', '劉家豪', '可可', '狗', '貴賓', '2歲',   [[90,'大美容'],[50,'小美容'],[15,'大美容']]],                       // 活躍
  ['08', '蔡宜君', '花花', '貓', '美短', '4歲',   [[210,'洗澡'],[150,'洗澡',true]]],                                  // 有一筆取消
  ['09', '鄭宇翔', '球球', '狗', '博美', '8歲',   [[400,'小美容']]],                                                  // 一年多前來一次
  ['10', '許淑芬', '黑糖', '貓', '米克斯', '3歲', [[120,'洗澡'],[45,'洗澡']]],
  ['11', '謝明哲', '短腿', '狗', '柯基', '3歲',   [[260,'大美容'],[190,'大美容']]],                                   // 大美容，半年沒來
  ['12', '洪詩涵', '糖糖', '狗', '馬爾濟斯', '1歲', [[25,'洗澡',true],[5,'洗澡']]],                                   // 新客，有一筆取消
];
const SLOTS = ['09:00', '11:00', '13:00', '15:00'];

function seedPlan() {
  const today = todayDay();
  const customers = [], orders = [];
  let n = 0;
  for (const [id, name, pet, kind, breed, age, visits] of SEED) {
    const customerNo = `TEST-C${id}`, phone = `09990000${id}`;
    const petExt = { 寵物名: pet, '種類(貓、狗)': kind, '犬、貓品種': breed, '犬、貓年齡': age };
    customers.push({
      CustomerNo: customerNo, CurrentName: phone,
      ContactMechs: [{ SubType: 'MobilePhone', Name: '手機', Value: phone, IsPrimary: 'true' }],
      ExtendedField: { [CRM_EXT_NAME_KEY]: `測試-${name}`, ...petExt },
    });
    for (const [daysAgo, svc, cancelled] of visits) {
      n++;
      const day = fmtDay(today - daysAgo * DAY);
      orders.push({
        OrderNo: `TEST-ORD-${String(n).padStart(3, '0')}`,
        CustomerType: 'PersonAccount', CustomerNo: customerNo,
        OrderDate: day,
        OrderStatusName: cancelled ? '取消-已釋出' : '確認',
        Products: [{ ProductName: svc, Quantity: 1, UnitPrice: PRICE[svc] }],
        ExtendedField: {
          預約時段: `${day.replace(/\//g, '-')} ${SLOTS[n % SLOTS.length]}`,
          ...petExt,
          '金額(新臺幣)': String(PRICE[svc]),
          表單名稱: '測試資料（seed）',
        },
      });
    }
  }
  return { customers, orders };
}

async function seedTestData(dry) {
  const plan = seedPlan();
  if (dry) {
    return {
      dryRun: true, 說明: '這只是預覽，沒有寫入。確認後在網址加上 &dry=0 才會真的建立。',
      顧客數: plan.customers.length, 訂單數: plan.orders.length,
      預覽: plan.orders.map(o => `${o.OrderNo}｜${o.CustomerNo}｜${o.ExtendedField.預約時段}｜${o.Products[0].ProductName}｜${o.OrderStatusName}`),
    };
  }
  return serial(async () => {
    const out = { customers: { created: 0, reused: 0, failed: [] }, orders: { ok: 0, failed: [] }, 顧客編號對照: {} };
    // CRM 會自己產生客戶編號（例如 CRM20261018005），不會用我們指定的 TEST-C01，
    // 所以先用測試電話找既有客戶；找不到才新增，並讀回 CRM 實際給的編號，訂單再掛到那個編號底下。
    const findByPhone = async (phone) => {
      for (const crit of [{ TelecomNum: phone }, { CurrentName: phone }]) {
        try {
          const hit = (await searchCustomers({ ...crit, Page: 1, PageSize: 50 })).find(x => deepHas(x, phone));
          if (hit) return custNoOf(hit);
        } catch { /* 這種查詢方式不被接受就換下一種 */ }
      }
      return null;
    };
    const realNo = {};
    for (const c of plan.customers) {
      const { CustomerNo: testNo, ...body } = c;
      const phone = c.CurrentName;
      try {
        let no = await findByPhone(phone);
        if (no) {
          await crm('PATCH', `customers/${encodeURIComponent(no)}`, body);
          out.customers.reused++;
        } else {
          const j = await crm('POST', 'customers', body);
          no = j?.data?.CustomerNo ?? j?.CustomerNo ?? (typeof j?.data === 'string' ? (j.data.match(/CRM\d+/) || [])[0] : null);
          if (!no) no = await findByPhone(phone);
          if (!no) throw new Error('新增後找不到客戶編號：' + JSON.stringify(j).slice(0, 150));
          out.customers.created++;
        }
        realNo[testNo] = no;
        out.顧客編號對照[testNo] = no;
      } catch (e) { out.customers.failed.push(`${testNo}: ${e.message.slice(0, 150)}`); }
    }
    for (const o of plan.orders) {
      const no = realNo[o.CustomerNo];
      if (!no) { out.orders.failed.push(`${o.OrderNo}: 顧客 ${o.CustomerNo} 沒有建立成功，略過`); continue; }
      try { await crm('POST', 'orders', { ...o, CustomerNo: no }); out.orders.ok++; }
      catch (e) { out.orders.failed.push(`${o.OrderNo}: ${e.message.slice(0, 150)}`); }
    }
    snapshot = null;   // 清掉快取，下次查詢會讀到新資料
    return out;
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { ok: true, version: VERSION, dryRun: DRY_RUN });

  if (req.method === 'GET' && url.pathname === '/check-crm') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    const r = await fetch(`${CRM_BASE}/${CRM_STORE}/api/apikey`, { headers: { Authorization: `ApiKey ${CRM_API_KEY}` } });
    return send(res, 200, { crmStatus: r.status, meaning: r.status === 200 ? 'ApiKey 合法' : 'ApiKey 不合法或店點識別碼錯誤' });
  }

  if (req.method === 'GET' && url.pathname === '/admin/create-order-fields') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    const extra = (url.searchParams.get('extra') || '').split(',').map(s => s.trim()).filter(Boolean);
    try { return send(res, 200, await createOrderFields(extra, url.searchParams.get('dry') !== '0')); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/webhook/bizform') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    if (BIZFORM_TOKEN && req.headers['x-bizform-token'] !== BIZFORM_TOKEN) return send(res, 401, { error: 'bad bizform token' });
    let raw = ''; for await (const c of req) raw += c;
    let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }
    send(res, 200, { received: true }); // 先回覆，避免 BizForm 等太久
    if (body.eventType !== 'documentCreated') return console.log('[skip] eventType', body.eventType);
    if (FORM_IDS.length && !FORM_IDS.includes(String(body.formId))) return console.log('[skip] formId', body.formId);
    for (const a of (body.document?.attributes || [])) if (!a.readOnly && a.displayName) seenLabels.add(norm(a.displayName));
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

  // ---- v7 老闆助手 API ----
  if (req.method === 'POST' && (url.pathname === '/api/segment' || url.pathname === '/api/coupon/send')) {
    if (!apiAuthed(req, url)) return send(res, 401, { status: 'error', message: 'bad token' });
    let body; try { body = await readJson(req); } catch { return sendCompact(res, { status: 'error', message: '請求格式錯誤' }); }
    try { return sendCompact(res, url.pathname === '/api/segment' ? await handleSegment(body) : await handleSend(body)); }
    catch (e) { console.error('[error-api]', e.message); return sendCompact(res, { status: 'error', message: '系統暫時讀不到 CRM 資料，請稍後再試。' }); }
  }

  // 除錯：試每一種訂單查詢條件，回傳筆數與「欄位名稱」（不回傳任何欄位內容，不含個資）
  if (req.method === 'GET' && url.pathname === '/api/debug-orders') {
    if (!apiAuthed(req, url)) return send(res, 401, { error: 'bad token' });
    const out = await serial(async () => {
      const r = [];
      for (const body of ORDER_BODY_CANDIDATES) {
        try {
          const j = await crm('POST', ORDER_SEARCH_PATH, { ...body, Page: 1, PageSize: 5 });
          const arr = Array.isArray(j) ? j : (j?.data ?? j?.Data ?? []);
          r.push({ body, message: j?.message ?? null, 回傳最外層欄位: j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j) : 'array',
            筆數: Array.isArray(arr) ? arr.length : null,
            訂單欄位: Array.isArray(arr) && arr[0] ? Object.keys(arr[0]) : [],
            擴充欄位: Array.isArray(arr) && arr[0] ? Object.keys(extOf(arr[0])).slice(0, 80) : [] });
        } catch (e) { r.push({ body, error: e.message.slice(0, 200) }); }
      }
      return r;
    });
    return send(res, 200, out);
  }

  if (req.method === 'GET' && url.pathname === '/admin/seed-test-data') {
    if (!apiAuthed(req, url)) return send(res, 401, { error: 'bad token' });
    try { return send(res, 200, await seedTestData(url.searchParams.get('dry') !== '0')); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    if (!apiAuthed(req, url)) return send(res, 401, { error: 'bad token' });
    try {
      const s = await loadSnapshot(url.searchParams.get('refresh') === '1');
      const p = s.profiles;
      return send(res, 200, {
        version: VERSION, customers: s.customers, orders: s.orders, warning: s.warning || null,
        有消費紀錄的顧客: p.filter(x => x._source === 'orders').length,
        只有顧客欄位彙總的顧客: p.filter(x => x._source === 'customer').length,
        有最後來訪日: p.filter(x => x.最後來訪日 != null).length,
        有寵物種類: p.filter(x => x.種類).length,
      });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  send(res, 404, { error: 'not found' });
});
server.listen(PORT, () => console.log('listening on', PORT, VERSION, DRY_RUN ? '(DRY_RUN)' : '(LIVE)', COUPON_DRY_RUN ? '[優惠券:測試模式]' : '[優惠券:正式發送]'));
