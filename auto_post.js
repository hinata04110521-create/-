const https = require("https")
const fs = require("fs")
const path = require("path")

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
      res.on("end", () => resolve(JSON.parse(data)))
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
      res.on("end", () => resolve(JSON.parse(data)))
    })
    req.on("error", reject)
  })
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

// Claude API でテキスト生成
async function generateWithClaude(timeSlot) {
  const Anthropic = require("@anthropic-ai/sdk")
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません")
  const client = new Anthropic({ apiKey })

  // posts.json の全50投稿を使用
  const localPosts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts.json"), "utf-8"))
  const localExamples = [...localPosts.lunch, ...localPosts.afternoon]

  // Threadsアカウントの実際の投稿も取得
  const accountPosts = await fetchMyPosts()
  console.log(`アカウントから${accountPosts.length}件の投稿を取得`)

  // 合わせて最大50件をサンプルに
  const allExamples = [...accountPosts, ...localExamples].slice(0, 50)
  const examples = allExamples.join("\n\n---\n\n")

  const styleGuide = `
以下は実際のThreadsアカウントの投稿です。この文体・トーン・表現スタイルを完全に模倣して書いてください。

【実際の投稿例】
${examples}

【守るべき文体の特徴】
- 短い文を改行で区切るリズム感
- 読者への直接的な問いかけ（〜してる？〜ですか？〜ない？）
- 具体的な数字・食材名・時間帯を使う
- 最後に一言アクションを促す
- ハッシュタグなし・絵文字なし
- 断定的で簡潔な言い切り表現
`

  const prompts = {
    morning: `あなたは日本のダイエット・ボディメイク専門家です。
フォロワーに向けた「朝6時にぴったりの投稿」を作成してください。
${styleGuide}
追加条件：
- 朝の始まりにモチベーションが上がる内容
- 今日1日のダイエット・健康習慣のヒントを含む
- 200文字以内`,

    evening: `あなたは日本のダイエット・ボディメイク専門家です。
フォロワーに向けた「夜21時にぴったりの投稿」を作成してください。
${styleGuide}
追加条件：
- 今日1日頑張った人を労う内容
- 明日への前向きなメッセージを含む
- 夜の食事・睡眠・明日の準備に関するヒントがあると◎
- 200文字以内`,
  }

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{ role: "user", content: prompts[timeSlot] }],
  })

  return message.content[0].text.trim()
}

// リストからランダム取得
function getRandomPost(timeSlot) {
  const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts.json"), "utf-8"))
  const list = posts[timeSlot]
  return list[Math.floor(Math.random() * list.length)]
}

// 現在の JST 時間に応じてコンテンツを決定
async function getContent() {
  const jstHour = (new Date().getUTCHours() + 9) % 24
  console.log(`JST: ${jstHour}時`)

  if (jstHour >= 5 && jstHour < 8) {
    console.log("タイプ: AI生成（朝）")
    return await generateWithClaude("morning")
  } else if (jstHour >= 11 && jstHour < 14) {
    console.log("タイプ: ランダム（昼）")
    return getRandomPost("lunch")
  } else if (jstHour >= 16 && jstHour < 19) {
    console.log("タイプ: ランダム（夕）")
    return getRandomPost("afternoon")
  } else if (jstHour >= 20 && jstHour < 23) {
    console.log("タイプ: AI生成（夜）")
    return await generateWithClaude("evening")
  } else {
    throw new Error(`対応外の時間帯: JST ${jstHour}時`)
  }
}

async function main() {
  const text = await getContent()
  console.log("\n--- 投稿内容 ---")
  console.log(text)
  console.log("----------------\n")

  if (process.env.DRY_RUN === "true") {
    console.log("※ プレビューモード：投稿はしていません")
    return
  }

  const postId = await postToThreads(text)
  console.log("投稿成功！ID:", postId)
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
