// オフライン検証：APIを呼ばずにロジック（抽選/品質/重複/リトライ/生成）を確認する
const content = require("./content_aisupport.js")
const engine = require("./auto_post_aisupport.js")

let pass = 0, fail = 0
function ok(cond, msg) { if (cond) { pass++; console.log("  ✓", msg) } else { fail++; console.log("  ✗ FAIL:", msg) } }

console.log("\n[1] カテゴリー抽選の分布（週次比率どおりか）")
{
  const counts = {}
  for (let i = 0; i < 20000; i++) { const k = content.pickCategory([]); counts[k] = (counts[k] || 0) + 1 }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  for (const [k, c] of Object.entries(counts)) {
    console.log(`   ${content.CATEGORIES[k].label}: ${(c / total * 100).toFixed(1)}% (目安${content.CATEGORIES[k].weight}%)`)
  }
  ok(!counts.question, "question は自動抽選されない(weight0)")
  ok(counts.training_diary > counts.service, "育成日記 > サービス案内")
}

console.log("\n[2] 品質チェック")
{
  const good = "患者さんが帰ったあとの20時。\nそこからSNS、LINE、Googleマップ。\n全部自分でやってる先生、多くないですか？\n一番時間を取られてる作業は何ですか？"
  const rGood = content.qualityCheck(good, { history: [] })
  ok(rGood.ok, `良い投稿は通過 (${rGood.len}字)`)

  const tooShort = content.qualityCheck("AIは便利。使ってますか？", { history: [] })
  ok(!tooShort.ok && tooShort.reasons.some(r => r.includes("短")), "短すぎを検出")

  const abstract = content.qualityCheck("AIはこれからの時代にとても重要な存在になっていくと思います。可能性は無限大で夢が広がりますね。どう思いますか？皆さん教えてください。", { history: [] })
  ok(!abstract.ok && abstract.reasons.some(r => r.includes("抽象")), "抽象的すぎ(業務語なし)を検出")

  const sell = content.qualityCheck("SNS投稿をAIで自動化できます。LINEもGoogleマップも対応。ご興味あればお問い合わせください。今すぐ登録どうぞ。", { history: [] })
  ok(!sell.ok && sell.reasons.some(r => r.includes("売り込み")), "強い売り込みを検出")

  const banned = content.qualityCheck("このLINE配信をAIでやれば予約は必ず増えて、集客は絶対にうまくいきます。やってみませんか？", { history: [] })
  ok(!banned.ok && banned.reasons.some(r => r.includes("断定")), "断定・誇張(必ず/絶対)を検出")
}

console.log("\n[3] 重複チェック（過去30日）")
{
  const base = "患者さんが帰ったあとにSNSとLINEとGoogleマップを全部やってる先生、多くないですか？一番時間を取られてる作業は何ですか？"
  const history = [{ text: base, postedAt: new Date().toISOString() }]
  const near = "患者さんが帰ったあとにSNSとLINEとGoogleマップを全部やってる先生、多いですよね。一番時間を取られてる仕事は何ですか？"
  const dup = content.qualityCheck(near, { history })
  ok(!dup.ok && dup.reasons.some(r => r.includes("類似")), "類似投稿を重複として検出")

  const old = [{ text: base, postedAt: new Date(Date.now() - 40 * 864e5).toISOString() }]
  const notDup = content.findDuplicate(near, old, 30)
  ok(!notDup, "40日前(30日外)は重複扱いしない")
}

console.log("\n[5] 反応データからの学習（categoryPerformance / buildEngagementHint）")
{
  const mk = (cat, likes, replies) => ({ category: cat, insights: { likes, replies, views: 100, reposts: 0 }, postedAt: new Date().toISOString() })
  const hist = []
  // clinic_problem を高反応、ai_philosophy を低反応で20件用意
  for (let i = 0; i < 10; i++) hist.push(mk("clinic_problem", 8, 4))
  for (let i = 0; i < 10; i++) hist.push(mk("ai_philosophy", 1, 0))
  const rows = content.categoryPerformance(hist)
  ok(rows[0].category === "clinic_problem", "高反応カテゴリーが上位に並ぶ")
  const hint = content.buildEngagementHint(hist)
  ok(hint.includes("治療院経営者の悩み"), "学習ヒントに伸びた型が入る")
  ok(content.buildEngagementHint(hist.slice(0, 5)) === "", "データが少ないうちはヒントを出さない")
}

console.log("\n[6] 無料AI集客診断への相談導線（CTA）")
{
  // サービス枠は必ずCTAが付く
  ok(content.shouldAttachCTA({ category: "service", globalIndex: 1 }), "サービス枠は常にCTAを付ける")
  // 非サービス枠は N 回に 1 回だけ
  const n = content.CTA_EVERY_NTH
  ok(content.shouldAttachCTA({ category: "clinic_problem", globalIndex: n }), `非サービス枠は${n}回に1回付く`)
  ok(!content.shouldAttachCTA({ category: "clinic_problem", globalIndex: n + 1 }), "非サービス枠は毎回は付けない（付けすぎ防止）")
  // ローテーションが4本を一巡する
  const lines = new Set([0, 1, 2, 3].map((i) => content.pickDiagnosisCTA(i)))
  ok(lines.size === content.DIAGNOSIS_CTA.length, "CTAは全パターンをローテーションする")
  // 付与すると本文の後ろにCTAが空行区切りで足される
  const withCta = content.appendCTA("本文です。", content.pickDiagnosisCTA(0))
  ok(withCta.startsWith("本文です。") && withCta.includes("無料AI集客診断"), "本文の後にCTAが付与される")
  // CTAが無い時は本文のまま
  ok(content.appendCTA("本文だけ。", null) === "本文だけ。", "CTAが無い投稿は本文のまま")
}

console.log("\n[4] generateCategoryPost（モックLLM：品質NG→リトライ→OK）")
{
  // 1回目はダメな投稿、2回目で良い投稿を返すモッククライアント
  let call = 0
  const good = "今日はAIスタッフにGoogleマップ投稿を任せてみました。\n最初は広告っぽい文章ばかり。\n『患者さんの不安を先に書いて』と直したら、ぐっと自然に。\nAIも新人と同じで最初の教育が大事ですね。\n最初に何を覚えさせますか？"
  const mockClient = {
    messages: {
      create: async () => {
        call++
        const text = call === 1 ? "AIはすごい。" : good // 1回目は短すぎでNG
        return { content: [{ text }] }
      },
    },
  }
  return engine.generateCategoryPost({ client: mockClient, recentCategories: [], history: [], metrics: null, forceQuestion: true })
    .then((res) => {
      ok(res && res.text === good, "リトライ後に品質OKの投稿を返す")
      ok(res && res.hasQuestion, "forceQuestion指定で質問締めになっている")
      ok(call === 2, `1回目NG→2回目採用（呼び出し${call}回）`)
      console.log(`\n結果: ${pass} passed, ${fail} failed`)
      process.exit(fail > 0 ? 1 : 0)
    })
}
