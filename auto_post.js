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

  const lunchTopics = [
    "血糖値の乱高下を抑える食べ方・食事の選び方（眠気を防いでダイエットにも効果的）",
    "40・50代女性に合った痩せるランチの選び方",
    "お昼にたんぱく質を摂ると午後が変わる理由",
    "コンビニランチで太らない選び方",
    "食後の眠気を防ぐ昼食の食べ方",
    "外食ランチで血糖値を上げない注文の仕方",
    "昼食を抜くと夜に太る理由",
    "お昼の炭水化物との正しい付き合い方",
    "野菜から食べるだけで変わる血糖値コントロール",
    "40代からの代謝を上げるお昼ごはんの組み合わせ",
  ]

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
    "朝の通勤でできる手軽なエクササイズ",
    "40・50代女性に合った痩せる朝ごはんのメニュー",
    "通勤中に消費カロリーを増やす小さな工夫",
    "朝ごはんを食べると痩せる理由と理想の組み合わせ",
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
  const lunchTopic = pick(lunchTopics)
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

    lunch: `あなたは40・50代女性専門のダイエットサポーターです。
${audience}
このターゲットに向けた「昼12時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${lunchTopic}」
追加条件：
- お昼の食事・食べ方に関する具体的なアドバイス
- 今日のランチから実践できる内容
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

// 閲覧数が多い投稿を取得（昼・夕方用）
async function getBestPost(timeSlot) {
  const TOKEN   = process.env.THREADS_ACCESS_TOKEN
  const USER_ID = process.env.THREADS_USER_ID

  // 朝・夜に特化した投稿は昼・夕方には使わない（除外キーワード）
  const morningKeywords = ["おはよう", "朝6時", "朝ごはん", "朝食", "起き", "朝に", "朝は", "朝の", "朝、", "朝タン", "朝パン", "朝通勤", "朝ルーティン", "今朝"]
  const eveningKeywords = ["おやすみ", "夜21時", "今日も頑張", "お疲れ様"]
  const excludeKeywords = [...morningKeywords, ...eveningKeywords]

  try {
    // 直近50件の投稿を取得
    const postsUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads?fields=id,text&limit=50&access_token=${TOKEN}`
    const postsRes = await threadsGet(postsUrl)
    const validPosts = (postsRes.data || []).filter(
      (p) => p.text && p.text.length > 10 && !excludeKeywords.some((k) => p.text.includes(k))
    )
    if (validPosts.length === 0) throw new Error("該当投稿なし")

    // 各投稿の閲覧数を取得
    const postsWithViews = await Promise.all(
      validPosts.map(async (post) => {
        try {
          const url = `https://graph.threads.net/v1.0/${post.id}/insights?metric=views&access_token=${TOKEN}`
          const insights = await threadsGet(url)
          const item = insights.data?.[0]
          const views = item?.total_value?.value ?? item?.values?.[0]?.value ?? 0
          return { text: post.text, views, source: "account" }
        } catch {
          return { text: post.text, views: 0, source: "account" }
        }
      })
    )

    // posts.json の候補も追加（閲覧数0として）
    const localPosts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts.json"), "utf-8"))
    const localCandidates = localPosts[timeSlot].map((text) => ({ text, views: 0, source: "local" }))

    // 合わせて閲覧数で降順ソート（同数ならアカウント投稿を優先）
    const all = [...postsWithViews, ...localCandidates]
    all.sort((a, b) => b.views - a.views || (a.source === "account" ? -1 : 1))

    // トップ5の中からランダムに選ぶ（毎回同じにならないように）
    const top5 = all.slice(0, 5)
    const picked = top5[Math.floor(Math.random() * top5.length)]
    console.log(`選択（${timeSlot}）: ${picked.source} / 閲覧数 ${picked.views}回`)
    return picked.text

  } catch (e) {
    console.log(`投稿取得失敗、posts.jsonからランダム選択: ${e.message}`)
    const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts.json"), "utf-8"))
    const list = posts[timeSlot]
    return list[Math.floor(Math.random() * list.length)]
  }
}

// 現在の JST 時間に応じてコンテンツを決定
async function getContent() {
  const jstHour = (new Date().getUTCHours() + 9) % 24
  console.log(`JST: ${jstHour}時`)

  if (jstHour >= 4 && jstHour < 10) {
    console.log("タイプ: AI生成（朝）")
    return await generateWithClaude("morning")
  } else if (jstHour >= 10 && jstHour < 16) {
    console.log("タイプ: AI生成（昼）")
    return await generateWithClaude("lunch")
  } else if (jstHour >= 16 && jstHour < 21) {
    console.log("タイプ: 閲覧数トップ（夕）")
    return await getBestPost("afternoon")
  } else {
    // 夜はAI生成とposts.jsonをランダムに使う
    const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts.json"), "utf-8"))
    const useFixed = posts.evening && posts.evening.length > 0 && Math.random() < 0.5
    if (useFixed) {
      console.log("タイプ: 固定投稿（夜）")
      return posts.evening[Math.floor(Math.random() * posts.evening.length)]
    }
    console.log("タイプ: AI生成（夜）")
    return await generateWithClaude("evening")
  }
}

async function main() {
  const totalPosts = 4

  for (let i = 1; i <= totalPosts; i++) {
    console.log(`\n===== 投稿 ${i}/${totalPosts} =====`)
    const text = await getContent()
    console.log("\n--- 投稿内容 ---")
    console.log(text)
    console.log("----------------\n")

    if (process.env.DRY_RUN === "true") {
      console.log(`※ プレビューモード：投稿 ${i} はしていません`)
    } else {
      const postId = await postToThreads(text)
      console.log(`投稿成功！ ${i}/${totalPosts} ID:`, postId)
    }

    // 投稿間隔（レート制限対策）
    if (i < totalPosts) await new Promise((r) => setTimeout(r, 5000))
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
