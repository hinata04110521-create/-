const https = require("https")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const TWEET_MAX = 280
const TWEET_TARGET = 270
const POSTS_FILE = "posts_x_health.json"

// Anthropic API リトライ付き呼び出し（529 Overloaded に対応）
async function callAnthropicWithRetry(client, params, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(params)
    } catch (err) {
      const isOverloaded = err.status === 529 || (err.message && err.message.includes("overloaded"))
      if (isOverloaded && attempt < maxRetries) {
        const waitSec = attempt * 15
        console.log(`Anthropic過負荷のためリトライ (${attempt}/${maxRetries - 1}) … ${waitSec}秒待機`)
        await new Promise(r => setTimeout(r, waitSec * 1000))
      } else {
        throw err
      }
    }
  }
}

function parseApiResponse(data, statusCode) {
  const raw = (data || "").trim()
  if (raw === "") {
    return { error: { message: `空のレスポンス（HTTP ${statusCode || "不明"}）。トークン失効・レート制限・課金未設定の可能性があります` } }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { error: { message: `JSON以外のレスポンス（HTTP ${statusCode || "不明"}）: ${raw.slice(0, 200)}` } }
  }
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

// ===== X（Twitter）API v2 への投稿：OAuth 1.0a（HMAC-SHA1）署名 =====
function pctEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
}

function buildOAuthHeader(method, url, oauthParams, consumerSecret, tokenSecret) {
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(oauthParams[k])}`)
    .join("&")
  const baseString = `${method.toUpperCase()}&${pctEncode(url)}&${pctEncode(paramString)}`
  const signingKey = `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64")
  const headerParams = { ...oauthParams, oauth_signature: signature }
  return "OAuth " + Object.keys(headerParams)
    .sort()
    .map((k) => `${pctEncode(k)}="${pctEncode(headerParams[k])}"`)
    .join(", ")
}

