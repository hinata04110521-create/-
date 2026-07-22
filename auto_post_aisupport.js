const https = require("https")
const fs = require("fs")
const path = require("path")
const content = require("./content_aisupport.js")

// 使用モデル（生成品質を上げたい場合はここを上位モデルに変更可）
const MODEL = "claude-haiku-4-5-20251001"
const HISTORY_PATH = path.join(__dirname, "history_aisupport.json")
const METRICS_PATH = path.join(__dirname, "metrics_aisupport.json")

// Anthropic API リトライ付き呼び出し（529 Overloaded に対応）
async function callAnthropicWithRetry(client, params, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(params)
    } catch (err) {
      const isOverloaded = err.status === 529 || (err.message && err.message.includes("overloaded"))
      if (isOverloaded && attempt < maxRetries) {
        const waitSec = attempt * 15 // 15秒 → 30秒 → (最大3回)
        console.log(`Anthropic過負荷のためリトライ (${attempt}/${maxRetries - 1}) … ${waitSec}秒待機`)
        await new Promise(r => setTimeout(r, waitSec * 1000))
      } else {
        throw err
      }
    }
  }
}

// APIレスポンスを安全にパース（空・非JSONでもクラッシュさせず、原因の分かるエラーを返す）
function parseApiResponse(data, statusCode) {
  const raw = (data || "").trim()
  if (raw === "") {
    return { error: { message: `空のレスポンス（HTTP ${statusCode || "不明"}）。トークン失効・レート制限・アカウント制限の可能性があります` } }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { error: { message: `JSON以外のレスポンス（HTTP ${statusCode || "不明"}）: ${raw.slice(0, 200)}` } }
  }
}

// Threads API に POST
function threadsFetch(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString()
    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }
    const req = https.request(url, options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => resolve(parseApiResponse(data, res.statusCode)))
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

// Threads API に GET
function threadsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => resolve(parseApiResponse(data, res.statusCode)))
    })
    req.on("error", reject)
  })
}

// Tavily APIでネット検索（タイムアウト8秒）
async function searchWeb(query) {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    console.log("TAVILY_API_KEY未設定のためスキップ")
    return ""
  }
  try {
    const body = JSON.stringify({
      api_key: apiKey,
      query: query,
      search_depth: "basic",
      max_results: 2,
      include_answer: true,
    })
    const fetchPromise = new Promise((resolve) => {
      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }
      const req = https.request("https://api.tavily.com/search", options, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
      })
      req.on("error", () => resolve(null))
      req.setTimeout(8000, () => { req.destroy(); resolve(null) })
      req.write(body)
      req.end()
    })
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 8000))
    const result = await Promise.race([fetchPromise, timeoutPromise])
    if (!result) return ""
    const answer = result.answer || ""
    const snippets = (result.results || []).map((r) => r.content || "").join(" ")
    return (answer + " " + snippets).slice(0, 600)
  } catch (e) {
    console.log("検索エラー（スキップ）:", e.message)
    return ""
  }
}

// 自分のThreads投稿を最大50件取得
async function fetchMyPosts() {
  const TOKEN   = process.env.THREADS_ACCESS_TOKEN
  const USER_ID = process.env.THREADS_USER_ID
  const url = `https://graph.threads.net/v1.0/${USER_ID}/threads?fields=text&limit=50&access_token=${TOKEN}`
  try {
    const res = await threadsGet(url)
    if (res.error || !res.data) return []
    return res.data
      .map((p) => p.text)
      .filter((t) => t && t.length > 10)
  } catch {
    return []
  }
}

// Threads に投稿
async function postToThreads(text) {
  const TOKEN   = process.env.THREADS_ACCESS_TOKEN
  const USER_ID = process.env.THREADS_USER_ID
  const BASE    = "https://graph.threads.net/v1.0"

  if (text.length > 500) {
    console.log(`文字数超過(${text.length}文字)のため500文字にカット`)
    text = text.slice(0, 497) + "…"
  }

  const container = await threadsFetch(`${BASE}/${USER_ID}/threads`, {
    media_type: "TEXT",
    text,
    access_token: TOKEN,
  })
  if (container.error) throw new Error(container.error.message)

  await new Promise((r) => setTimeout(r, 5000))

  const result = await threadsFetch(`${BASE}/${USER_ID}/threads_publish`, {
    creation_id: container.id,
    access_token: TOKEN,
  })
  if (result.error) throw new Error(result.error.message)

  return result.id
}

