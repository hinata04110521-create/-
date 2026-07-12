const https = require("https")
const fs = require("fs")
const path = require("path")

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

// 朝の投稿（メイン＋返信）をAIで生成
async function generateMorningPost(topicIndex = 0, alreadyGenerated = []) {
  const Anthropic = require("@anthropic-ai/sdk")
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません")
  const client = new Anthropic({ apiKey })

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

  const topic = morningTopics[topicIndex % morningTopics.length]

  console.log(`朝「${topic}」を検索中...`)
  const searchResult = await searchWeb(`${topic} 整骨院 整体 サロン 個人経営 AI活用 集客 予約 効率化`)
  const searchSection = searchResult ? `
【最新のネット情報（参考情報として自然に投稿へ盛り込んでください）】
${searchResult}
` : ""

  const avoidSection = alreadyGenerated.length > 0 ? `
【以下の投稿と似た内容・表現・構成は絶対に使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}

上記と異なるテーマ・切り口・表現で書いてください。
` : ""

  const audience = `
【発信ターゲット】
- 整骨院・整体院・エステ/リラクゼーションサロンの院長・オーナー・施術者
- 個人〜小規模店（1人〜数人）で、集客・予約・事務作業に追われている
- 「AIは気になるけど、何から使えばいいか分からない」
- 予約の電話対応、口コミ返信、SNS投稿、日々の事務に時間を取られている
- 新規集客・リピート・無断キャンセルに悩んでいる
- ITやパソコンが得意ではなく、難しそうで手を出せずにいる
`

  const ctaOptions = [
    "自院に何から入れればいいか知りたい方は、プロフィールのLINEへ。",
    "AI導入の個別相談は、プロフィールのLINEかDMへどうぞ。",
    "「うちでも使える？」と思った方は、プロフィールのLINEへ。",
    "3ヶ月でAIを仕組み化したい方は、プロフィールのLINEから相談できます。",
  ]

  const prompt = `あなたは整骨院・整体・サロン向けのAI導入アドバイザーです。
${audience}

朝のThreads投稿を以下の形式で作成してください。
${searchSection}
【投稿の目的】
フォロワー0からスタートするアカウントです。「それ、うちの悩みだ」と刺さる共感と「今すぐ試せる」具体性で保存・拡散され、専門家への信頼から相談につながる投稿を作ってください。

【メイン投稿のルール】
- 整骨院・整体・サロンの院長/オーナーが「まさに自分のことだ」と感じる共感フックで始める
- 「予約の電話で施術が中断」「口コミ返信が面倒」「SNSが続かない」などリアルな現場の言葉を使う
- 横文字を並べすぎず、ITが苦手な人にも分かる言葉で
- 基本は40〜60文字。内容によって100文字まで許容する

【返信投稿のルール】
- 構成：①共感（「〜で手が回らない院長、多いです」）→ ②なぜAIで解決できるか → ③今日からできる具体ステップ → ④背中を押す一言
- ステップは「① 〇〇 → 〇〇（それで何がラクになるか）」の形式で3〜5項目（500文字以内）
- 無料ツール名や所要時間など具体的に書き、難しそうに聞こえないようにする
- 読んだ人が「この人に相談したい」と思える、実務的で誠実なトーンで
- ハッシュタグなし・絵文字なし
- 「また明日も頑張ろう」「一緒に頑張ろう」などの締めくくりフレーズは絶対に使わない

今回のテーマ：「${topic}」
${avoidSection}

以下の形式で出力してください（MAIN:とREPLY:の文字はそのまま残してください）：
MAIN:
（メイン投稿の内容）

REPLY:
（返信投稿の内容）`

  const message = await callAnthropicWithRetry(client, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  })

  const text = message.content[0].text.trim()

  const mainMatch = text.match(/MAIN:\n([\s\S]*?)(?=\nREPLY:)/)
  const replyMatch = text.match(/REPLY:\n([\s\S]*)/)

  const main = mainMatch ? mainMatch[1].trim() : text
  let reply = replyMatch ? replyMatch[1].trim() : null

  // 1日8投稿の通し番号でCTAを制御（4投稿に1回だけ、控えめに）
  const jstHourM = (new Date().getUTCHours() + 9) % 24
  const execOrderM = jstHourM < 10 ? 0 : jstHourM < 16 ? 1 : jstHourM < 21 ? 2 : 3
  const globalIndexM = execOrderM * 2 + topicIndex
  if (globalIndexM % 4 === 3 && reply) {
    const cta = ctaOptions[globalIndexM % ctaOptions.length]
    reply = reply + "\n\n" + cta
    console.log(`朝CTA追加: ${cta}`)
  }

  return { main, reply }
}

