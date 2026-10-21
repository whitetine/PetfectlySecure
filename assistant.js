// assistant.js — 老闆的 AI 助手（自由問答）
// 老闆問的不是「篩選顧客／發券／核銷／新增商品」時，交給這裡用 Ollama 回答。
// 回答依據 guide.md（店家系統使用說明，可以直接改這個檔案，不用動程式）。
// 原則：不把任何顧客資料送給 LLM；只回答操作問題與一般經營問題。
const fs = require('fs');
const path = require('path');

const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');   // 例如 https://xxxx.ngrok-free.dev
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const SHOP_NAME = process.env.SHOP_NAME || '寵此安心';
const MEMORY_TTL = 15 * 60 * 1000;   // 記住最近 15 分鐘的對話，讓老闆可以追問
const MEMORY_TURNS = 6;              // 最多記 6 則（3 問 3 答）
const MAX_QUESTION = 500;

let guide = '';
try { guide = fs.readFileSync(path.join(__dirname, 'guide.md'), 'utf8'); }
catch { console.warn('[assistant] 找不到 guide.md，AI 只能用一般知識回答'); }

const FALLBACK = [
  '🤖 AI 助手暫時連不上（店裡跑 AI 的電腦可能沒開，或 ngrok 沒啟動）。',
  '',
  '你還是可以直接輸入這些指令：',
  '• 新增商品',
  '• 找出半年沒來的狗狗（篩選顧客、發優惠券）',
  '• 核銷 PS-XXXXX',
].join('\n');

const memory = new Map();   // userId -> { at, turns: [{role, content}] }
function history(userId) {
  const m = memory.get(userId);
  if (!m || Date.now() - m.at > MEMORY_TTL) { memory.delete(userId); return []; }
  return m.turns;
}
function remember(userId, q, a) {
  const turns = [...history(userId), { role: 'user', content: q }, { role: 'assistant', content: a }].slice(-MEMORY_TURNS);
  memory.set(userId, { at: Date.now(), turns });
  if (memory.size > 200) for (const [k, v] of memory) if (Date.now() - v.at > MEMORY_TTL) memory.delete(k);
}

function systemPrompt(context) {
  return [
    `你是「${SHOP_NAME}」寵物美容店老闆的 LINE 助手，用繁體中文回答。`,
    '你的工作：',
    '1. 回答老闆關於這套 LINE 系統怎麼操作的問題，依據下面的【使用說明】。',
    '2. 也可以回答一般的經營、行銷、文案、寵物美容相關問題。',
    '',
    '規則：',
    '- 回答要短，適合在手機 LINE 上看：最多 250 字，可以用「1. 2. 3.」或「•」條列，不要用 Markdown 的 # 或 ** 符號。',
    '- 說明書沒寫的系統功能，不要自己編造；直接說目前系統沒有這個功能，或請老闆聯絡負責設定系統的人。',
    '- 老闆想做某件事時，告訴他要輸入哪一句指令（用「」框起來），不要假裝你已經幫他做了。',
    '- 你看不到任何顧客資料、訂單或營收。被問到具體數字時，說明要用哪個指令查詢。',
    '- 不要提到你是哪個 AI 模型，也不要輸出思考過程。',
    context ? `\n老闆目前正在操作：${context}。如果他的問題跟這個步驟有關，回答完再提醒他接下來要做什麼。` : '',
    '',
    '【使用說明】',
    guide || '（目前沒有使用說明）',
  ].join('\n');
}

const clean = (s) => String(s || '')
  .replace(/<think>[\s\S]*?<\/think>/g, '')
  .replace(/^#+\s*/gm, '')
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .trim();

// 回傳要給老闆看的文字（永遠不丟錯，失敗時回傳 FALLBACK）
async function ask({ userId, question, context }) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (!q) return '請問想問什麼呢？';
  if (!OLLAMA_URL) return FALLBACK;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'system', content: systemPrompt(context) }, ...history(userId), { role: 'user', content: q }],
        stream: false,
        think: false,                                    // qwen3 等模型：不要輸出思考過程（舊版 Ollama 會忽略這個參數）
        options: { temperature: 0.3, num_predict: 600 },
      }),
      signal: AbortSignal.timeout(80000),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const j = await r.json();
    const answer = clean(j?.message?.content ?? j?.choices?.[0]?.message?.content);
    if (!answer) throw new Error('Ollama 沒有回答內容');
    if (userId) remember(userId, q, answer);
    return answer;
  } catch (e) {
    console.warn('[assistant] 呼叫 AI 失敗', e.message);
    return FALLBACK;
  }
}

console.log('[assistant] AI 助手：', OLLAMA_URL ? `${OLLAMA_MODEL} @ ${OLLAMA_URL}` : '未設定 OLLAMA_URL（只會回覆指令清單）', '｜使用說明：', guide ? `${guide.length} 字` : '沒有');
module.exports = { ask };
