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

  const prompts = {
    morning: `あなたは日本のダイエット・ボディメイク専門家です。
フォロワーに向けた「朝6時にぴったりの投稿」を作成してください。
条件：
- 朝の始まりにモチベーションが上がる内容
- 今日1日のダイエット・健康習慣のヒントを含む
- 200文字以内
- ハッシュタグなし
- 自然な話し言葉で`,

    evening: `あなたは日本のダイエット・ボディメイク専門家です。
フォロワーに向けた「夜21時にぴったりの投稿」を作成してください。
条件：
- 今日1日頑張った人を労う内容
- 明日への前向きなメッセージを含む
- 夜の食事・睡眠・明日の準備に関するヒントがあると◎
- 200文字以内
- ハッシュタグなし
- 自然な話し言葉で`,
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

  const postId = await postToThreads(text)
  console.log("投稿成功！ID:", postId)
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