// Claude API でテキスト生成
async function generateWithClaude(timeSlot, topicIndex = 0, alreadyGenerated = []) {
  const Anthropic = require("@anthropic-ai/sdk")
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません")
  const client = new Anthropic({ apiKey })

  const localPosts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_aisupport.json"), "utf-8"))
  const localExamples = [...(localPosts.morning || []).map(p => p.main)]

  const accountPosts = await fetchMyPosts()
  console.log(`アカウントから${accountPosts.length}件の投稿を取得`)

  const allExamples = [...accountPosts, ...localExamples].slice(0, 50)
  const examples = allExamples.join("\n\n---\n\n")

  const styleGuide = allExamples.length > 0 ? `
以下は実際のThreadsアカウントの投稿です。この文体・トーン・表現スタイルを完全に模倣して書いてください。

【実際の投稿例】
${examples}

【守るべき文体の特徴】
- 短い文を改行で区切るリズム感
- 読者への直接的な問いかけ（〜してる？〜ですか？〜ない？）
- 具体的なツール名・業務・数字・所要時間を使う
- 最後に一言アクションを促す
- ハッシュタグなし・絵文字なし
- 断定的で簡潔な言い切り表現
` : ""

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

  const topicMap = {
    morning: morningTopics[topicIndex % morningTopics.length],
    lunch: lunchTopics[topicIndex % lunchTopics.length],
    afternoon: afternoonTopics[topicIndex % afternoonTopics.length],
    evening: eveningTopics[topicIndex % eveningTopics.length],
  }
  const currentTopic = topicMap[timeSlot]

  // トピックに合わせた具体的な検索クエリ
  const searchQueryMap = {
    morning: `${currentTopic} 整骨院 整体 サロン 個人経営 AI活用 集客 予約 効率化`,
    lunch: `${currentTopic} 治療院 サロン AI ChatGPT 集客 予約 SNS 口コミ 自動化`,
    afternoon: `${currentTopic} 整体 エステ 小規模 AI 業務効率化 リピート 顧客管理`,
    evening: `${currentTopic} 治療院 サロン経営 AI 導入 効率化 時短 集客`,
  }

  console.log(`「${currentTopic}」を検索中...`)
  const searchResult = await searchWeb(searchQueryMap[timeSlot])
  const searchSection = searchResult ? `
【最新のネット情報・研究データ（投稿に自然に盛り込んでください）】
${searchResult}
` : ""

  const audience = `
【発信ターゲット】
- 整骨院・整体院・エステ/リラクゼーションサロンの院長・オーナー・施術者
- 個人〜小規模店（1人〜数人）で、集客・予約・事務作業に追われている
- 「AIは気になるけど、何から使えばいいか分からない」
- 予約の電話対応、口コミ返信、SNS投稿、日々の事務に時間を取られている
- 新規集客・リピート・無断キャンセルに悩んでいる
- ITやパソコンが得意ではなく、難しそうで手を出せずにいる
`

  const avoidSection = alreadyGenerated.length > 0 ? `
【以下の投稿と似た内容・表現・構成は絶対に使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}

上記と異なるテーマ・切り口・表現で書いてください。
` : ""

  const ctaOptions = [
    "自院に何から入れればいいか知りたい方は、プロフィールのLINEへ。",
    "AI導入の個別相談は、プロフィールのLINEかDMへどうぞ。",
    "「うちでも使える？」と思った方は、プロフィールのLINEへ。",
    "3ヶ月でAIを仕組み化したい方は、プロフィールのLINEから相談できます。",
  ]

  const commonPromptBase = `あなたは整骨院・整体・サロン向けのAI導入アドバイザーです。
${audience}
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
【AI導入の考え方（テーマに合う場合は自然に盛り込む）】
- まず1つの業務だけ自動化する（予約対応・口コミ返信・SNS投稿など）
- 無料〜低コストのツール（ChatGPT・LINE公式・予約アプリ）から始める
- AIは「施術の時間を増やすため」に事務・集客を任せる道具
- ITが苦手でもコピペや音声入力で使える

【出力形式（必ずこの形式で出力すること）】
MAIN:
（メイン投稿：スクロールを止めるフック1〜2行、60文字以内）

REPLY:
（返信投稿：具体的な手順・ツール名・所要時間・仕組み説明を含む詳細内容、300文字以内）

【MAINのフック型（どれか1つを使う）】
・ナイショ型「ナイショにしてください。〇〇、教えます。」
・秘密型「知らないと損する〇〇の話。」
・共感型「〜に追われている院長へ。」
・比較型「予約が埋まる店・埋まらない店、違いは〇〇でした。」
・意外性型「集客、チラシより〇〇です。」
・疑問型「その事務作業、まだ手作業でやってますか？」

【REPLYのルール】
- 具体的なツール名・所要時間・手順を使う（例：「ChatGPTに3行入れるだけで口コミ返信が30秒」）
- 構成は毎回同じにしない。番号リスト・短い事例・たった1つの提案・比較など、テーマに合う形を選ぶ（毎回①→②→③にしない）
- 「なぜかというと、〜」で仕組みを1文説明する
- 整骨院・整体・サロンの現場の「あるある」なシーン・言葉を積極的に使う
- ITが苦手な人にも分かる平易な言葉で書く（横文字を並べすぎない）
- 最後は読者が思わず反応したくなる一言で終える（例：「予約の電話、1日何件きますか？」）。ただし毎回質問にはせず、2回に1回程度でよい
- 「また明日も頑張ろう」などの締めくくりフレーズは絶対に使わない
- 宣伝・フォロー誘導・「フォローしてください」は書かない（別途コードで付与するため）
- ハッシュタグなし・絵文字なし・見出し記号なし
- MAIN:とREPLY:のラベル以外の説明文・前置き・ラベルは一切不要`

  const timeSlotHint = {
    morning: "開店前・朝の準備の場面を使う。「今日も予約対応に追われそう…」という共感で始めると効果的。",
    lunch: "予約の合間・昼休みなど日中の忙しい場面を使う。すぐ試せる時短ネタを意識する。",
    afternoon: "夕方〜施術の合間の場面を使う。「気づけば事務作業でこんな時間」など共感の言葉を入れる。",
    evening: "閉店後・1日の振り返りの場面で始める。AIで時間を生み、施術や家族の時間に回せるという前向きな締めにする。",
  }

  const fullPrompt = `${commonPromptBase}
【この時間帯のヒント】${timeSlotHint[timeSlot]}`

  const message = await callAnthropicWithRetry(client, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 700,
    messages: [{ role: "user", content: fullPrompt }],
  })

  const text = message.content[0].text.trim()

  const mainMatch = text.match(/MAIN:\n([\s\S]*?)(?=\nREPLY:)/)
  const replyMatch = text.match(/REPLY:\n([\s\S]*)/)

  let main = mainMatch ? mainMatch[1].trim() : text
  let reply = replyMatch ? replyMatch[1].trim() : null

  // 不要ラベル・区切り線を除去する共通フィルター
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

  main = cleanText(main)
  if (reply) reply = cleanText(reply)

  // メイン投稿：200文字でキリよくカット
  if (main.length > 200) {
    const within = main.slice(0, 200)
    const lastPunct = Math.max(within.lastIndexOf("。"), within.lastIndexOf("！"), within.lastIndexOf("？"))
    main = lastPunct > 20 ? main.slice(0, lastPunct + 1).trim() : within.trim()
    console.log(`メイン文字数カット → ${main.length}文字`)
  }

  // 返信投稿：500文字でキリよくカット
  if (reply && reply.length > 500) {
    const within = reply.slice(0, 500)
    const lastPunct = Math.max(within.lastIndexOf("。"), within.lastIndexOf("！"), within.lastIndexOf("？"))
    reply = lastPunct > 20 ? reply.slice(0, lastPunct + 1).trim() : within.trim()
    console.log(`返信文字数カット → ${reply.length}文字`)
  }

  // 1日の通し番号でCTA制御（1日8投稿：4投稿に1回だけ、控えめに返信へ追加）
  const jstHourC = (new Date().getUTCHours() + 9) % 24
  const execOrderC = jstHourC < 10 ? 0 : jstHourC < 16 ? 1 : jstHourC < 21 ? 2 : 3
  const globalIndexC = execOrderC * 2 + topicIndex
  if (globalIndexC % 4 === 3) {
    const cta = ctaOptions[globalIndexC % ctaOptions.length]
    if (reply) {
      reply = reply + "\n\n" + cta
    } else {
      main = main + "\n" + cta
    }
    console.log(`CTA追加: ${cta}`)
  }

  return { main, reply }
}

