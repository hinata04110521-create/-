const https = require("https")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const TWEET_MAX = 280        // Xの1ツイート上限
const TWEET_TARGET = 270     // 余裕を持たせたカット目安

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

// APIレスポンスを安全にパース
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

// 1ツイート投稿（replyToId を渡すとスレッド返信）。成功でツイートIDを返す
function postTweet(text, replyToId = null) {
  return new Promise((resolve, reject) => {
    const url = "https://api.twitter.com/2/tweets"
    const consumerKey = process.env.X_API_KEY
    const consumerSecret = process.env.X_API_SECRET
    const token = process.env.X_ACCESS_TOKEN
    const tokenSecret = process.env.X_ACCESS_TOKEN_SECRET
    if (!consumerKey || !consumerSecret || !token || !tokenSecret) {
      return reject(new Error("X APIキーが未設定です（X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET）"))
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

// 不要ラベル・区切り線を除去
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

// main（＋任意でreply）を1ツイート（270文字以内）にまとめてキリよくカット
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

// CTAをツイート末尾に足す（280文字を超えないよう本文を詰める）
function appendCta(tweet, cta) {
  const suffix = "\n\n" + cta
  if (tweet.length + suffix.length <= TWEET_MAX) return tweet + suffix
  const room = TWEET_MAX - suffix.length
  const within = tweet.slice(0, room)
  const lastPunct = Math.max(within.lastIndexOf("。"), within.lastIndexOf("！"), within.lastIndexOf("？"), within.lastIndexOf("\n"))
  const trimmed = lastPunct > 30 ? tweet.slice(0, lastPunct + 1) : within.trim()
  return trimmed + suffix
}

// ===== トピック（AIサポート） =====
const morningTopics = [
  "予約の電話対応をAIで自動化して施術に集中する方法",
  "口コミへの返信文をAIで30秒で作るやり方",
  "Googleマップの口コミをAIで無理なく増やす仕組み",
  "インスタ・Threadsの投稿文をAIにまとめて作らせる方法",
  "LINE公式の自動返信で新規予約を取りこぼさない設定",
  "無断キャンセルをAIリマインドで減らす方法",
  "チラシ・POPの文章をAIで作るコツ",
  "施術メニューの説明文をAIで分かりやすく書く方法",
  "問い合わせ対応をAIチャットボットに任せる第一歩",
  "手書き予約表からアプリ予約に変えるメリット",
  "AI初心者の院長がまず入れるべき無料ツール3つ",
  "ChatGPTを予約・集客に使う具体例",
  "サロンのブログ記事をAIで週1本ラクに書く方法",
  "顧客カルテ・来店履歴の管理をデジタル化する方法",
  "リピート促進のLINE配信文をAIで作る方法",
  "忙しい院長が朝10分でSNS運用を回す仕組み",
  "AIで競合サロンとの違いを言語化する方法",
  "新規客が増えるプロフィール文をAIで作るコツ",
  "AIを使った満足度アンケート・口コミ依頼のやり方",
  "「AIって難しそう」を解消する最初の一歩",
]

const lunchTopics = [
  "昼の予約対応をAIに任せて施術を止めない方法",
  "口コミ返信をAIでテンプレ化して時短する方法",
  "予約サイトとLINEを連携して二重入力をなくす方法",
  "SNSのネタ切れをAIで解決する方法",
  "来店後のお礼メッセージをAIで自動化する方法",
  "AIで作るクーポン・キャンペーン文の作り方",
  "新人スタッフ教育の資料をAIで作る方法",
  "施術中でも予約を取りこぼさない自動対応の作り方",
  "AIで顧客の悩み別トークスクリプトを作る方法",
  "月末の売上集計・分析をAIでラクにする方法",
  "ホームページの文章をAIでリライトして集客力を上げる方法",
  "AIで作る「よくある質問」ページで問い合わせを減らす方法",
  "予約の空き枠をSNSでAIに告知させる方法",
  "AIを使ったビフォーアフター投稿の見せ方",
  "リピートしない客の理由をAIで分析する方法",
  "AI音声で電話予約を24時間受ける仕組み",
  "チラシ配布よりAI集客が効く理由",
  "AIで作るスタッフ紹介・院紹介文のコツ",
  "経費・在庫管理をAIツールで簡単にする方法",
  "個人サロンがAIで大手に対抗する方法",
]

const afternoonTopics = [
  "1日の終わりにAIで明日のSNS投稿をまとめて準備する方法",
  "夕方の問い合わせをAIで取りこぼさない設定",
  "施術後の顧客フォローをAIで仕組み化する方法",
  "AIで今日の予約状況を振り返り明日に活かす方法",
  "閉店後の事務作業をAIで30分短縮する方法",
  "AIで作る月間の集客カレンダー",
  "口コミが増えない原因をAIで洗い出す方法",
  "AIを使ったリピート率アップの声かけ設計",
  "忙しくてSNSが続かない院長のためのAI自動化",
  "AIで作る次回予約につながるカウンセリングシート",
  "競合の強みをAIで分析して差別化する方法",
  "AIで新メニューのアイデアを10個出す方法",
  "夕方の空き枠をLINEでAI告知して埋める方法",
  "AIで作る「また来たくなる」お見送りトーク",
  "紙のカルテをやめてデジタル化する現実的な手順",
  "AIで顧客満足度アンケートを作り改善に回す方法",
  "AI導入でスタッフの残業を減らす考え方",
  "集客をチラシからSNS×AIに切り替える判断基準",
  "AIで作る季節キャンペーンの告知文",
  "小さなサロンほどAIで時間を生むべき理由",
]

const eveningTopics = [
  "AIを入れて一番ラクになった業務ランキングの考え方",
  "AIに任せていい仕事・任せてはいけない仕事の線引き",
  "「AI導入＝難しい」という思い込みを手放す話",
  "今夜10分で始められるAI活用の第一歩",
  "AIで空いた時間を施術の質に回すという発想",
  "小規模店がAIで生き残るためにまず捨てるべき作業",
  "AI集客で成果が出る人・出ない人の違い",
  "予約・集客・事務、まずどれをAI化すべきか",
  "AI導入は「完璧」より「まず1つ」でいい理由",
  "その事務作業、来年も手作業で続けますか？という問いかけ",
  "AIで顧客とのつながりを深める考え方",
  "手作業を続けることの本当のコスト",
  "AIを味方につけた院長の1日の変化",
  "「時間がない」を根本から解決するAIの使い方",
  "AI活用は若い人だけのもの、ではない理由",
  "AIの来店リマインドで無断キャンセルを防ぐ話",
  "口コミ・紹介が自然に増える仕組みの作り方",
  "AIツール選びで失敗しないための基準",
  "小さな一歩の自動化が半年後に生む差",
  "今夜、AIに1つだけ仕事を任せるなら何か",
]

const ctaOptions = [
  "自院に何から入れればいいか知りたい方は、プロフィールのLINEへ。",
  "AI導入の個別相談は、プロフィールのLINEかDMへどうぞ。",
  "「うちでも使える？」と思った方は、プロフィールのLINEへ。",
  "3ヶ月でAIを仕組み化したい方は、プロフィールのLINEから相談できます。",
]

// Claude API で1ツイート向けの本文（main＋reply）を生成（CTAは付けない）
async function generateWithClaude(timeSlot, topicIndex = 0, alreadyGenerated = []) {
  const Anthropic = require("@anthropic-ai/sdk")
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません")
  const client = new Anthropic({ apiKey })

  const localPosts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_x.json"), "utf-8"))
  const localExamples = [...(localPosts.morning || []).map((p) => p.main)]
  const examples = localExamples.join("\n\n---\n\n")

  const styleGuide = localExamples.length > 0 ? `
以下は実際の投稿例です。この文体・トーン・テンポを踏襲してください。

【投稿例】
${examples}

【守るべき文体】
- 短い文を改行で区切るリズム
- 読者への直接的な問いかけ
- 具体的なツール名・業務・数字・所要時間を使う
- ハッシュタグなし・絵文字なし・断定的で簡潔
` : ""

  const topicMap = {
    morning: morningTopics[topicIndex % morningTopics.length],
    lunch: lunchTopics[topicIndex % lunchTopics.length],
    afternoon: afternoonTopics[topicIndex % afternoonTopics.length],
    evening: eveningTopics[topicIndex % eveningTopics.length],
  }
  const currentTopic = topicMap[timeSlot]

  const searchQueryMap = {
    morning: `${currentTopic} 整骨院 整体 サロン 個人経営 AI活用 集客 予約 効率化`,
    lunch: `${currentTopic} 治療院 サロン AI ChatGPT 集客 予約 SNS 口コミ 自動化`,
    afternoon: `${currentTopic} 整体 エステ 小規模 AI 業務効率化 リピート 顧客管理`,
    evening: `${currentTopic} 治療院 サロン経営 AI 導入 効率化 時短 集客`,
  }

  console.log(`「${currentTopic}」を検索中...`)
  const searchResult = await searchWeb(searchQueryMap[timeSlot])
  const searchSection = searchResult ? `
【最新のネット情報（自然に盛り込んでください）】
${searchResult}
` : ""

  const audience = `
【発信ターゲット】
- 整骨院・整体院・エステ/リラクゼーションサロンの院長・オーナー・施術者
- 個人〜小規模店で、集客・予約・事務作業に追われている
- 「AIは気になるけど、何から使えばいいか分からない」
- ITやパソコンが得意ではなく、難しそうで手を出せずにいる
`

  const avoidSection = alreadyGenerated.length > 0 ? `
【以下と似た内容・表現・構成は使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}
` : ""

  const timeSlotHint = {
    morning: "開店前・朝の準備の場面。「今日も予約対応に追われそう…」という共感で始めると効果的。",
    lunch: "予約の合間・昼休みなど日中の忙しい場面。すぐ試せる時短ネタを。",
    afternoon: "夕方〜施術の合間の場面。「気づけば事務作業でこんな時間」など共感を入れる。",
    evening: "閉店後・振り返りの場面。AIで時間を生み施術や家族の時間に回せる前向きな締めに。",
  }

  const prompt = `あなたは整骨院・整体・サロン向けのAI導入アドバイザーです。X（旧Twitter）向けの投稿文を作ります。
${audience}
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
【この時間帯のヒント】${timeSlotHint[timeSlot]}

【AI導入の考え方（テーマに合えば自然に）】
- まず1つの業務だけ自動化する（予約対応・口コミ返信・SNS投稿など）
- 無料〜低コストのツール（ChatGPT・LINE公式・予約アプリ）から始める
- ITが苦手でもコピペや音声入力で使える

【最重要ルール】
- Xの1ツイートに収める前提。MAINとREPLYを合わせても【全体で250文字以内】に必ず収める
- スクロールを止めるフックから始め、具体ツール名・所要時間・手順を1つだけ入れる
- 構成を毎回同じにしない（毎回①→②→③にしない）
- 宣伝・フォロー誘導は書かない（別途付与）
- ハッシュタグなし・絵文字なし・見出し記号なし・区切り線なし

【出力形式（この形式のみ。ラベルは残す）】
MAIN:
（フック＋核心。60文字前後）

REPLY:
（具体的な手順やツール名を1つ。150文字以内。無理なら短くてよい）`

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

// 会話誘発型（質問）投稿をランダムに1つ返す
function getEngagementPost() {
  try {
    const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_x.json"), "utf-8"))
    const list = posts.engagement || []
    if (list.length === 0) return null
    return list[Math.floor(Math.random() * list.length)]
  } catch {
    return null
  }
}

// 現在の JST 時間に応じてコンテンツを決定
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
        const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_x.json"), "utf-8"))
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
        // 各実行の1枠目は会話誘発型（質問）
        const eng = getEngagementPost()
        if (eng) {
          console.log("タイプ: 会話誘発型（質問）投稿")
          tweet = fitTweet(eng.main, null) // 質問は単体で成立させる
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

      // CTAは4ツイートに1回だけ（1日の通し番号で制御）
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
