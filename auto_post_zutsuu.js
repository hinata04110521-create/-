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
    "朝起きた時の頭痛・首のこわばりを和らげる習慣",
    "デスクワーク前にやるべき肩こり予防のストレッチ",
    "猫背が頭痛を引き起こすメカニズムと朝の対策",
    "朝の姿勢チェックで一日の頭痛リスクを下げる方法",
    "ストレートネックの人が朝にやるべき首のケア",
    "睡眠中の姿勢が翌朝の体調を決める理由",
    "頭痛持ちが朝食で意識すべき栄養素",
    "肩こりを悪化させる朝の悪い習慣とその改善法",
    "首・肩のコリをほぐす朝の簡単セルフケア",
    "猫背を改善するための朝のルーティン3選",
    "慢性的な頭痛の根本原因を朝から断つ方法",
    "目の疲れと頭痛の関係・朝できるケア",
    "血流を改善して頭痛を防ぐ朝の動き",
    "正しい枕選びで朝の頭痛をなくす方法",
    "自律神経と頭痛の関係・朝の過ごし方で変わる",
  ]

  const topic = morningTopics[topicIndex % morningTopics.length]

  console.log(`朝「${topic}」を検索中...`)
  const searchResult = await searchWeb(`${topic} 頭痛 肩こり 猫背 姿勢 改善 整体 最新`)
  const searchSection = searchResult ? `
【最新のネット情報（参考にしてください）】
${searchResult}
` : ""

  const avoidSection = alreadyGenerated.length > 0 ? `
【以下の投稿と似た内容・表現・構成は絶対に使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}

上記と異なるテーマ・切り口・表現で書いてください。
` : ""

  const audience = `
【発信ターゲット】
- 慢性的な頭痛・肩こりに悩む30〜50代
- デスクワークが多く、姿勢が悪いと自覚している
- 湿布や市販薬でごまかし続けている
- 「整体に行っても一時的にしか良くならない」と感じている
- 猫背・ストレートネックを改善したいと思っている
- 頭痛・肩こりが仕事や日常生活に支障をきたしている
`

  const ctaOptions = [
    "あなたの頭痛・肩こりの原因を知りたい方は、プロフィールのLINEへ。",
    "個別に相談したい方は、プロフィールのLINEかDMへどうぞ。",
    "根本から改善したい方は、プロフィールのLINEへ。",
    "3ヶ月で姿勢を変えたい方は、プロフィールのLINEから相談できます。",
  ]

  const prompt = `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}

朝6時のThreads投稿を以下の形式で作成してください。
${searchSection}
【メイン投稿のルール】
- 読者の悩みに共感しつつ、「続きを読みたい」と思わせる1〜2行
- 基本は40〜60文字でシンプルに。内容によって長くなる場合は100文字まで許容する

【返信投稿のルール】
- 構成：①なぜうまくいかないか（根本原因）→ ②今日からできる行動リスト → ③締めの一言
- 行動リストは「① 〇〇 → 〇〇（理由）」の形式で3〜5項目（500文字以内）
- ハッシュタグなし・絵文字なし
- 「また明日も頑張ろう」「一緒に頑張ろう」などの締めくくりフレーズは絶対に使わない

今回のテーマ：「${topic}」
${avoidSection}

以下の形式で出力してください（MAIN:とREPLY:の文字はそのまま残してください）：
MAIN:
（メイン投稿の内容）

REPLY:
（返信投稿の内容）`

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  })

  const text = message.content[0].text.trim()

  const mainMatch = text.match(/MAIN:\n([\s\S]*?)(?=\nREPLY:)/)
  const replyMatch = text.match(/REPLY:\n([\s\S]*)/)

  const main = mainMatch ? mainMatch[1].trim() : text
  let reply = replyMatch ? replyMatch[1].trim() : null

  if (topicIndex % 3 === 2 && reply) {
    const cta = ctaOptions[topicIndex % ctaOptions.length]
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

  const localPosts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_zutsuu.json"), "utf-8"))
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
- 具体的な症状・部位・時間帯を使う
- 最後に一言アクションを促す
- ハッシュタグなし・絵文字なし
- 断定的で簡潔な言い切り表現
` : ""

  const lunchTopics = [
    "デスクワーク中の姿勢が午後の頭痛を引き起こす理由",
    "昼休みにできる肩こりリセット法",
    "猫背の人がランチ後に頭痛になりやすい理由",
    "頭痛持ちが昼食で避けるべき食べ物",
    "首こりを悪化させるスマホの使い方",
    "昼のちょっとしたストレッチで午後の集中力が変わる",
    "目の疲れが頭痛につながる仕組みと対策",
    "肩こりを根本から治すために昼に意識すること",
    "姿勢改善で頭痛が減った人がやっていること",
    "猫背・巻き肩を直す昼休みの習慣",
    "頭痛薬に頼り続けるリスクと根本改善の考え方",
    "ストレートネックが招く慢性頭痛のメカニズム",
    "デスクワーカーが知るべき首・肩の正しいケア",
    "頭痛を繰り返す人に共通する姿勢の特徴",
    "昼の血流改善で午後の頭痛を防ぐ方法",
  ]

  const afternoonTopics = [
    "夕方に頭痛が悪化する本当の理由と対策",
    "仕事終わりの肩こりを帰宅前にリセットする方法",
    "猫背が慢性化する前に今日できること",
    "首・肩のこりが夜の頭痛を引き起こす仕組み",
    "夕方のストレッチで翌朝の体が変わる理由",
    "目の疲れを夕方にリセットして頭痛を防ぐ",
    "肩こりが取れない人がやっていない根本ケア",
    "姿勢を直すだけで頭痛が減る理由",
    "巻き肩・猫背を今日から改善するための第一歩",
    "慢性的な頭痛を整体で改善できる人・できない人の違い",
    "夕方の首・肩のセルフマッサージで頭痛予防",
    "ストレスと肩こりの深い関係・夕方のリセット法",
    "頭痛持ちが夕食前にやるべきこと",
    "猫背が内臓にも影響する意外な理由",
    "姿勢改善プログラムで変わった人の共通点",
  ]

  const eveningTopics = [
    "今夜のセルフケアで明日の頭痛が変わる",
    "寝る前にやると肩こりが楽になるストレッチ",
    "慢性頭痛を繰り返す人に伝えたいこと",
    "猫背を放置し続けるとどうなるか",
    "夜の姿勢チェックで翌朝の体が変わる理由",
    "頭痛薬でごまかし続けることのリスク",
    "今日首・肩がつらかった人へのセルフケア",
    "睡眠の質と頭痛の深い関係",
    "肩こりを根本から治すために夜できること",
    "姿勢が悪いまま放置するとどうなるか・正直な話",
    "整体に行っても治らない頭痛の本当の原因",
    "夜のスマホが翌朝の頭痛を作る理由",
    "ストレートネックの人が夜にやるべきケア",
    "頭痛・肩こりを手放すための最初の一歩",
    "今夜から姿勢を意識するだけで体が変わり始める理由",
  ]

  const morningTopics = [
    "朝起きた時の頭痛・首のこわばりを和らげる習慣",
    "デスクワーク前にやるべき肩こり予防のストレッチ",
    "猫背が頭痛を引き起こすメカニズムと朝の対策",
    "朝の姿勢チェックで一日の頭痛リスクを下げる方法",
    "ストレートネックの人が朝にやるべき首のケア",
    "睡眠中の姿勢が翌朝の体調を決める理由",
    "頭痛持ちが朝食で意識すべき栄養素",
    "肩こりを悪化させる朝の悪い習慣とその改善法",
    "首・肩のコリをほぐす朝の簡単セルフケア",
    "猫背を改善するための朝のルーティン3選",
    "慢性的な頭痛の根本原因を朝から断つ方法",
    "目の疲れと頭痛の関係・朝できるケア",
    "血流を改善して頭痛を防ぐ朝の動き",
    "正しい枕選びで朝の頭痛をなくす方法",
    "自律神経と頭痛の関係・朝の過ごし方で変わる",
  ]

  const topicMap = {
    morning: morningTopics[topicIndex % morningTopics.length],
    lunch: lunchTopics[topicIndex % lunchTopics.length],
    afternoon: afternoonTopics[topicIndex % afternoonTopics.length],
    evening: eveningTopics[topicIndex % eveningTopics.length],
  }
  const currentTopic = topicMap[timeSlot]

  console.log(`「${currentTopic}」を検索中...`)
  const searchQuery = `${currentTopic} 頭痛 肩こり 猫背 姿勢 改善 整体 最新`
  const searchResult = await searchWeb(searchQuery)
  const searchSection = searchResult ? `
【最新のネット情報（参考にしてください）】
${searchResult}
` : ""

  const audience = `
【発信ターゲット】
- 慢性的な頭痛・肩こりに悩む30〜50代
- デスクワークが多く、姿勢が悪いと自覚している
- 湿布や市販薬でごまかし続けている
- 「整体に行っても一時的にしか良くならない」と感じている
- 猫背・ストレートネックを改善したいと思っている
- 頭痛・肩こりが仕事や日常生活に支障をきたしている
`

  const avoidSection = alreadyGenerated.length > 0 ? `
【以下の投稿と似た内容・表現・構成は絶対に使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}