// 会話誘発型（質問）投稿をランダムに1つ返す（{main, reply}）
function getEngagementPost() {
  try {
    const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_aisupport.json"), "utf-8"))
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
  const totalPosts = 2
  const jstHour = (new Date().getUTCHours() + 9) % 24
  const isMorning = jstHour >= 4 && jstHour < 10
  const alreadyGenerated = []
  let failureCount = 0

  for (let i = 1; i <= totalPosts; i++) {
    console.log(`\n===== 投稿 ${i}/${totalPosts} =====`)

    try {
    let mainText, replyText = null

    if (isMorning) {
      const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_aisupport.json"), "utf-8"))
      const fixedPosts = posts.morning || []
      if (i - 1 < fixedPosts.length) {
        console.log("タイプ: 固定投稿（朝）")
        const post = fixedPosts[i - 1]
        mainText = post.main
        replyText = post.reply || null
      } else {
        console.log("タイプ: AI生成（朝）")
        const generated = await generateMorningPost(i - 1, alreadyGenerated)
        mainText = generated.main
        replyText = generated.reply
      }
    } else if (i === 1) {
      // 各実行の1枠目は会話誘発型（質問）投稿で返信・会話を生む
      const eng = getEngagementPost()
      if (eng) {
        console.log("タイプ: 会話誘発型（質問）投稿")
        mainText = eng.main
        replyText = eng.reply || null
      } else {
        const generated = await getContent(i - 1, alreadyGenerated)
        mainText = generated.main
        replyText = generated.reply
      }
    } else {
      const generated = await getContent(i - 1, alreadyGenerated)
      mainText = generated.main
      replyText = generated.reply
    }

    console.log("\n--- メイン投稿 ---")
    console.log(mainText)
    if (replyText) {
      console.log("\n--- 返信投稿 ---")
      console.log(replyText)
    }
    console.log("----------------\n")

    alreadyGenerated.push(mainText)

    if (process.env.DRY_RUN === "true") {
      console.log(`※ プレビューモード：投稿 ${i} はしていません`)
    } else {
      if (replyText) {
        await postToThreadsWithReply(mainText, replyText)
      } else {
        await postToThreads(mainText)
      }
      console.log(`投稿成功！ ${i}/${totalPosts}`)
    }
    } catch (e) {
      failureCount++
      console.error(`投稿 ${i}/${totalPosts} をスキップ（残りは継続）: ${e.message}`)
    }

    if (i < totalPosts) await new Promise((r) => setTimeout(r, 5000))
  }

  if (failureCount > 0) {
    console.error(`\n⚠ ${failureCount}/${totalPosts} 件の投稿が失敗しました。THREADS_ACCESS_TOKEN_ZUTSUU の失効・レート制限・アカウント制限を確認してください。`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
