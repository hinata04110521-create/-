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
    "頭痛持ちが朝食で意識すべき栄養素（マグネシウム・鉄分・水分）",
    "肩こりを悪化させる朝の悪い習慣とその改善法",
    "首・肩のコリをほぐす朝の簡単セルフケア",
    "更年期女性に多い朝の頭痛の原因と対策",
    "貧血が原因の頭痛・めまい・肩こりを朝から改善する方法",
    "緊張型頭痛と片頭痛の違い・朝に判断する方法",
    "血流を改善して頭痛を防ぐ朝の動き",
    "正しい枕選びで朝の頭痛をなくす方法",
    "自律神経と頭痛の関係・朝の過ごし方で変わる",
    "40代から増える片頭痛・ホルモン変化との関係",
    "鉄分不足が40代女性の頭痛・疲労感・肩こりを悪化させる理由",
    "起き上がるときの姿勢が一日の首こりを決める理由",
    "頭が重い・ぼんやりする朝の不調は首と鉄分不足が原因かも",
    "朝の深呼吸が頭痛予防になる理由と正しいやり方",
  ]

  const topic = morningTopics[topicIndex % morningTopics.length]

  console.log(`朝「${topic}」を検索中...`)
  const searchResult = await searchWeb(`${topic} 40代 50代 女性 頭痛 鉄分 貧血 改善`)
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
- 40代・50代の女性
- 慢性的な頭痛・肩こり・猫背に長年悩んでいる
- 更年期以降、症状が悪化してきたと感じている
- 湿布や市販薬でごまかし続けている
- 「整体に行っても一時的にしか良くならない」と感じている
- 頭痛・肩こりが仕事や家事・日常生活に支障をきたしている
- 姿勢の悪さが不調の原因だとうすうす気づいている
`

  const ctaOptions = [
    "あなたの頭痛・肩こりの原因を知りたい方は、プロフィールのLINEへ。",
    "個別に相談したい方は、プロフィールのLINEかDMへどうぞ。",
    "根本から改善したい方は、プロフィールのLINEへ。",
    "3ヶ月で姿勢を変えたい方は、プロフィールのLINEから相談できます。",
  ]

  const prompt = `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}

朝のThreads投稿を以下の形式で作成してください。
${searchSection}
【投稿の目的】
フォロワー0からスタートするアカウントです。「わかる」「これ私だ」と思わせる共感で保存・拡散され、かつ専門家への信頼感で問い合わせにつながる投稿を作ってください。

【メイン投稿のルール】
- 40代・50代女性が「これ、まさに私だ」と感じる共感フックで始める
- 「更年期だと思ってたら」「市販薬を飲み続けて」「整体に行っても翌日戻る」などリアルな言葉を使う
- 基本は40〜60文字。内容によって100文字まで許容する