上記と異なるテーマ・切り口・表現で書いてください。
` : ""

  const ctaOptions = [
    "あなたの頭痛・肩こりの原因を知りたい方は、プロフィールのLINEへ。",
    "個別に相談したい方は、プロフィールのLINEかDMへどうぞ。",
    "根本から改善したい方は、プロフィールのLINEへ。",
    "3ヶ月で姿勢を変えたい方は、プロフィールのLINEから相談できます。",
  ]

  const commonConditions = `
- 全体を3行以内・100文字以内（改行含む）を目標にすること
- 1行目だけで読者のスクロールを止めること（比較型・意外性型・疑問型のどれかを必ず使う）
- 2行目：根本原因を一言で（短く断言する）
- 3行目：今日すぐできる行動を一言で
- 「また明日も頑張ろう」「また明日」「一緒に頑張ろう」などの締めくくりフレーズは絶対に使わない`

  const prompts = {
    morning: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた「朝6時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【絶対にやってはいけないこと】
- 「朝6時の投稿」「朝の投稿」などの時間帯ラベルを本文に入れない
- 「別案」「案1」「案2」「パターン」などの選択肢ラベルを入れない
- 投稿本文だけをそのまま出力する（説明文・前置き・ラベル一切不要）`,

    lunch: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた「昼12時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【昼投稿の特別ルール】
