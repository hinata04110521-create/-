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

  const morningTopics = [
    "何をしても痩せない40・50代の体の仕組みと対策",
    "腰・膝の痛みがある人でもできる朝の習慣",
    "血糖値・コレステロールを食事で改善する方法",
    "更年期太りに効くたんぱく質の朝食",
    "代謝が落ちた体でも痩せる朝のルーティン",
    "先生に痩せろと言われたあなたへの最初の一歩",
    "病気になる前に変えられる朝の食べ方",
    "40代から筋肉を守る朝食の選び方",
    "血液検査の数値を改善するための朝の習慣",
    "体が重くて動けない人でも続けられる朝のこと",
    "更年期・ホルモン変化と体重増加の正しい理解",
    "朝の体重に一喜一憂しなくていい理由",
  ]

  const eveningTopics = [
    "頑張っても痩せない自分を責めなくていい理由",
    "膝・腰が痛くても夜にできるセルフケア",
    "血液検査の数値が気になる人の夜の食べ方",
    "夜中に目が覚める・眠れない人の体重との関係",
    "ストレスで食べてしまう40・50代へのメッセージ",
    "今日うまくいかなかった人へ。それでも大丈夫な理由",
    "明日の血糖値を下げるための今夜の選択",
    "病気が怖いからこそ今夜できる小さな一歩",
    "家族のために自分の体を大切にすることの意味",
    "何度失敗しても、また始めていい",
    "夜の食欲が止まらない人に知ってほしいこと",
    "更年期の体重増加、あなたのせいじゃない",
  ]

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
  const morningTopic = pick(morningTopics)
  const eveningTopic = pick(eveningTopics)

  const audience = `
【発信ターゲット】
- 40代・50代の女性
- 何をしても痩せない、ダイエットに何度も挑戦して失敗してきた
- 体重が重くて腰や膝に痛みがある
- 血液検査の数値が悪く、医師に痩せるよう言われている
- 糖尿病・高血圧・脂肪肝など病気への不安がある
- 「もう自分には無理かも」と諦めかけている
- でも健康でいたい、家族のためにも変わりたいと思っている
`

  const prompts = {
    morning: `あなたは40・50代女性専門のダイエットサポーターです。
${audience}
このターゲットに向けた「朝6時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${morningTopic}」
追加条件：
- 不安や悩みに寄り添いながら、今日一歩踏み出せる内容
- 難しいことは言わない。今日すぐできる小さなことを伝える
- 200文字以内`,

    evening: `あなたは40・50代女性専門のダイエットサポーターです。
${audience}
このターゲットに向けた「夜21時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${eveningTopic}」
追加条件：
- 今日うまくいかなかった人も救える内容
- 明日への小さな希望を持てるメッセージ
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
