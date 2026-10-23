// assistant.js — 老闆的智慧客服（OpenAI GPT）
//
// 分工：
//   • 優惠券篩選：仍由 iota 直接呼叫「地端 Ollama」把老闆的話轉成篩選條件（顧客名單不會給 Ollama）
//   • 這個檔案：用 GPT 做兩件事
//       route()  判斷老闆這句話要走哪個流程（新增商品／篩選發券／核銷／價目表／智慧客服…）
//       ask()    智慧客服：回答操作問題，並可用下面的「查資料工具」讀店裡的資料再回答
//
// 查資料工具（全部唯讀，不會改任何資料）：
//   business_stats     某段期間的服務次數、營收、來客數、新客（例如「近一個月做最多次的美容項目」）
//   find_customer      依姓名／寵物名／電話查某位顧客的資料、來店紀錄、未來預約
//   list_feedback      顧客的意見回饋（BizForm 回饋表單）
//   upcoming_bookings  接下來幾天的預約
//
// ⚠ 隱私：工具查到的顧客姓名、寵物、消費紀錄會送給 OpenAI 產生回答。
//   電話、身分證、地址、Email、LINE ID 不會送出（電話只在伺服器比對，回答時只顯示末三碼）。
const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const SHOP_NAME = process.env.SHOP_NAME || '寵此安心';
const MEMORY_TTL = 15 * 60 * 1000;   // 記住最近 15 分鐘的對話，讓老闆可以追問
const MEMORY_TURNS = 8;              // 最多記 8 則（4 問 4 答）
const MAX_QUESTION = 800;
const MAX_TOOL_ROUNDS = 5;

let guide = '';
try { guide = fs.readFileSync(path.join(__dirname, 'guide.md'), 'utf8'); }
catch { console.warn('[assistant] 找不到 guide.md，智慧客服只能用一般知識回答'); }

const FALLBACK = [
  '🤖 智慧客服暫時無法回答（GPT 連線失敗）。',
  '',
  '你還是可以直接輸入這些指令：',
  '• 新增商品',
  '• 找出半年沒來的狗狗（篩選顧客、發優惠券）',
  '• 核銷 PS-XXXXX',
].join('\n');

// ---------------------------------------------------------------------
// 資料：由 index.js 呼叫 useData() 交進來（讀 CRM 的快取，5 分鐘更新一次）
// ---------------------------------------------------------------------
let D = null;
function useData(d) { D = d; }

// ---------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------
async function openai(body, timeoutMs = 60000) {
  if (!OPENAI_API_KEY) throw new Error('沒有設定 OPENAI_API_KEY');
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`OpenAI ${r.status} ${JSON.stringify(j?.error?.message ?? j).slice(0, 200)}`);
  return j;
}

