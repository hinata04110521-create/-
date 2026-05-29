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
    // 食事と頭痛の関係
    "朝食を抜くと頭痛が起きやすい理由と40代女性への影響",
    "頭痛を防ぐ朝食の選び方・食べてはいけないものと食べるべきもの",
    "朝のコーヒーで頭痛が治る人・悪化する人の違い",
    "マグネシウムを朝に摂ると頭痛が減る理由と含まれる食品",
    "起き抜けの水一杯が頭痛予防になる理由",
  ]

  const topic = morningTopics[topicIndex % morningTopics.length]

  console.log(`朝「${topic}」を検索中...`)
  const searchResult = await searchWeb(`${topic} 40代 50代 女性 頭痛 鉄分 貧血 マグネシウム 食事 改善`)
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

  // 1日8投稿の通し番号でCTAを制御（3投稿に1回）
  const jstHourM = (new Date().getUTCHours() + 9) % 24
  const execOrderM = jstHourM < 10 ? 0 : jstHourM < 16 ? 1 : jstHourM < 21 ? 2 : 3
  const globalIndexM = execOrderM * 5 + topicIndex
  if (globalIndexM % 3 === 2 && reply) {
    const cta = ctaOptions[globalIndexM % ctaOptions.length]
    reply = reply + "\n\n" + cta
    console.log(`朝CTA追加: ${cta}`)
  }

  // 地域フレーズ：3投稿に1回、メインの冒頭に追加
  const locationOptions = [
    "川崎市宮前区エリアで頭痛・肩こりに悩んでいるあなたへ",
    "川崎市宮前区エリアで慢性的な肩こりに長年悩んでいるあなたへ",
    "川崎市宮前区エリアで猫背・姿勢の悪さが気になるあなたへ",
    "川崎市宮前区エリアで頭痛薬に頼り続けているあなたへ",
  ]
  if (topicIndex % 3 === 0) {
    const location = locationOptions[Math.floor(topicIndex / 3) % locationOptions.length]
    main = location + "\n" + main
    console.log(`朝地域フレーズ追加: ${location}`)
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
    // 食事と頭痛の関係
    "チョコレートやチーズを食べると頭痛が出る人の理由",
    "頭痛を引き起こす食べ物TOP5と40代女性が気をつけること",
    "空腹が頭痛を引き起こす仕組みとランチの正しいタイミング",
    "カフェインと頭痛の関係・コーヒーをやめたら頭痛が出た理由",
    "マグネシウム不足が頭痛を悪化させる理由と食べ方",
    "昼食の食べ方を変えるだけで午後の頭痛が減る理由",
    "血糖値の急上昇・急降下が頭痛を引き起こすメカニズム",
    "塩分と頭痛の意外な関係・外食が多い人は要注意",
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
    // 食事と頭痛の関係
    "夕食の食べ方が翌朝の頭痛を決めている理由",
    "頭痛を防ぐ夕食の選び方・40代女性が意識すること",
    "アルコールが頭痛を引き起こすメカニズムと対策",
    "夕方の甘いものへの欲求が頭痛のサインである理由",
    "頭痛持ちが夕食で摂るべき栄養素（マグネシウム・B2・鉄）",
    "食事の時間が不規則な人ほど頭痛が出やすい理由",
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
    // 食事と頭痛の関係
    "夜の食事が翌朝の頭痛を左右する理由と食べ方のコツ",
    "頭痛を減らすために今夜から変えられる食習慣",
    "寝る前のカフェインが頭痛・睡眠を悪化させる仕組み",
    "ビタミンB2が片頭痛予防に効く理由と含まれる食品",
    "水分不足が翌朝の頭痛を引き起こす理由と正しい水の飲み方",
    "食事と頭痛の関係を知ると、薬に頼らなくて済む話",
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
    morning: `${currentTopic} 40代 50代 女性 頭痛 原因 改善 朝食 マグネシウム 鉄分`,
    lunch: `${currentTopic} 緊張型頭痛 片頭痛 姿勢 デスクワーク 食事 血糖値 カフェイン 予防`,
    afternoon: `${currentTopic} 肩こり 頭痛 姿勢 食事 鉄分 貧血 改善 セルフケア`,
    evening: `${currentTopic} 頭痛 肩こり 食事 マグネシウム 水分 睡眠 自律神経 更年期`,
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

  const followOptions = [
    "他にも頭痛・肩こりの情報を毎日発信しています。参考になったらフォローしてお待ちください！",
    "頭痛・姿勢に関する情報を毎日発信中。フォローしておくと役立つ情報が届きます。",
    "他にも薬に頼らない頭痛改善の情報を発信しています。ぜひフォローしてください！",
  ]

  const commonPromptBase = `あなたは頭痛・肩こり・猫背改善の専門家（整骨院の先生）です。
${audience}
${styleGuide}
今回のテーマ：「${currentTopic}」
${searchSection}
${avoidSection}
【食事と頭痛の関係（テーマに合う場合は自然に盛り込む）】
- 朝食抜き・空腹 → 血糖値低下 → 頭痛
- カフェイン飲みすぎ・急にやめる → 頭痛
- マグネシウム不足・鉄分不足・水分不足 → 頭痛悪化
- 血糖値の急上昇急降下 → 昼食後の頭痛

【出力形式（必ずこの形式で出力すること）】
MAIN:
（メイン投稿：スクロールを止めるフック1〜2行、60文字以内）

REPLY:
（返信投稿：具体的な手順・数字・仕組み説明を含む詳細内容、300文字以内）

【MAINのフック型（どれか1つを使う）】
・ナイショ型「ナイショにしてください。〇〇、教えます。」
・秘密型「知らないと損する〇〇の話。」
・共感型「〜なのに治らない方へ。」
・比較型「頭痛が出る人・出ない人、違いは〇〇でした。」
・意外性型「肩こりの原因、肩じゃないです。」
・疑問型「毎朝頭が重いの、年齢のせいじゃないかも。」

【REPLYのルール】
- 具体的な数字・秒数・センチなどを使う（例：「耳を3センチ引っ張って5秒キープ」）
- 手順がある場合は番号で書く（例：①→②→③）
- 「なぜかというと、〜」で仕組みを1文説明する
- 40代・50代女性の「あるある」なシーン・言葉を積極的に使う
- 「また明日も頑張ろう」などの締めくくりフレーズは絶対に使わない
- ハッシュタグなし・絵文字なし・見出し記号なし
- MAIN:とREPLY:のラベル以外の説明文・前置き・ラベルは一切不要`

  const timeSlotHint = {
    morning: "朝起きたときの頭痛・首こわばりのリアルな場面を使う。「また今日も…」という朝の共感で始めると効果的。",
    lunch: "デスクワーク・昼休み・家事の合間など昼のリアルな場面を使う。",
    afternoon: "仕事終わり・帰宅・夕食準備など夕方の場面を使う。「ずっと我慢してきた方へ」など共感の言葉を入れる。",
    evening: "「今日も頭痛でつらかった方へ」など夜の共感で始める。希望・変われるという前向きな締めにする。",
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

  // 1日の通し番号でCTA制御（3投稿に1回、返信に追加）
  const jstHourC = (new Date().getUTCHours() + 9) % 24
  const execOrderC = jstHourC < 10 ? 0 : jstHourC < 16 ? 1 : jstHourC < 21 ? 2 : 3
  const globalIndexC = execOrderC * 5 + topicIndex
  if (globalIndexC % 3 === 2) {
    const cta = ctaOptions[globalIndexC % ctaOptions.length]
    if (reply) {
      reply = reply + "\n\n" + cta
    } else {
      main = main + "\n" + cta
    }
    console.log(`CTA追加: ${cta}`)
  }

  // フォロー訴求：2投稿に1回、返信の末尾に追加
  if (reply && globalIndexC % 2 === 0) {
    const follow = followOptions[globalIndexC % followOptions.length]
    reply = reply + "\n\n" + follow
    console.log(`フォロー訴求追加: ${follow}`)
  }

  // 地域フレーズ：3投稿に1回、メインの冒頭に追加
  const locationOptions = [
    "川崎市宮前区エリアで頭痛・肩こりに悩んでいるあなたへ",
    "川崎市宮前区エリアで慢性的な肩こりに長年悩んでいるあなたへ",
    "川崎市宮前区エリアで猫背・姿勢の悪さが気になるあなたへ",
    "川崎市宮前区エリアで頭痛薬に頼り続けているあなたへ",
  ]
  if (topicIndex % 3 === 0) {
    const location = locationOptions[Math.floor(topicIndex / 3) % locationOptions.length]
    main = location + "\n" + main
    console.log(`地域フレーズ追加: ${location}`)
  }

  return { main, reply }
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
  const totalPosts = 5
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

    if (i < totalPosts) await new Promise((r) => setTimeout(r, 5000))
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
