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

  // Threads APIの500文字制限を超えた場合は自動カット
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

  // メイン投稿
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

  // 返信投稿
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
    "40・50代女性がなかなか痩せない本当の理由",
    "食べる量を減らしても痩せない人に足りないもの",
    "ダイエット中に絶対やってはいけない食事の習慣",
    "たんぱく質を毎食摂ると体が変わる理由",
    "停滞期を乗り越えるために知っておくべきこと",
    "食べる順番を変えるだけで痩せやすくなる理由",
    "腸内環境を整えるとダイエットが加速する理由",
    "体重より体脂肪を意識すべき理由",
    "水を飲むだけで痩せやすくなる理由と正しい飲み方",
    "朝の空腹時血糖値を下げる朝食の選び方",
    "高血圧の人が朝に意識すべき食べ方",
    "コレステロールを朝食から改善する方法",
    "糖尿病リスクを下げる朝のルーティン",
    "脂肪肝を改善しながら痩せる朝ごはん",
  ]

  // topicIndexで順番にトピックを選ぶ（重複しない）
  const topic = morningTopics[topicIndex % morningTopics.length]

  // 既に生成した投稿を「避けるべき例」として追加
  const avoidSection = alreadyGenerated.length > 0 ? `
【以下の投稿と似た内容・表現・構成は絶対に使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}

上記と異なるテーマ・切り口・表現で書いてください。
` : ""

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

  const prompt = `あなたは40・50代女性専門のダイエットサポーターです。
${audience}

朝6時のThreads投稿を以下の形式で作成してください。

【メイン投稿のルール】
- 「３ヶ月でー５キロ痩せたい40代・50代女性は〇〇でこれを意識してください」のような形式
- 1〜2行でシンプルに
- 読者が「続きを読みたい」と思う一言

【返信投稿のルール】
- メイン投稿の具体的な内容を番号リストで
- ① 〇〇 → 〇〇 の形式で3〜5項目
- ハッシュタグなし・絵文字なし
- 「また明日も頑張ろう」「また明日」「明日も頑張ろう」「一緒に頑張ろう」などの締めくくりフレーズは絶対に使わない

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
  const reply = replyMatch ? replyMatch[1].trim() : null

  return { main, reply }
}

// Claude API でテキスト生成
async function generateWithClaude(timeSlot, topicIndex = 0, alreadyGenerated = []) {
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

  const afternoonTopics = [
    "夕方5時のおやつの取り方でダイエットの明暗が分かれる理由",
    "夕食前の間食を上手に取ると夜の食べすぎが防げる",
    "17時に食べていいおやつ・食べてはいけないおやつ",
    "空腹のまま夕食を迎えると太る理由と対策",
    "夕方の血糖値低下が甘いものへの欲求を生む仕組み",
    "たんぱく質の間食で夜の食欲をコントロールする方法",
    "仕事帰りの空腹を賢く乗り越える方法",
    "夕食まで時間がある時の正しい過ごし方",
    "40・50代女性の夕方の食欲との付き合い方",
    "間食をやめるより上手に食べる方が痩せる理由",
    "40・50代女性がなかなか痩せない本当の理由",
    "食べる量を減らしても痩せない人に足りないもの",
    "ダイエット中に絶対やってはいけない食事の習慣",
    "たんぱく質を毎食摂ると体が変わる理由",
    "停滞期を乗り越えるために知っておくべきこと",
    "40代から太りやすくなる体の仕組みと対策",
    "食べる順番を変えるだけで痩せやすくなる理由",
    "ダイエット中に筋肉を落とさないための食べ方",
    "腸内環境を整えるとダイエットが加速する理由",
    "更年期でも痩せられる食事の考え方",
    "体重より体脂肪を意識すべき理由",
    "脂肪を燃やすために必要な栄養素と食べ方",
    "ダイエットに失敗し続ける人の共通点",
    "週末の食べすぎをリセットする方法",
    "水を飲むだけで痩せやすくなる理由と正しい飲み方",
    "血糖値が高い人ほど痩せにくい理由と対策",
    "コレステロールを下げながら痩せる食べ方",
    "高血圧とダイエットの意外な関係",
    "脂肪肝を改善するとダイエットが加速する理由",
    "糖尿病リスクを下げながら痩せる食事の選び方",
  ]

  const lunchTopics = [
    "血糖値の乱高下を抑える食べ方・食事の選び方",
    "40・50代女性に合った痩せるランチの選び方",
    "お昼にたんぱく質を摂ると午後が変わる理由",
    "コンビニランチで太らない選び方",
    "食後の眠気を防ぐ昼食の食べ方",
    "外食ランチで血糖値を上げない注文の仕方",
    "昼食を抜くと夜に太る理由",
    "お昼の炭水化物との正しい付き合い方",
    "野菜から食べるだけで変わる血糖値コントロール",
    "40代からの代謝を上げるお昼ごはんの組み合わせ",
    "40・50代女性がなかなか痩せない本当の理由",
    "食べる量を減らしても痩せない人に足りないもの",
    "ダイエット中に絶対やってはいけない食事の習慣",
    "たんぱく質を毎食摂ると体が変わる理由",
    "停滞期を乗り越えるために知っておくべきこと",
    "40代から太りやすくなる体の仕組みと対策",
    "食べる順番を変えるだけで痩せやすくなる理由",
    "ダイエット中に筋肉を落とさないための食べ方",
    "週末の食べすぎをリセットする方法",
    "水を飲むだけで痩せやすくなる理由と正しい飲み方",
    "ダイエットに失敗し続ける人の共通点",
    "腸内環境を整えるとダイエットが加速する理由",
    "更年期でも痩せられる食事の考え方",
    "間食をうまく使ってダイエットを加速させる方法",
    "体重より体脂肪を意識すべき理由",
    "昼食後の血糖値スパイクを防ぐ食べ方",
    "コレステロールを下げるランチの選び方",
    "高血圧の人が避けるべきランチの落とし穴",
    "脂肪肝改善につながる昼食の選び方",
    "糖尿病予防になるお昼ごはんの組み合わせ",
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
    "40・50代女性がなかなか痩せない本当の理由",
    "食べる量を減らしても痩せない人に足りないもの",
    "ダイエット中に絶対やってはいけない食事の習慣",
    "たんぱく質を毎食摂ると体が変わる理由",
    "停滞期を乗り越えるために知っておくべきこと",
    "食べる順番を変えるだけで痩せやすくなる理由",
    "腸内環境を整えるとダイエットが加速する理由",
    "体重より体脂肪を意識すべき理由",
    "水を飲むだけで痩せやすくなる理由と正しい飲み方",
    "朝の空腹時血糖値を下げる朝食の選び方",
    "高血圧の人が朝に意識すべき食べ方",
    "コレステロールを朝食から改善する方法",
    "糖尿病リスクを下げる朝のルーティン",
    "脂肪肝を改善しながら痩せる朝ごはん",
  ]

  const eveningTopics = [
    // ダイエット・体重管理
    "頑張っても痩せない自分を責めなくていい理由",
    "40・50代女性がなかなか痩せない本当の理由",
    "食べる量を減らしても痩せない人に足りないもの",
    "停滞期を乗り越えるために知っておくべきこと",
    "更年期でも痩せられる食事の考え方",
    "ダイエット中に筋肉を落とさないための食べ方",
    "体重より体脂肪を意識すべき理由",
    "夜に食べてしまった時のリカバリー方法",
    "寝る前にやると痩せやすくなる習慣",
    // 血糖値・糖尿病
    "血糖値を夜に下げるために今夜できること",
    "糖尿病予備群と言われた人が今夜から変えるべき習慣",
    "夕食後の血糖値スパイクを防ぐ食べ方",
    "血糖値が高い人ほど夜の炭水化物に注意すべき理由",
    "空腹時血糖値を下げる生活習慣",
    "インスリン抵抗性とダイエットの深い関係",
    "糖尿病リスクを下げる食事の順番と組み合わせ",
    "食後血糖値の上昇を抑える夜の過ごし方",
    // 健康全般
    "高血圧・コレステロールを食事で改善する夜の習慣",
    "脂肪肝を改善するために今夜やめるべき食べ方",
    "腸内環境を整えるとダイエットが加速する理由",
    "睡眠不足が太る原因になる仕組み",
    "成長ホルモンを最大限に活かす夜の過ごし方",
    "膝・腰が痛くても夜にできるセルフケア",
    "血液検査の数値が気になる人の夜の食べ方",
    // メンタル・継続
    "ストレスで食べてしまう40・50代へのメッセージ",
    "今日うまくいかなかった人へ。それでも大丈夫な理由",
    "何度失敗しても、また始めていい",
    "夜に自分を責めないことがダイエット成功のカギ",
    "完璧にできなかった日の気持ちの切り替え方",
    "家族のために自分の体を大切にすることの意味",
    // 夜の習慣
    "寝る前の間食の取り方（太らない夜食の選び方）",
    "就寝2時間前までに食べ終わるべき理由",
    "明日の血糖値を下げるための今夜の選択",
    "夜中に目が覚める・眠れない人の体重との関係",
    "今日の食事を振り返る習慣がダイエットを加速する",
  ]

  // topicIndexを使って順番にトピックを選ぶ（8投稿で重複しない）
  const afternoonTopic = afternoonTopics[topicIndex % afternoonTopics.length]
  const lunchTopic = lunchTopics[topicIndex % lunchTopics.length]
  const morningTopic = morningTopics[topicIndex % morningTopics.length]
  const eveningTopic = eveningTopics[topicIndex % eveningTopics.length]

  const topicMap = { morning: morningTopic, lunch: lunchTopic, afternoon: afternoonTopic, evening: eveningTopic }
  const currentTopic = topicMap[timeSlot]

  // Tavilyでネット検索（全時間帯で健康・血糖値キーワードを含める）
  console.log(`「${currentTopic}」を検索中...`)
  const searchQuery = `${currentTopic} ダイエット 血糖値 糖尿病 高血圧 コレステロール 健康 40代 50代 女性 最新`
  const searchResult = await searchWeb(searchQuery)
  const searchSection = searchResult ? `