const clean = (s) => String(s || '')
  .replace(/<think>[\s\S]*?<\/think>/g, '')
  .replace(/^#+\s*/gm, '')
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/`/g, '')
  .trim();

// ---------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------
function parseDate(s) {
  const m = String(s ?? '').match(/(\d{2,4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  if (!m) return null;
  let y = +m[1]; if (y < 1911) y += 1911;
  const t = Date.UTC(y, +m[2] - 1, +m[3]);
  return Number.isNaN(t) ? null : t;
}
// 回傳 [from, to]（含頭含尾）。沒給就用最近 days 天（預設 30）
function period(args) {
  const today = D.todayDay();
  let to = parseDate(args?.to) ?? today;
  let from = parseDate(args?.from);
  if (from == null) {
    const days = Math.max(1, Math.min(3650, parseInt(args?.days, 10) || 30));
    from = to - (days - 1) * D.DAY;
  }
  if (from > to) [from, to] = [to, from];
  return [from, to];
}
const fmt = (t) => (t == null ? '' : D.fmtDay(t));

// ---------------------------------------------------------------------
// 查資料工具（唯讀）
// ---------------------------------------------------------------------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'business_stats',
      description: '統計某段期間的營運數字：各服務項目（洗澡、剪毛、大美容、小美容、其他）的次數與營收、來店人次、來客數、新客數、總營收、消費最高的顧客。用在「近一個月做最多次的美容項目」「上個月營收」「這週來了幾位客人」這類問題。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '最近幾天（含今天），例如近一個月=30、近一週=7。有給 from 時忽略' },
          from: { type: 'string', description: '開始日期 YYYY/MM/DD（選填）' },
          to: { type: 'string', description: '結束日期 YYYY/MM/DD（選填，預設今天）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_customer',
      description: '用顧客姓名、寵物名或電話（至少 3 碼）查某位顧客：基本資料、寵物、來店次數、總消費、最近的來店紀錄（日期、項目、金額）、未來預約。用在「查詢紀錄」「王小明的紀錄」「巧克上次什麼時候來」這類問題。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '姓名、寵物名或電話號碼的一部分' } },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_feedback',
      description: '列出顧客的意見回饋（來自回饋表單）。可以限定最近幾天或關鍵字。用在「最近的意見回饋」「有沒有人抱怨」「王小明留了什麼回饋」這類問題。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '最近幾天，預設 30' },
          keyword: { type: 'string', description: '只看內容或顧客姓名包含這個字的回饋（選填）' },
          limit: { type: 'integer', description: '最多幾筆，預設 10，最多 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upcoming_bookings',
      description: '列出接下來幾天已經預約的顧客（日期、時段、顧客、寵物、項目）。用在「今天有哪些預約」「這週的預約」這類問題。',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '從今天起算幾天，今天=1、這週=7，預設 7' } },
      },
    },
  },
];

const itemText = (it) => `${it.name}${it.qty > 1 ? '×' + it.qty : ''}`;
const maskPhone = (p) => (p && p.length >= 3 ? '末三碼 ' + p.slice(-3) : '');

async function runTool(name, args) {
  if (!D) return { error: '資料尚未準備好' };
  const snap = await D.loadSnapshot();
  const profiles = snap.profiles || [];
  const note = snap.warning ? { 注意: snap.warning } : {};

  if (name === 'business_stats') {
    const [from, to] = period(args);
    const svc = {}; let visits = 0, revenue = 0; const cust = new Map(); let newCust = 0;
    for (const p of profiles) {
      const vs = (p._visits || []).filter(v => v.day >= from && v.day <= to);
      if (!vs.length) continue;
      const first = Math.min(...(p._visits || []).map(v => v.day));
      if (first >= from && first <= to) newCust++;
      let spent = 0;
      for (const v of vs) {
        visits++; revenue += v.amount; spent += v.amount;
        for (const it of v.items || []) {
          const k = ['洗澡', '剪毛', '大美容', '小美容'].includes(it.name) ? it.name : `其他（${it.name}）`;
          svc[k] = svc[k] || { 次數: 0, 營收: 0 };
          svc[k].次數 += it.qty; svc[k].營收 += it.qty * it.price;
        }
      }
      cust.set(p.姓名 + (p.寵物名 ? `（${p.寵物名}）` : ''), spent);
    }
    const services = Object.entries(svc).sort((a, b) => b[1].次數 - a[1].次數)
      .map(([k, v]) => ({ 項目: k, 次數: v.次數, 營收: D.money(v.營收) }));
    const top = [...cust.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ 顧客: k, 消費: D.money(v) }));
    return { 期間: `${fmt(from)} ~ ${fmt(to)}`, 來店人次: visits, 來客數: cust.size, 新客數: newCust, 總營收: D.money(revenue), 各服務項目_依次數排序: services, 消費最高前5位: top, ...note };
  }

  if (name === 'find_customer') {
    const kw = String(args?.keyword || '').normalize('NFKC').trim();
    if (!kw) return { error: '請提供要查的姓名、寵物名或電話' };
    const digits = kw.replace(/\D/g, '');
    const hits = profiles.filter(p =>
      (p.姓名 && p.姓名.includes(kw)) || (p.寵物名 && p.寵物名.includes(kw)) ||
      (digits.length >= 3 && digits.length === kw.replace(/[\s\-()+]/g, '').length && p._phone && p._phone.includes(digits)));
    if (!hits.length) return { 結果: `找不到「${kw}」這位顧客（可以試試姓名、寵物名或電話）`, ...note };
    if (hits.length > 5) return { 結果: `有 ${hits.length} 位符合「${kw}」，請老闆說得更精確`, 部分名單: hits.slice(0, 15).map(p => `${p.姓名}${p.寵物名 ? '（' + p.寵物名 + '）' : ''}`) };
    return {
      符合人數: hits.length,
      顧客: hits.map(p => ({
        姓名: p.姓名, 電話: maskPhone(p._phone), 寵物: [p.寵物名, p.種類, p.品種, p.寵物年齡 != null ? p.寵物年齡 + '歲' : ''].filter(Boolean).join(' '),
        來店次數: p.來訪次數, 總消費: D.money(p.總消費), 平均客單價: p.平均客單價 != null ? D.money(p.平均客單價) : '',
        最後來店: p.最後來訪日 != null ? `${fmt(p.最後來訪日)}（${p.距上次來訪天數} 天前）` : '沒有紀錄',
        服務次數: { 洗澡: p.洗澡次數, 剪毛: p.剪毛次數, 大美容: p.大美容次數, 小美容: p.小美容次數, 其他: p.其他服務次數 },
        標籤: p.標籤, RFM分群: p.RFM分群,
        最近來店紀錄: (p._visits || []).slice(0, 10).map(v => `${fmt(v.day)}｜${(v.items || []).map(itemText).join('、') || '（無項目）'}｜${D.money(v.amount)}`),
        未來預約: (p._upcoming || []).slice(0, 5).map(u => `${u.time || fmt(u.day)}｜${(u.items || []).join('、')}`),
      })),
      ...note,
    };
  }

  if (name === 'list_feedback') {
    const days = Math.max(1, Math.min(3650, parseInt(args?.days, 10) || 30));
    const limit = Math.max(1, Math.min(20, parseInt(args?.limit, 10) || 10));
    const since = D.todayDay() - (days - 1) * D.DAY;
    const kw = String(args?.keyword || '').trim();
    const all = snap.feedback || [];
    if (!all.length) return { 結果: '目前讀不到任何意見回饋資料。可能還沒有人填，或回饋表單沒有寫進 CRM 的消費資料（需要負責設定系統的人確認）。' };
    const list = all.filter(f => (f.day == null || f.day >= since) && (!kw || f.姓名.includes(kw) || JSON.stringify(f.fields).includes(kw)));
    return { 期間: `最近 ${days} 天`, 筆數: list.length, 回饋: list.slice(0, limit).map(f => ({ 日期: fmt(f.day), 顧客: f.姓名, 表單: f.form, 內容: f.fields })) };
  }

  if (name === 'upcoming_bookings') {
    const days = Math.max(1, Math.min(60, parseInt(args?.days, 10) || 7));
    const today = D.todayDay(), end = today + (days - 1) * D.DAY;
    const list = [];
    for (const p of profiles) for (const u of p._upcoming || []) if (u.day >= today && u.day <= end) list.push({ u, p });
    list.sort((a, b) => a.u.day - b.u.day || String(a.u.time).localeCompare(String(b.u.time)));
    return {
      期間: `${fmt(today)} ~ ${fmt(end)}`, 筆數: list.length,
      預約: list.slice(0, 40).map(({ u, p }) => `${u.time || fmt(u.day)}｜${p.姓名}${p.寵物名 ? '（' + p.寵物名 + '）' : ''}｜${(u.items || []).join('、')}`),
      說明: '只算今天以後的日期；今天已經過了預約時間的也會列出',
    };
  }
  return { error: '沒有這個工具' };
}

// ---------------------------------------------------------------------
// 對話記憶
// ---------------------------------------------------------------------
const memory = new Map();   // userId -> { at, turns: [{role, content}] }
function history(userId) {
  const m = memory.get(userId);
  if (!m || Date.now() - m.at > MEMORY_TTL) { memory.delete(userId); return []; }
  return m.turns;
}
function remember(userId, q, a) {
  if (!userId) return;
  const turns = [...history(userId), { role: 'user', content: q }, { role: 'assistant', content: a }].slice(-MEMORY_TURNS);
  memory.set(userId, { at: Date.now(), turns });
  if (memory.size > 200) for (const [k, v] of memory) if (Date.now() - v.at > MEMORY_TTL) memory.delete(k);
}

function systemPrompt(context) {
  const today = D ? D.fmtDay(D.todayDay()) : '';
  return [
    `你是「${SHOP_NAME}」寵物美容店老闆的 LINE 智慧客服，用繁體中文回答。今天是 ${today}。`,
    '',
    '你可以：',
    '1. 用工具查店裡的資料再回答：服務統計、營收、某位顧客的紀錄、意見回饋、接下來的預約。',
    '2. 依【使用說明】回答這套 LINE 系統怎麼操作。',
    '3. 回答一般的經營、行銷、文案、寵物美容問題。',
    '',
    '規則：',
    '- 問到店裡的數字或顧客，一定要先用工具查，不要自己猜或編數字；工具沒查到就照實說。',
    '- 「近一個月」= 最近 30 天、「近一週」= 7 天、「這個月」= 本月 1 號到今天、「上個月」= 上個月 1 號到月底。',
    '- 老闆沒說要查誰時（例如只說「查詢紀錄」），先問他要查哪位顧客（姓名、寵物名或電話都可以）。',
    '- 回答適合在手機 LINE 上看：先講結論，再條列重點，最多 400 字；用「1. 2.」或「•」條列，不要用 Markdown 的 #、**、表格。',
    '- 金額用 NT$ 表示。顧客電話只能顯示末三碼。',
    '- 你只能查資料，不能修改資料、不能幫老闆發券或建立商品。老闆想做這些事時，告訴他要輸入哪一句（用「」框起來）。',
    '- 預約、取消預約是顧客的功能，老闆帳號不能用；老闆想看預約可以用工具查。',
    '- 說明書沒寫的系統功能不要編造；直接說目前沒有這個功能。',
    '- 不要提到你是哪個 AI 模型、不要提到「工具」「function」這些字。',
    context ? `\n老闆目前正在操作：${context}。如果他的問題跟這個步驟有關，回答完再提醒他接下來要做什麼。` : '',
    '',
    '【使用說明】',
    guide || '（目前沒有使用說明）',
  ].join('\n');
}

// 回傳要給老闆看的文字（永遠不丟錯，失敗時回傳 FALLBACK）
async function ask({ userId, question, context }) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (!q) return '請問想問什麼呢？';
  if (!OPENAI_API_KEY) return FALLBACK;
  const messages = [{ role: 'system', content: systemPrompt(context) }, ...history(userId), { role: 'user', content: q }];
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const last = round === MAX_TOOL_ROUNDS;
      const j = await openai({ messages, ...(last || !D ? {} : { tools: TOOLS }), max_completion_tokens: 2500 });
      const msg = j?.choices?.[0]?.message;
      if (!msg) throw new Error('OpenAI 沒有回傳內容');
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        const answer = clean(msg.content);
        if (!answer) throw new Error('OpenAI 回答是空的');
        remember(userId, q, answer);
        return answer;
      }
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
        let result;
        try { result = await runTool(c.function?.name, args); }
        catch (e) { console.warn('[assistant] 工具失敗', c.function?.name, e.message); result = { error: '讀不到 CRM 資料，請稍後再試' }; }
        console.log('[assistant] 查資料', c.function?.name, JSON.stringify(args).slice(0, 80));
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 12000) });
      }
    }
    throw new Error('查資料次數過多');
  } catch (e) {
    console.warn('[assistant] 呼叫 GPT 失敗', e.message);
    return FALLBACK;
  }
}

// =====================================================================
// 意圖判斷：GPT 決定老闆這句話要走哪個流程
// =====================================================================
const INTENTS = {
  add_product: '老闆要「現在開始」新增／上架一個商品（不是在問怎麼做）',
  find_customers: '要篩選出一群顧客的名單，通常是為了發優惠券、做行銷或回訪（例如「半年沒來的狗狗」「消費最高的前 10 位」）',
  redeem_coupon: '要核銷或查詢某一張優惠券，句子裡有優惠碼（PS-XXXXX）',
  price_list: '要看價目表（老闆想確認價目表圖片是不是最新版）',
  customer_only: '要幫自己預約或取消預約（這是顧客的功能，老闆不能用）',
  assistant: '其他全部：查某位顧客的紀錄、看意見回饋、問營運統計（哪個項目做最多、營收、來客數）、看接下來的預約、問系統怎麼操作、經營建議、寫文案、閒聊',
};
const ROUTE_EXAMPLES = [
  ['新增商品', 'add_product'], ['我要上架一款新的洗毛精', 'add_product'], ['加入商品', 'add_product'],
  ['怎麼新增商品圖片', 'assistant'], ['商品照片要怎麼傳', 'assistant'],
  ['找出半年沒來的狗狗', 'find_customers'], ['消費最高的前10位', 'find_customers'], ['發優惠券給很久沒來的客人', 'find_customers'], ['請告訴我消費金額最高的顧客', 'find_customers'], ['這個月有來但還沒預約下次的貓咪', 'find_customers'],
  ['核銷 PS-AB3KQXY', 'redeem_coupon'], ['這張券還能用嗎 PS-K7Q2M9X', 'redeem_coupon'], ['優惠券要怎麼核銷', 'assistant'],
  ['價目表', 'price_list'], ['給我看價目表', 'price_list'], ['價目表是不是新版的', 'price_list'],
  ['我要預約', 'customer_only'], ['幫我約下週六洗澡', 'customer_only'], ['取消預約', 'customer_only'],
  ['查詢紀錄', 'assistant'], ['查王小明的紀錄', 'assistant'], ['巧克上次什麼時候來', 'assistant'], ['0912345678 這位客人做過什麼', 'assistant'],
  ['意見回饋', 'assistant'], ['最近有人抱怨嗎', 'assistant'],
  ['請幫我統計近一個月做最多次的美容項目', 'assistant'], ['上個月營收多少', 'assistant'], ['今天有哪些預約', 'assistant'],
  ['幫我想一句中秋節的優惠文案', 'assistant'], ['夏天狗狗多久洗一次澡比較好', 'assistant'],
];
const COUPON_CODE_RE = /\bPS\s*[-－]?\s*[A-Z0-9]{4,12}\b/i;
const ASKING_RE = /怎麼|如何|為什麼|為何/;

// GPT 連不上時的備案：簡單規則，至少讓主要功能能用
function fallbackRoute(t) {
  if (COUPON_CODE_RE.test(t) && !ASKING_RE.test(t)) return 'redeem_coupon';
  if (/[?？]|怎麼|怎樣|什麼|甚麼|如何|為什麼|為何|哪裡|請問|教我|統計|多少|紀錄|回饋/.test(t)) return 'assistant';
  if (/新增商品|加入商品|上架/.test(t)) return 'add_product';
  if (/價目|價格表/.test(t)) return 'price_list';
  if (/^(我要|我想|想要|幫我)?\s*(預約|約)|取消.*預約/.test(t) && !/哪些|幾位|幾個|有誰|列出/.test(t)) return 'customer_only';
  if (/預約/.test(t)) return 'assistant';
  if (/找出|名單|優惠券|沒來|前\s*\d+\s*位/.test(t)) return 'find_customers';
  return 'assistant';
}

const CUSTOMER_ONLY_MSG = '預約和取消預約是顧客使用的功能，老闆帳號不能使用喔。\n\n想看接下來的預約，可以直接問「今天有哪些預約」或「這週的預約」。\n要測試顧客的預約流程，請用另一個沒有綁定老闆的 LINE 帳號。';
const withTag = (r) => ({ ...r, tag: `#${r.intent}#`, ...(r.intent === 'customer_only' ? { message: CUSTOMER_ONLY_MSG } : {}) });

async function route(args) { return withTag(await routeRaw(args)); }
async function routeRaw({ text }) {
  const t = String(text || '').normalize('NFKC').trim().slice(0, MAX_QUESTION);
  if (!t) return { intent: 'assistant', via: 'rule' };
  // 有優惠碼、又不是在問做法 → 一定是核銷，不用問 GPT（省時間）
  if (COUPON_CODE_RE.test(t) && !ASKING_RE.test(t)) return { intent: 'redeem_coupon', via: 'rule' };
  if (!OPENAI_API_KEY) return { intent: fallbackRoute(t), via: 'fallback' };
  const system = [
    `你是「${SHOP_NAME}」寵物美容店 LINE 系統的分流員。老闆傳來一句話，你要判斷他想做哪一件事，只能從下面選一個：`,
    ...Object.entries(INTENTS).map(([k, v]) => `- ${k}：${v}`),
    '',
    '判斷重點：',
    '- 在問「怎麼、如何、為什麼、在哪裡」的句子是 assistant，就算句子裡有「新增商品」「核銷」「預約」這些字也一樣。',
    '- 查「某一位」顧客的資料是 assistant；篩出「一群」顧客名單是 find_customers。',
    '- 問數字、統計、營收、哪個項目做最多是 assistant。',
    '',
    '範例：',
    ...ROUTE_EXAMPLES.map(([q, a]) => `老闆：${q} → ${a}`),
  ].join('\n');
  try {
    const j = await openai({
      messages: [{ role: 'system', content: system }, { role: 'user', content: t }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'route', strict: true, schema: { type: 'object', properties: { intent: { type: 'string', enum: Object.keys(INTENTS) } }, required: ['intent'], additionalProperties: false } },
      },
      max_completion_tokens: 1000,
    }, 30000);
    const raw = clean(j?.choices?.[0]?.message?.content);
    const intent = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))?.intent;
    if (!INTENTS[intent]) throw new Error('意圖不在清單裡：' + raw.slice(0, 80));
    return { intent, via: 'gpt' };
  } catch (e) {
    console.warn('[assistant] 意圖判斷失敗，改用規則', e.message);
    return { intent: fallbackRoute(t), via: 'fallback' };
  }
}

console.log('[assistant] 智慧客服：', OPENAI_API_KEY ? `OpenAI ${OPENAI_MODEL}` : '未設定 OPENAI_API_KEY（只會回覆指令清單）', '｜使用說明：', guide ? `${guide.length} 字` : '沒有');
module.exports = { ask, route, useData };