// Threads にメイン投稿＋返信を投稿
async function postToThreadsWithReply(mainText, replyText) {
  const TOKEN   = process.env.THREADS_ACCESS_TOKEN
  const USER_ID = process.env.THREADS_USER_ID
  const BASE    = "https://graph.threads.net/v1.0"

  const container = await threadsFetch(`${BASE}/${USER_ID}/threads`, {
    media_type: "TEXT",
    text: mainText,
    access_token: TOKEN,
  })
  if (container.error) throw new Error(container.error.message)

  await new Promise((r) => setTimeout(r, 5000))

  const result = await threadsFetch(`${BASE}/${USER_ID}/threads_publish`, {
    creation_id: container.id,
    access_token: TOKEN,
  })
  if (result.error) throw new Error(result.error.message)

  const postId = result.id
  console.log(`メイン投稿完了: ${postId}`)

  if (replyText) {
    if (replyText.length > 500) {
      console.log(`返信文字数超過(${replyText.length}文字)のため500文字にカット`)
      replyText = replyText.slice(0, 497) + "…"
    }
    await new Promise((r) => setTimeout(r, 3000))

    const replyContainer = await threadsFetch(`${BASE}/${USER_ID}/threads`, {
      media_type: "TEXT",
      text: replyText,
      reply_to_id: postId,
      access_token: TOKEN,
    })
    if (replyContainer.error) throw new Error(replyContainer.error.message)

    await new Promise((r) => setTimeout(r, 5000))

    const replyResult = await threadsFetch(`${BASE}/${USER_ID}/threads_publish`, {
      creation_id: replyContainer.id,
      access_token: TOKEN,
    })
    if (replyResult.error) throw new Error(replyResult.error.message)

    console.log(`返信投稿完了: ${replyResult.id}`)
  }

  return postId
}

// ============================================================
// 「治療院の右腕AIを育てる」カテゴリー型 生成・投稿
// ============================================================

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) } catch { return fallback }
}

function loadHistory() {
  const h = readJsonSafe(HISTORY_PATH, [])
  return Array.isArray(h) ? h : []
}

function saveHistory(history) {
  // 直近500件だけ保持（ファイル肥大化防止）
  const trimmed = history.slice(-500)
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2))
    console.log(`履歴を保存: ${trimmed.length}件`)
  } catch (e) {
    console.error("履歴保存に失敗（投稿自体は継続）:", e.message)
  }
}

function loadMetrics() {
  const m = readJsonSafe(METRICS_PATH, null)
  if (!m) return null
  // 説明・null・空文字は除外し、事実の値だけ残す
  const facts = {}
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith("_")) continue
    if (v === null || v === "" || v === undefined) continue
    facts[k] = v
  }
  return Object.keys(facts).length > 0 ? facts : null
}