- 最初の1行でスクロールを止めること（これが最重要）
- 使える型：①「頭痛が出る人・出ない人の違いは〇〇」②「〇〇してるなら今すぐやめて」③「これ知らずに過ごすと損です」
- デスクワーク・昼休みなど具体的なシーンに落とし込む
【絶対にやってはいけないこと】
- 「昼12時の投稿」などの時間帯ラベルを本文に入れない
- 「別案」「案1」「案2」などのラベルを入れない
- 投稿本文だけをそのまま出力する`,

    afternoon: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた「夕方17時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【夕方投稿の特別ルール】
- 最初の1行でスクロールを止めること（これが最重要）
- 使える型：①「夕方の〇〇が翌日の頭痛を決める」②「〇〇してるなら今すぐやめて」③「夕方の肩こりの正体は〇〇だった」
- 仕事終わり・帰宅など夕方の具体的なシーンに落とし込む
【絶対にやってはいけないこと】
- 「夕方17時の投稿」などの時間帯ラベルを本文に入れない
- 「別案」「案1」「案2」などのラベルを入れない
- 投稿本文だけをそのまま出力する`,

    evening: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた「夜21時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【夜投稿の特別ルール】
- 最初の1行でスクロールを止めること（これが最重要）
- 使える型：①「今夜〇〇するだけで明日の頭痛が変わる」②「夜の〇〇をやめると肩こりが消える」③「寝る前に〇〇してる人は治らない」
【絶対にやってはいけないこと】
- 「夜21時の投稿」などの時間帯ラベルを本文に絶対に入れない
- 「別案」「案1」「案2」などのラベルを入れない
- 投稿本文だけをそのまま出力する`,
  }

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{ role: "user", content: prompts[timeSlot] }],
  })

  let result = message.content[0].text.trim()

  // AIが誤って入れた時間帯ラベル・別案ラベルを除去
  result = result
    .replace(/^#+\s*(夜21時|夜9時|夜の|21時)[^\n]*/m, "")
    .replace(/^#+\s*(朝6時|朝の|6時)[^\n]*/m, "")
    .replace(/^#+\s*(昼12時|昼の|12時)[^\n]*/m, "")
    .replace(/^#+\s*(夕方17時|夕方の|17時)[^\n]*/m, "")
    .replace(/^#+\s*(別案|案\d+|パターン)[^\n]*/m, "")
    .replace(/^(夜21時の投稿[：:・]?|夜の投稿[：:・]?)/m, "")
    .replace(/^(朝6時の投稿[：:・]?|朝の投稿[：:・]?)/m, "")
    .replace(/^(昼12時の投稿[：:・]?|昼の投稿[：:・]?)/m, "")
    .replace(/^(夕方17時の投稿[：:・]?|夕方の投稿[：:・]?)/m, "")
    .replace(/^(別案[：:・]?|案\d+[：:・]?|パターン\d+[：:・]?)/m, "")
    .trim()

  // 120文字超えたら3行目までで強制カット
  if (result.length > 120) {
    const lines = result.split("\n").filter(l => l.trim() !== "")
    result = lines.slice(0, 3).join("\n").trim()
    if (result.length > 120) {
      const within120 = result.slice(0, 120)
      const punctMatch = within120.match(/^([\s\S]*[。！？…])/)
      if (punctMatch && punctMatch[1].length > 20) {
        result = punctMatch[1].trim()
      } else {
        const lastNewline = within120.lastIndexOf("\n")
        if (lastNewline > 20) {
          result = result.slice(0, lastNewline).trim()
        } else {
          result = lines.slice(0, 2).join("\n").trim()
        }
      }
    }
    console.log(`文字数カット → ${result.length}文字`)
  }

  // 3投稿に1回、CTAを末尾に追加
  if (topicIndex % 3 === 2) {
    const cta = ctaOptions[topicIndex % ctaOptions.length]
    result = result + "\n" + cta
    console.log(`CTA追加: ${cta}`)
  }

  return result
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
  const totalPosts = 1
  const jstHour = (new Date().getUTCHours() + 9) % 24
  const isMorning = jstHour >= 4 && jstHour < 10
  const alreadyGenerated = []

  for (let i = 1; i <= totalPosts; i++) {
    console.log(`\n===== 投稿 ${i}/${totalPosts} =====`)

    let mainText, replyText = null

    if (isMorning) {
      const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts_zutsuu.json"), "utf-8"))
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
    } else {
      mainText = await getContent(i - 1, alreadyGenerated)
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

    if (i < totalPosts) await new Promise((r) => setTimeout(r, 5000))
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
