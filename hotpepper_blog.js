const https = require("https")

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

// LINE Messaging API でプッシュ送信（最大5メッセージ）
function linePush(messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const userId = process.env.LINE_USER_ID
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      to: userId,
      messages: messages.map((text) => ({ type: "text", text })),
    })
    const options = {
      method: "POST",
      hostname: "api.line.me",
      path: "/v2/bot/message/push",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${token}`,
      },
    }
    const req = https.request(options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve()
        } else {
          reject(new Error(`LINE送信エラー (${res.statusCode}): ${data}`))
        }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

// Gmail でメール送信（LINE未設定時のフォールバック）
async function sendEmail(title, bodyText, dateLabel) {
  const nodemailer = require("nodemailer")
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  })
  await transporter.sendMail({
    from: `HotPepper Blog <${process.env.GMAIL_USER}>`,
    to: process.env.REPORT_EMAIL || process.env.GMAIL_USER,
    subject: `📝 今日のホットペッパーブログ案 - ${dateLabel}`,
    text: `■タイトル\n${title}\n\n■本文\n${bodyText}\n\n---\nこのままサロンボードのブログにコピペしてください。\n本メールはGitHub Actionsにより自動送信されています。`,
  })
}

// ブログテーマ（日替わりローテーション）
const blogThemes = [
  // 頭痛・肩こり・姿勢
  "朝起きた時から頭が重い人に知ってほしい、枕と首の関係",
  "整体に行っても肩こりが戻ってしまう本当の理由",
  "猫背を放置すると頭痛が慢性化するメカニズム",
  "デスクワークの人の頭痛が夕方に悪化する理由と対策",
  "ストレートネックのセルフチェック方法と改善の第一歩",
  "更年期の頭痛と自律神経の関係・今日からできるケア",
  "頭痛薬を手放せない人に知ってほしい薬物乱用頭痛の話",
  "肩甲骨を動かすだけで肩こりが楽になる理由",
  "スマホの持ち方を変えるだけで首こりが減る話",
  "緊張型頭痛と片頭痛の見分け方・対処法の違い",
  // 鉄分・貧血
  "40代女性の頭痛・疲れやすさは鉄分不足が原因かもしれない話",
  "貧血気味の人が食事で意識すべき鉄分の摂り方",
  "マグネシウム不足と頭痛の関係・多く含まれる食品",
  // ダイエット・健康
  "40代から痩せにくくなる本当の理由と対策",
  "運動なしで代謝を上げる日常の工夫3つ",
  "更年期太りの正体とホルモンの関係",
  "睡眠不足が太りやすさに直結する理由",
  "血糖値の急上昇を防ぐ食べる順番の話",
  "40代女性がタンパク質を意識すべき理由と摂り方",
  "むくみと血流の関係・夕方の足のだるさ対策",
  // 姿勢×ダイエット
  "姿勢を直すと痩せやすくなる理由（筋肉と代謝の話）",
  "呼吸が浅い人は太りやすい？猫背と呼吸とダイエット",
  // 生活習慣
  "自律神経を整える夜の過ごし方・頭痛と睡眠の質",
  "水分不足が頭痛・むくみ・代謝低下を招く理由",
  "湯船に浸かるだけで変わる血流と肩こりの話",
  "ストレスと食欲・頭痛の関係（コルチゾールの話）",
  "冷え性と頭痛・肩こりの意外なつながり",
  "週末にどっと疲れが出る人の平日の過ごし方",
]

// Claude でブログ記事を生成
async function generateBlog() {
  const Anthropic = require("@anthropic-ai/sdk")
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません")
  const client = new Anthropic({ apiKey })

  // JSTの日付から日替わりでテーマを決定
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((now.getTime() - startOfYear) / 86400000)
  const theme = blogThemes[dayOfYear % blogThemes.length]

  console.log(`本日のテーマ: ${theme}`)
  const searchResult = await searchWeb(`${theme} 40代 50代 女性 原因 改善方法`)
  const searchSection = searchResult ? `
【最新のネット情報（参考情報として自然に記事へ盛り込んでください）】
${searchResult}
` : ""

  const prompt = `あなたは川崎市宮前区で整体サロンを営む、頭痛・肩こり・姿勢改善とダイエットサポートの専門家です。
ホットペッパービューティーに掲載するサロンブログの記事を1本書いてください。

【読者ターゲット】
- 40代・50代の女性
- 慢性的な頭痛・肩こり・猫背、または痩せにくさに悩んでいる
- ホットペッパーでサロンを探している（=来店意欲がある読者）

【記事の目的】
読んだ人が「このサロンの先生は信頼できそう」と感じて、ネット予約や問い合わせにつながること。

今回のテーマ：「${theme}」
${searchSection}
【本文の構成】
1. 共感の導入（「〜でお悩みではありませんか？」など、読者のあるあるから入る）
2. 原因をわかりやすく解説（専門用語は噛み砕く）
3. 今日からできるセルフケアを1〜2個、具体的に紹介
4. サロンでの施術でできることに軽く触れ、来店を促す締め（押し売り感を出さない）

【ルール】
- タイトルは28文字以内。読者が検索しそうな言葉を入れ、思わず開きたくなるものに
- 本文は400〜600文字。段落ごとに空行を入れて読みやすく
- 絵文字は使っても2個まで
- ハッシュタグ・区切り線（---など）・見出し記号（#や■）は使わない
- 「別案」「案1」などのラベルは書かない
- 誇大表現（必ず治る、絶対痩せる等）は使わない

以下の形式で出力してください（TITLE:とBODY:の文字はそのまま残してください）：
TITLE:
（タイトル）

BODY:
（本文）`

  const message = await callAnthropicWithRetry(client, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  })

  const text = message.content[0].text.trim()
  const titleMatch = text.match(/TITLE:\n?([\s\S]*?)(?=\nBODY:)/)
  const bodyMatch = text.match(/BODY:\n?([\s\S]*)/)

  let title = titleMatch ? titleMatch[1].trim() : "タイトル生成エラー"
  let body = bodyMatch ? bodyMatch[1].trim() : text

  // 不要ラベル・区切り線を除去
  function cleanText(t) {
    return t
      .replace(/^(別案[：:・]?|案\d+[：:・]?|パターン\d+[：:・]?)[^\n]*/mg, "")
      .replace(/^【[^】]*】\s*\n?/mg, "")
      .replace(/^[-ーー─━=＝\*＊#■]{2,}$/mg, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }
  title = cleanText(title).replace(/\n/g, " ")
  body = cleanText(body)

  // タイトル：50文字でカット（サロンボードの上限対策）
  if (title.length > 50) {
    title = title.slice(0, 50)
    console.log("タイトルを50文字にカット")
  }

  // 本文：長すぎる場合はキリのいい場所でカット
  if (body.length > 1000) {
    const within = body.slice(0, 1000)
    const lastPunct = Math.max(within.lastIndexOf("。"), within.lastIndexOf("！"), within.lastIndexOf("？"))
    body = lastPunct > 100 ? body.slice(0, lastPunct + 1).trim() : within.trim()
    console.log(`本文文字数カット → ${body.length}文字`)
  }

  return { title, body }
}

async function main() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const dateLabel = `${now.getUTCMonth() + 1}/${now.getUTCDate()}`

  const { title, body } = await generateBlog()

  console.log("\n--- タイトル ---")
  console.log(title)
  console.log("\n--- 本文 ---")
  console.log(body)
  console.log("----------------\n")

  if (process.env.DRY_RUN === "true") {
    console.log("※ プレビューモード：送信していません")
    return
  }

  const hasLine = process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID
  const hasGmail = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD

  if (hasLine) {
    // メッセージを分けて送る（本文だけを長押しコピーできるように）
    await linePush([
      `📝 今日のホットペッパーブログ案（${dateLabel}）\n\n■タイトル\n${title}\n\n↓本文は次のメッセージをそのままコピペ`,
      body,
    ])
    console.log("LINEに送信しました")
  } else if (hasGmail) {
    console.log("LINE未設定のためメールで送信します")
    await sendEmail(title, body, dateLabel)
    console.log("メールを送信しました")
  } else {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID（またはGmailの認証情報）が設定されていません")
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