【最新のネット情報（参考にしてください）】
${searchResult}
` : ""

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

  // 既に生成した投稿を「避けるべき例」としてプロンプトに追加
  const avoidSection = alreadyGenerated.length > 0 ? `
【以下の投稿と似た内容・表現・構成は絶対に使わないこと】
${alreadyGenerated.map((t, i) => `--- 既出${i + 1} ---\n${t}`).join("\n\n")}

上記と異なるテーマ・切り口・表現で書いてください。
` : ""

  const commonConditions = `
- ダイエットを軸にしながら、血糖値・糖尿病・高血圧・コレステロールなど健康全般の情報も自然に織り交ぜる
- 読んですぐ「やってみよう」と思える具体的な内容
- 必ず100文字以内（改行含む）で簡潔に書く
- 「また明日も頑張ろう」「また明日」「明日も頑張ろう」「一緒に頑張ろう」などの締めくくりフレーズは絶対に使わない`

  const prompts = {
    morning: `あなたは40・50代女性専門のダイエットサポーターです。
${audience}
このターゲットに向けた「朝6時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${morningTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}`,

    afternoon: `あなたは40・50代女性専門のダイエットサポーターです。
${audience}
このターゲットに向けた「夕方17時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${afternoonTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}`,

    lunch: `あなたは40・50代女性専門のダイエットサポーターです。