function postTweet(text, replyToId = null) {
  return new Promise((resolve, reject) => {
    const url = "https://api.twitter.com/2/tweets"
    const consumerKey = process.env.X_HEALTH_API_KEY
    const consumerSecret = process.env.X_HEALTH_API_SECRET
    const token = process.env.X_HEALTH_ACCESS_TOKEN
    const tokenSecret = process.env.X_HEALTH_ACCESS_TOKEN_SECRET
    if (!consumerKey || !consumerSecret || !token || !tokenSecret) {
      return reject(new Error("X APIキーが未設定です（X_HEALTH_API_KEY / X_HEALTH_API_SECRET / X_HEALTH_ACCESS_TOKEN / X_HEALTH_ACCESS_TOKEN_SECRET）"))
    }

    const oauthParams = {
      oauth_consumer_key: consumerKey,
      oauth_nonce: crypto.randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: token,
      oauth_version: "1.0",
    }
    const authHeader = buildOAuthHeader("POST", url, oauthParams, consumerSecret, tokenSecret)

    const bodyObj = { text }
    if (replyToId) bodyObj.reply = { in_reply_to_tweet_id: replyToId }
    const body = JSON.stringify(bodyObj)

    const options = {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }
    const req = https.request(url, options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        const parsed = parseApiResponse(data, res.statusCode)
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed.data && parsed.data.id) {
          resolve(parsed.data.id)
        } else {
          const msg =
            parsed.detail ||
            parsed.title ||
            (parsed.errors && parsed.errors[0] && (parsed.errors[0].message || parsed.errors[0].detail)) ||
            (parsed.error && parsed.error.message) ||
            `HTTP ${res.statusCode}`
          reject(new Error(msg))
        }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

function cleanText(t) {
  return t
    .replace(/^#+\s*(夜|朝|昼|夕方)[^\n]*/mg, "")
    .replace(/^(夜\d*時|朝\d*時|昼\d*時|夕方\d*時)[^\n]*/mg, "")
    .replace(/^(別案[：:・]?|案\d+[：:・]?|パターン\d+[：:・]?)[^\n]*/mg, "")
    .replace(/^【[^】]*】\s*\n?/mg, "")
    .replace(/^(テーマ|題材|今回のテーマ)[：:][^\n]*/mg, "")
    .replace(/^[-ーー─━=＝\*＊]{2,}$/mg, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function fitTweet(main, reply, maxLen = TWEET_TARGET) {
  let base = (main || "").trim()
  if (reply && reply.trim()) base += "\n\n" + reply.trim()
  base = cleanText(base)
  if (base.length <= maxLen) return base
  const within = base.slice(0, maxLen)
  const lastPunct = Math.max(
    within.lastIndexOf("。"),
    within.lastIndexOf("！"),
    within.lastIndexOf("？"),
    within.lastIndexOf("\n")
  )
  return (lastPunct > 40 ? base.slice(0, lastPunct + 1) : within).trim()
}

function appendCta(tweet, cta) {
  const suffix = "\n\n" + cta
  if (tweet.length + suffix.length <= TWEET_MAX) return tweet + suffix
  const room = TWEET_MAX - suffix.length
  const within = tweet.slice(0, room)
  const lastPunct = Math.max(within.lastIndexOf("。"), within.lastIndexOf("！"), within.lastIndexOf("？"), within.lastIndexOf("\n"))
  const trimmed = lastPunct > 30 ? tweet.slice(0, lastPunct + 1) : within.trim()
  return trimmed + suffix
}

// ===== トピック（40〜50代女性の健康：ダイエット＋頭痛・肩こり・姿勢） =====
const morningTopics = [
  "40代からの代謝低下と朝たんぱく質の関係",
  "朝の頭痛と寝る姿勢・枕の高さの関係",
  "鉄分不足が招く疲れ・立ちくらみ・頭痛",
  "朝に白湯とストレッチで血流を上げる習慣",
  "食べる順番（野菜・たんぱく質・炭水化物）で太りにくくする",
  "更年期世代の体重増加の本当の原因",
  "肩こりからくる緊張型頭痛のセルフケア",
  "朝食を抜くと逆に太りやすくなる理由",
  "猫背・ストレートネックが不調を招く仕組み",
  "睡眠の質とダイエット・頭痛の関係",
  "40代・50代が減らすべき朝の習慣",
  "むくみと塩分・水分・血流の関係",
  "デスクワークの肩こり予防の座り方",
  "空腹を我慢しないダイエットの考え方",
  "気圧の変化に負けない自律神経の整え方",
]

const lunchTopics = [
  "昼食後の眠気と血糖値の急上昇を防ぐ食べ方",
  "昼にできる肩こり・首こりリセット法",
  "外食・コンビニでも太りにくい選び方",
  "デスクワークの合間にできる姿勢リセット",
  "間食を味方にするダイエットの工夫",
  "午後の頭痛を防ぐ水分と休憩のとり方",
  "食べても痩せる人がやっている昼の習慣",
  "パソコン作業の目の疲れと頭痛のケア",
  "たんぱく質が足りない人の昼食パターン",
  "座りっぱなしがむくみと代謝を下げる話",
  "昼の炭水化物との上手な付き合い方",
  "肩甲骨を動かすだけで血流が変わる話",
  "40代からの筋肉量を守る昼の一工夫",
  "頭痛持ちが避けたい昼の食べ物・飲み物",
  "食事制限より効く、日中の活動量アップ",
]

const afternoonTopics = [
  "夕方のだるさ・むくみと血流の関係",
  "夕方に強くなる緊張型頭痛の対処法",
  "夕食前の空腹をドカ食いにしない工夫",
  "1日の終わりの肩こりをためない習慣",
  "夕方の疲れと鉄分・貧血のサイン",
  "夜太りを防ぐ夕食の時間と内容",
  "首・肩を温めて頭痛をやわらげる方法",
  "夕方の甘いもの欲求との付き合い方",
  "帰宅後にできる姿勢リセットストレッチ",
  "食べ過ぎた翌日のリカバリーの考え方",
  "自律神経を整える夕方の過ごし方",
  "むくみを翌日に持ち越さない夜の習慣",
  "夜の血糖値を上げない夕食の順番",
  "スマホ首が夜の頭痛を招く仕組み",
  "運動が続かない人の夕方10分習慣",
]

const eveningTopics = [
  "寝る前のスマホが頭痛と睡眠を悪くする話",
  "夜の食べ方ひとつで翌朝の体が変わる",
  "寝る姿勢・枕で朝の頭痛を防ぐ",
  "夜のストレッチで肩こりと血流を整える",
  "夜遅い食事が太る本当の理由",
  "睡眠の質を上げて痩せやすい体をつくる",
  "1日の緊張を抜く首・肩のゆるめ方",
  "更年期世代の不眠と自律神経のケア",
  "明日のむくみを防ぐ夜の過ごし方",
  "頑張らないダイエットが続く理由",
  "寝る前の白湯と深呼吸で整える習慣",
  "鉄分不足の人が夜に気をつけたいこと",
  "猫背をリセットして呼吸を深くする方法",
  "夜の食欲は睡眠不足のサインかもしれない話",
  "小さな習慣が3ヶ月で体を変える理由",
]

const ctaOptions = [
  "あなたに合った方法を知りたい方は、プロフィールのLINEへ。",
  "個別に相談したい方は、プロフィールのLINEかDMへどうぞ。",
  "自分に何が足りないか知りたい方は、プロフィールのLINEへ。",
  "3ヶ月で変わりたい方は、プロフィールのLINEから相談できます。",
]

async function generateWithClaude(timeSlot, topicIndex = 0, alreadyGenerated = []) {
  const Anthropic = require("@anthropic-ai/sdk")
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません")
  const client = new Anthropic({ apiKey })

  const localPosts = JSON.parse(fs.readFileSync(path.join(__dirname, POSTS_FILE), "utf-8"))
  const localExamples = [...(localPosts.morning || []).map((p) => p.main)]
  const examples = localExamples.join("\n\n---\n\n")

  const styleGuide = localExamples.length > 0 ? `
以下は実際の投稿例です。この文体・トーン・テンポを踏襲してください。

【投稿例】
${examples}

【守るべき文体】
- 「これ私だ」と感じる共感フックから始める
- 短い文を改行で区切るリズム
- 根本原因を一言で示し、今日できる小さな行動を1つ添える
- ハッシュタグなし・絵文字なし・断定的で簡潔
` : ""

  const topicMap = {
    morning: morningTopics[topicIndex % morningTopics.length],
    lunch: lunchTopics[topicIndex % lunchTopics.length],
    afternoon: afternoonTopics[topicIndex % afternoonTopics.length],
    evening: eveningTopics[topicIndex % eveningTopics.length],
  }
  const currentTopic = topicMap[timeSlot]

  console.log(`「${currentTopic}」を検索中...`)
  const searchResult = await searchWeb(`${currentTopic} 40代 50代 女性 ダイエット 頭痛 肩こり 姿勢 健康`)
  const searchSection = searchResult ? `
【最新のネット情報（自然に盛り込んでください）】
${searchResult}
` : ""

  const audience = `
【発信ターゲット】
- 40〜50代の女性
- ダイエット・体型の変化、頭痛・肩こり・猫背、鉄分不足・貧血、睡眠や自律神経の不調に悩んでいる
- 「昔と同じなのに痩せない」「不調が当たり前になっている」と感じている
- 難しい理論より、今日できる小さな一歩を知りたい
`

  const avoidSection = alreadyGenerated.length > 0 ? `
【以下と似た内容・表現・構成は使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}
` : ""

  const timeSlotHint = {
    morning: "朝の場面。「今日こそ」と思える前向きな共感で始める。",
    lunch: "日中・仕事や家事の合間の場面。すぐ試せる小さなケアを。",
    afternoon: "夕方のだるさ・疲れの場面。共感からやわらげる提案へ。",
    evening: "夜・1日の終わりの場面。頑張りすぎず整える前向きな締めに。",
  }

  const prompt = `あなたは40〜50代女性向けの、ダイエットと不調改善（頭痛・肩こり・姿勢・貧血）に詳しい専門家です。X（旧Twitter）向けの投稿文を作ります。
${audience}
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
【この時間帯のヒント】${timeSlotHint[timeSlot]}

【最重要ルール】
- Xの1ツイートに収める前提。MAINとREPLYを合わせても【全体で250文字以内】に必ず収める
- 1行目：スクロールを止める共感フック（比較型・意外性型・疑問型）
- 根本原因を一言 → 今日できる行動を一言、の流れを意識する
- 構成を毎回同じにしない（毎回①→②→③にしない）
- 宣伝・フォロー誘導は書かない（別途付与）
- ハッシュタグなし・絵文字なし・見出し記号なし・区切り線なし
- 医療の断定・過度な不安を煽る表現はしない

【出力形式（この形式のみ。ラベルは残す）】
MAIN:
（共感フック＋核心。60文字前後）

REPLY:
（根拠や今日できる一歩。150文字以内。無理なら短くてよい）`

  const message = await callAnthropicWithRetry(client, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  })

  const text = message.content[0].text.trim()
  const mainMatch = text.match(/MAIN:\n([\s\S]*?)(?=\nREPLY:)/)
  const replyMatch = text.match(/REPLY:\n([\s\S]*)/)
  let main = mainMatch ? mainMatch[1].trim() : text
  let reply = replyMatch ? replyMatch[1].trim() : null
  main = cleanText(main)
  if (reply) reply = cleanText(reply)
  return { main, reply }
}

function getEngagementPost() {
  try {
    const posts = JSON.parse(fs.readFileSync(path.join(__dirname, POSTS_FILE), "utf-8"))
    const list = posts.engagement || []
    if (list.length === 0) return null
    return list[Math.floor(Math.random() * list.length)]
  } catch {
    return null
  }
}

async function getContent(topicIndex = 0, alreadyGenerated = []) {
  const jstHour = (new Date().getUTCHours() + 9) % 24
  console.log(`JST: ${jstHour}時`)
  if (jstHour >= 4 && jstHour < 10) {
    console.log("タイプ: AI生成（朝）")
    return await generateWithClaude("morning", topicIndex, alreadyGenerated)
  } else if (jstHour >= 10 && jstHour < 16) {
    console.log("タイプ: AI生成（昼）")
    return await generateWithClaude("lunch", topicIndex, alreadyGenerated)
  } else if (jstHour >= 16 && jstHour < 21) {
    console.log("タイプ: AI生成（夕）")
    return await generateWithClaude("afternoon", topicIndex, alreadyGenerated)
  } else {
    console.log("タイプ: AI生成（夜）")
    return await generateWithClaude("evening", topicIndex, alreadyGenerated)
  }
}

async function main() {
  const totalPosts = 2 // 1回2ツイート × 4回 = 8ツイート/日
  const jstHour = (new Date().getUTCHours() + 9) % 24
  const isMorning = jstHour >= 4 && jstHour < 10
  const execOrder = jstHour < 10 ? 0 : jstHour < 16 ? 1 : jstHour < 21 ? 2 : 3
  const alreadyGenerated = []
  let failureCount = 0

  for (let i = 1; i <= totalPosts; i++) {
    console.log(`\n===== ツイート ${i}/${totalPosts} =====`)
    try {
      let tweet

      if (isMorning) {
        const posts = JSON.parse(fs.readFileSync(path.join(__dirname, POSTS_FILE), "utf-8"))
        const fixedPosts = posts.morning || []
        if (i - 1 < fixedPosts.length) {
          console.log("タイプ: 固定投稿（朝）")
          const post = fixedPosts[i - 1]
          tweet = fitTweet(post.main, post.reply)
        } else {
          console.log("タイプ: AI生成（朝）")
          const g = await generateWithClaude("morning", i - 1, alreadyGenerated)
          alreadyGenerated.push(g.main)
          tweet = fitTweet(g.main, g.reply)
        }
      } else if (i === 1) {
        const eng = getEngagementPost()
        if (eng) {
          console.log("タイプ: 会話誘発型（質問）投稿")
          tweet = fitTweet(eng.main, null)
        } else {
          const g = await getContent(i - 1, alreadyGenerated)
          alreadyGenerated.push(g.main)
          tweet = fitTweet(g.main, g.reply)
        }
      } else {
        const g = await getContent(i - 1, alreadyGenerated)
        alreadyGenerated.push(g.main)
        tweet = fitTweet(g.main, g.reply)
      }

      const globalIndex = execOrder * 2 + (i - 1)
      if (globalIndex % 4 === 3) {
        const cta = ctaOptions[globalIndex % ctaOptions.length]
        tweet = appendCta(tweet, cta)
        console.log(`CTA追加: ${cta}`)
      }

      console.log("\n--- ツイート本文 ---")
      console.log(tweet)
      console.log(`（${tweet.length}文字）`)
      console.log("----------------\n")

      if (process.env.DRY_RUN === "true") {
        console.log(`※ プレビューモード：ツイート ${i} は投稿していません`)
      } else {
        const id = await postTweet(tweet)
        console.log(`投稿成功！ ${i}/${totalPosts}  id=${id}`)
      }
    } catch (e) {
      failureCount++
      console.error(`ツイート ${i}/${totalPosts} をスキップ（残りは継続）: ${e.message}`)
    }

    if (i < totalPosts) await new Promise((r) => setTimeout(r, 5000))
  }

  if (failureCount > 0) {
    console.error(`\n⚠ ${failureCount}/${totalPosts} 件のツイートが失敗しました。X APIキーの失効・課金設定・レート制限を確認してください。`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