// 生成テキストの掃除（ラベル・コードフェンス・囲みクオート・区切り線を除去）
function cleanGenerated(t) {
  return (t || "")
    .replace(/^```[\s\S]*?\n/, "").replace(/```$/,"")
    .replace(/^\s*(MAIN|REPLY|投稿文|本文)\s*[:：]\s*/i, "")
    .replace(/^\s*[「"']/, "").replace(/[」"']\s*$/,"")
    .replace(/^[-ー―─━=＝*＊]{2,}$/mg, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// カテゴリー型の投稿を1本生成（品質チェック＋重複チェック、最大3回リトライ）
async function generateCategoryPost({ client, recentCategories, history, metrics, forceQuestion = false, engagementHint = "" }) {
  const categoryKey = content.pickCategory(recentCategories)
  const koseiKey = content.pickKosei(categoryKey)
  const avoidTexts = history.slice(-12).map((h) => h.text).filter(Boolean)
  let lastReasons = []

  for (let attempt = 1; attempt <= 3; attempt++) {
    let prompt = content.buildPrompt({ categoryKey, koseiKey, metrics, avoidTexts, engagementHint })
    if (forceQuestion) prompt += "\n\n【追加指示】必ず、読者が答えやすい短い質問文で締めること。"
    if (lastReasons.length) prompt += `\n\n【前回はこの理由で不採用。必ず直すこと】${lastReasons.join(" / ")}`

    const message = await callAnthropicWithRetry(client, {
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    })
    const text = cleanGenerated(message.content[0].text.trim())
    const q = content.qualityCheck(text, { history, category: categoryKey })

    if (forceQuestion && !q.hasQuestion) {
      lastReasons = ["質問文で終わっていない"]
      console.log(`品質チェック不採用(${attempt}/3): 質問締めが必要`)
      continue
    }
    if (q.ok) {
      return { text, category: categoryKey, kosei: koseiKey, len: q.len, hasQuestion: q.hasQuestion }
    }
    lastReasons = q.reasons
    console.log(`品質チェック不採用(${attempt}/3) [${content.CATEGORIES[categoryKey].label}]: ${q.reasons.join(", ")}`)
  }
  return null // 3回とも不採用 → この枠はスキップ
}

async function main() {
  const totalPosts = 5
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません")
  const Anthropic = require("@anthropic-ai/sdk")
  const client = new Anthropic({ apiKey })

  const history = loadHistory()
  const metrics = loadMetrics()
  const recentCategories = history.slice(-6).map((h) => h.category).filter(Boolean)
  // 反応データが十分溜まっていれば、伸びている型へ寄せるヒントを作る（少ないうちは空）
  const engagementHint = content.buildEngagementHint(history)
  console.log(`履歴: ${history.length}件 / 実績データ: ${metrics ? "あり" : "なし"} / 学習ヒント: ${engagementHint ? "あり" : "なし（データ蓄積中）"}`)

  let failureCount = 0

  for (let i = 1; i <= totalPosts; i++) {
    console.log(`\n===== 投稿 ${i}/${totalPosts} =====`)
    try {
      // 会話（返信）を増やすため、直近の質問締め比率が60%未満なら今回は質問締めを強制
      const recent = history.slice(-10)
      const qRatio = recent.length ? recent.filter((h) => h.hasQuestion).length / recent.length : 0
      const forceQuestion = qRatio < 0.6

      const gen = await generateCategoryPost({ client, recentCategories, history, metrics, forceQuestion, engagementHint })
      if (!gen) {
        failureCount++
        console.error(`投稿 ${i}/${totalPosts}: 品質基準を満たせずスキップ`)
        continue
      }

      console.log(`カテゴリー: ${content.CATEGORIES[gen.category].label} / 構成: ${gen.kosei} / ${gen.len}字 / 質問締め: ${gen.hasQuestion ? "○" : "×"}`)
      console.log("--- 投稿本文 ---")
      console.log(gen.text)
      console.log("----------------")

      let result = "dry_run"
      let error = null
      let postedAt = null

      if (process.env.DRY_RUN === "true") {
        console.log(`※ プレビューモード：投稿 ${i} はしていません`)
      } else {
        try {
          const id = await postToThreads(gen.text)
          result = `posted:${id}`
          postedAt = new Date().toISOString()
          console.log(`投稿成功！ ${i}/${totalPosts}`)
        } catch (e) {
          result = "error"
          error = e.message
          failureCount++
          console.error(`投稿失敗 ${i}/${totalPosts}: ${e.message}`)
        }
      }

      history.push({
        text: gen.text,
        category: gen.category,
        kosei: gen.kosei,
        createdAt: new Date().toISOString(),
        postedAt,
        result,
        error,
        charCount: gen.len,
        hasQuestion: gen.hasQuestion,
      })
      recentCategories.push(gen.category)
    } catch (e) {
      failureCount++
      console.error(`投稿 ${i}/${totalPosts} をスキップ（残りは継続）: ${e.message}`)
    }

    if (i < totalPosts) await new Promise((r) => setTimeout(r, 5000))
  }

  saveHistory(history)

  if (failureCount > 0) {
    console.error(`\n⚠ ${failureCount}/${totalPosts} 件が失敗/スキップ。THREADS_ACCESS_TOKEN_AISUPPORT の失効・レート制限・アカウント制限・生成品質を確認してください。`)
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("エラー:", err.message)
    console.error("詳細:", err.stack || err)
    process.exit(1)
  })
}

module.exports = { generateCategoryPost, cleanGenerated, loadHistory, saveHistory, loadMetrics, main }