${audience}
このターゲットに向けた「昼12時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${lunchTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}`,

    evening: `あなたは40・50代女性専門のダイエットサポーターです。
${audience}
このターゲットに向けた「夜21時の投稿」を作成してください。
${styleGuide}
今回のテーマ：「${eveningTopic}」
${searchSection}
${avoidSection}
追加条件：${commonConditions}
- ダイエットだけでなく、血糖値・糖尿病・高血圧・コレステロールなど健康全般の情報も積極的に取り上げる
- 「今夜から実践できる」具体的な行動を一つ入れる`,
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
async function getContent(topicIndex = 0, alreadyGenerated = []) {
  const jstHour = (new Date().getUTCHours() + 9) % 24
  console.log(`JST: ${jstHour}時`)

  if (jstHour >= 4 && jstHour < 10) {
    // 朝はmain()で直接処理するためここには来ないが念のため
    console.log("タイプ: AI生成（朝）")
    return await generateWithClaude("morning", topicIndex, alreadyGenerated)
  } else if (jstHour >= 10 && jstHour < 16) {
    console.log("タイプ: AI生成（昼）")
    return await generateWithClaude("lunch", topicIndex, alreadyGenerated)
  } else if (jstHour >= 16 && jstHour < 21) {
    console.log("タイプ: AI生成（夕）")
    return await generateWithClaude("afternoon", topicIndex, alreadyGenerated)
  } else {
    // 夜：全件AI生成＋Tavily検索（血糖値・健康テーマを含む）
    console.log("タイプ: AI生成（夜）")
    return await generateWithClaude("evening", topicIndex, alreadyGenerated)
  }
}

async function main() {
  const totalPosts = 8
  const jstHour = (new Date().getUTCHours() + 9) % 24
  const isMorning = jstHour >= 4 && jstHour < 10
  const alreadyGenerated = [] // 生成済み投稿を蓄積（重複防止用）

  for (let i = 1; i <= totalPosts; i++) {
    console.log(`\n===== 投稿 ${i}/${totalPosts} =====`)

    let mainText, replyText = null

    if (isMorning) {
      const posts = JSON.parse(fs.readFileSync(path.join(__dirname, "posts.json"), "utf-8"))
      const fixedPosts = posts.morning || []
      // 最初のN件は固定投稿を順番に使い、残りはAI生成
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

    // 生成済みリストに追加（次の投稿の重複防止に使用）
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

    // 投稿間隔（レート制限対策）
    if (i < totalPosts) await new Promise((r) => setTimeout(r, 5000))
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error("詳細:", err.stack || err)
  process.exit(1)
})