【返信投稿のルール】
- 構成：①共感（「〜でずっと悩んでいる方、多いです」）→ ②根本原因の説明 → ③今日からできる行動リスト → ④希望の一言
- 行動リストは「① 〇〇 → 〇〇（理由）」の形式で3〜5項目（500文字以内）
- 読んだ人が「この先生に相談したい」と思えるような、温かくも的確なトーンで
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
    "昼休みにできる肩こりリセット法（5分でOK）",
    "猫背の人がランチ後に頭痛になりやすい理由",
    "頭痛持ちが昼食で避けるべき食べ物・飲み物",
    "首こりを悪化させるスマホの使い方と正しい姿勢",
    "昼のストレッチで午後の集中力と頭痛が変わる理由",
    "目の疲れが頭痛につながる仕組みとランチ後のケア",
    "緊張型頭痛を繰り返す人の昼の過ごし方の共通点",
    "姿勢を直すだけで頭痛が減った人がやっていること",
    "猫背・巻き肩を直す昼休みの習慣3選",
    "頭痛薬に頼り続けると起きる「薬物乱用頭痛」のリスク",
    "ストレートネックが招く慢性頭痛のメカニズム",
    "デスクワーカーの9割がやっている首を痛める習慣",
    "40代女性に多い頭痛の種類とランチで気をつけること",
    "昼の水分不足が夕方の頭痛を引き起こす理由",
    "片頭痛のトリガーになる昼食の食べ方・食べ物",
    "肩甲骨を動かすだけで肩こり頭痛が楽になる理由",
    "貧血気味の人が昼食で意識すべき鉄分の摂り方",
    "更年期と昼間の頭痛の関係・ホルモンと頭痛",
    "鉄分不足・貧血が肩こりや頭痛を悪化させる理由",
  ]

  const afternoonTopics = [
    "夕方に頭痛が悪化する本当の理由と今日できる対策",
    "仕事終わりの肩こりを帰宅前にリセットする方法",
    "猫背が慢性化する前に今日できること",
    "首・肩のこりが夜の頭痛を引き起こす仕組み",
    "夕方のストレッチで翌朝の体が変わる理由",
    "目の疲れを夕方にリセットして頭痛を防ぐセルフケア",
    "肩こりが取れない人がやっていない根本ケア",
    "姿勢を直すだけで頭痛が減る理由（筋肉と血流の話）",
    "巻き肩・猫背を今日から改善するための第一歩",
    "整体に行っても治らない頭痛と行けば治る頭痛の違い",
    "夕方の首・肩のセルフマッサージで頭痛予防",
    "ストレスと肩こりの深い関係・コルチゾールと筋緊張",
    "頭痛持ちが夕食前にやるべきこと",
    "猫背が呼吸を浅くして頭痛を悪化させる理由",
    "40代・50代女性の夕方の不調は更年期だけじゃない",
    "長時間同じ姿勢でいると起こる体への影響",
    "肩こりをほぐすより先にやるべきこと",
    "貧血・鉄分不足が夕方の疲労感・頭痛を引き起こす理由",
    "週末に頭痛が出やすい人が知るべき「休日頭痛」の正体",
    "夕方に貧血症状（ふらつき・頭痛）が出やすい理由と対策",
  ]

  const eveningTopics = [
    "今夜のセルフケアで明日の頭痛が変わる",
    "寝る前にやると肩こりが楽になるストレッチ",
    "慢性頭痛を繰り返す人に整骨院の先生として伝えたいこと",
    "猫背を放置し続けると10年後どうなるか",
    "夜の姿勢チェックで翌朝の体が変わる理由",
    "頭痛薬でごまかし続けることの本当のリスク",
    "今日首・肩がつらかった人へのセルフケア",
    "睡眠の質と頭痛の深い関係（成長ホルモンと回復）",
    "肩こりを根本から治すために夜できること",
    "姿勢が悪いまま放置するとどうなるか・正直な話",
    "夜のスマホ姿勢が翌朝の頭痛を作る理由",
    "ストレートネックの人が夜にやるべきケア",
    "頭痛・肩こりを手放すための最初の一歩",
    "更年期の夜間頭痛・睡眠障害との関係",
    "寝るときの枕の高さが頭痛に与える影響",
    "夜にマグネシウムを摂ると頭痛が減る理由",
    "「疲れると頭痛」は姿勢と鉄分不足が原因かもしれない理由",
    "今夜首を温めると翌朝が変わる理由（血流と神経）",
    "夜に鉄分を摂ると翌朝の頭痛・倦怠感が変わる理由",
    "貧血改善で頭痛・肩こりが楽になった人がやっていること",
  ]

  const morningTopics = [
    "朝起きた時の頭痛・首のこわばりを和らげる習慣",
    "デスクワーク前にやるべき肩こり予防のストレッチ",
    "猫背が頭痛を引き起こすメカニズムと朝の対策",
    "朝の姿勢チェックで一日の頭痛リスクを下げる方法",
    "ストレートネックの人が朝にやるべき首のケア",
    "睡眠中の姿勢が翌朝の体調を決める理由",
    "頭痛持ちが朝食で意識すべき栄養素（マグネシウム・鉄分・水分）",
    "肩こりを悪化させる朝の悪い習慣とその改善法",
    "首・肩のコリをほぐす朝の簡単セルフケア",
    "更年期女性に多い朝の頭痛の原因と対策",
    "慢性的な頭痛の根本原因を朝から断つ方法",
    "緊張型頭痛と片頭痛の違い・朝に判断する方法",
    "血流を改善して頭痛を防ぐ朝の動き",
    "正しい枕選びで朝の頭痛をなくす方法",
    "自律神経と頭痛の関係・朝の過ごし方で変わる",
    "40代から増える片頭痛・ホルモン変化との関係",
    "朝のコーヒーが頭痛に与える影響（良い面・悪い面）",
    "起き上がるときの姿勢が一日の首こりを決める理由",
    "頭が重い・ぼんやりする朝の不調は首が原因かも",
    "朝の深呼吸が頭痛予防になる理由と正しいやり方",
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
    morning: `${currentTopic} 40代 50代 女性 頭痛 原因 改善 研究`,
    lunch: `${currentTopic} 緊張型頭痛 片頭痛 姿勢 デスクワーク 予防 対策`,
    afternoon: `${currentTopic} 肩こり 頭痛 姿勢 改善 整骨院 セルフケア`,
    evening: `${currentTopic} 頭痛 肩こり 慢性 改善 睡眠 自律神経 更年期`,
  }

  console.log(`「${currentTopic}」を検索中...`)
  const searchResult = await searchWeb(searchQueryMap[timeSlot])
  const searchSection = searchResult ? `
【最新のネット情報・研究データ（投稿に自然に盛り込んでください）】
${searchResult}
` : ""

  const audience = `
【発信ターゲット】
- 40代・50代の女性
- 慢性的な頭痛・肩こり・猫背に長年悩んでいる
- 更年期以降、症状が悪化してきたと感じている
- 湿布や市販薬でごまかし続けている
- 「整体に行っても一時的にしか良くならない」と感じている
- 頭痛・肩こりが仕事や家事・日常生活に支障をきたしている
- 姿勢の悪さが不調の原因だとうすうす気づいている
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
【投稿の2つの目的を同時に達成すること】
① フォロワー獲得：「わかる」「これ私だ」と思わせる共感で保存・シェアされる投稿
② 問い合わせ増加：専門家としての信頼感を自然に滲ませ、プロフィールへ誘導する

【構成ルール】
- 基本は100文字を目安にすること。内容によって100文字を超えてもよいが、必ず文章がキリよく終わる場所で止めること（文の途中で終わらない）
- 1行目：スクロールを止めるフック。以下のどれかを使う
  ・共感型「〜なのに治らないって、つらいですよね」
  ・あるある型「湿布を貼り続けて10年…それ、根本が違います」
  ・比較型「頭痛が出る人・出ない人、違いは〇〇だった」
  ・意外性型「肩こりの原因は肩じゃない」
  ・疑問型「毎朝頭が重いのは、年齢のせいじゃないかもしれない」
- 2行目：根本原因を一言で（姿勢・鉄分不足・貧血・血流・自律神経など具体的に）
- 3行目：今日すぐできる行動か、希望を感じさせる一言
- 40代・50代女性の「あるある」なシーン・言葉を積極的に使う
  例：「更年期だと思ってたら」「市販薬を飲み続けて」「整体に行っても翌日戻る」「家事の合間に」
- 「また明日も頑張ろう」「また明日」「一緒に頑張ろう」などの締めくくりフレーズは絶対に使わない`

  const prompts = {
    morning: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた朝の投稿を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【朝投稿の特別ルール】
- 「朝起きたら頭が重い」「また今日も…と思いながら起きた方へ」など、朝のリアルな共感で始める
- 40代・50代女性が「これ、まさに私の話だ」と感じる具体的な言葉を使う
【絶対にやってはいけないこと】
- 「朝6時の投稿」「朝の投稿」などの時間帯ラベルを本文に入れない
- 「別案」「案1」「案2」「パターン」などの選択肢ラベルを入れない
- 投稿本文だけをそのまま出力する（説明文・前置き・ラベル一切不要）`,

    lunch: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた昼の投稿を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【昼投稿の特別ルール】
- 最初の1行でスクロールを止めること（これが最重要）
- 40代・50代女性の昼のリアルな場面を使う（デスクワーク・昼休み・家事の合間など）
- 使える型：①「頭痛が出る人・出ない人、違いは〇〇だった」②「〇〇し続けてきた方へ」③「これ知らずにいると損です」
- 共感ファースト→原因→行動の流れで書く
【絶対にやってはいけないこと】
- 「昼12時の投稿」などの時間帯ラベルを本文に入れない
- 「別案」「案1」「案2」などのラベルを入れない
- 投稿本文だけをそのまま出力する`,

    afternoon: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた夕方の投稿を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【夕方投稿の特別ルール】
- 最初の1行でスクロールを止めること（これが最重要）
- 仕事終わり・帰宅・夕食準備など40代・50代女性の夕方のリアルな場面を使う
- 使える型：①「夕方になると頭痛が出る…それ、〇〇のせいです」②「〇〇してきた方、それが原因かもしれません」③「夕方の肩こりの正体は〇〇だった」
- 「つらかったですよね」「ずっと我慢してきた方へ」など共感の言葉を入れる
【絶対にやってはいけないこと】
- 「夕方17時の投稿」などの時間帯ラベルを本文に入れない
- 「別案」「案1」「案2」などのラベルを入れない
- 投稿本文だけをそのまま出力する`,

    evening: `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
このターゲットに向けた夜の投稿を作成してください。
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
【夜投稿の特別ルール】
- 最初の1行でスクロールを止めること（これが最重要）
- 使える型：①「今夜〇〇するだけで明日の頭痛が変わる」②「ずっと〇〇で悩んできた方へ」③「寝る前に〇〇してる人は治らない」
- 「今日も頭痛で一日つらかった方」「ずっとこの痛みと付き合ってきた方」など共感の言葉で始めると効果的
- 夜は特に「希望」「変われる」という前向きなメッセージで締める（フレーズは避けつつ）
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

  // 500文字超えたらキリのいいところで強制カット（Threads上限対策）
  if (result.length > 500) {
    const within500 = result.slice(0, 500)
    const punctMatch = within500.match(/^([\s\S]*[。！？…])/)
    if (punctMatch && punctMatch[1].length > 20) {
      result = punctMatch[1].trim()
    } else {
      const lastNewline = within500.lastIndexOf("\n")
      result = lastNewline > 20 ? result.slice(0, lastNewline).trim() : within500.trim()
    }
    console.log(`文字数カット（上限超過）→ ${result.length}文字`)
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
