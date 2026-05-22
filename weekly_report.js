const https = require("https")

// ===== Tavily 検索 =====
function tavilySearch(query) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: true,
    })
    const req = https.request(
      { method: "POST", hostname: "api.tavily.com", path: "/search",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => { try { resolve(JSON.parse(data)) } catch { resolve({}) } })
      }
    )
    req.on("error", () => resolve({}))
    req.setTimeout(12000, () => { req.destroy(); resolve({}) })
    req.write(body)
    req.end()
  })
}

// ===== Threads API GET =====
function threadsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => { try { resolve(JSON.parse(data)) } catch { resolve({}) } })
    })
    req.on("error", () => resolve({}))
    req.setTimeout(10000, () => { req.destroy(); resolve({}) })
  })
}

// ===== アカウントのトップ投稿を取得 =====
async function getTopPosts(userId, token) {
  try {
    const url = `https://graph.threads.net/v1.0/${userId}/threads?fields=id,text,timestamp&limit=30&access_token=${token}`
    const res = await threadsGet(url)
    const posts = (res.data || []).filter((p) => p.text && p.text.length > 5)

    const postsWithMetrics = await Promise.all(
      posts.map(async (post) => {
        try {
          const insUrl = `https://graph.threads.net/v1.0/${post.id}/insights?metric=views,likes,replies&access_token=${token}`
          const ins = await threadsGet(insUrl)
          const m = {}
          for (const item of ins.data || []) {
            m[item.name] = item.total_value?.value ?? item.values?.[0]?.value ?? 0
          }
          return { ...post, views: m.views || 0, likes: m.likes || 0, replies: m.replies || 0 }
        } catch {
          return { ...post, views: 0, likes: 0, replies: 0 }
        }
      })
    )

    return postsWithMetrics.sort((a, b) => b.views - a.views).slice(0, 5)
  } catch (e) {
    console.log("投稿取得エラー:", e.message)
    return []
  }
}

// ===== Claude でレポート本文を生成 =====
async function generateReportContent(data) {
  const Anthropic = require("@anthropic-ai/sdk")
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const formatPosts = (posts) =>
    posts.length === 0
      ? "（データなし）"
      : posts
          .map(
            (p, i) =>
              `${i + 1}位: 閲覧${p.views}回 / いいね${p.likes}回\n　「${(p.text || "").slice(0, 60).replace(/\n/g, " ")}…」`
          )
          .join("\n")

  const formatTrends = (result) => {
    if (!result || !result.results) return "（取得できませんでした）"
    return result.results
      .slice(0, 4)
      .map((r) => `・${r.title}: ${(r.content || "").slice(0, 80)}`)
      .join("\n")
  }

  const prompt = `あなたはSNS運用の専門アナリストです。以下のデータを元に、日本語でThreads週次運用レポートを作成してください。

【ダイエット・健康ジャンルのトレンド】
${formatTrends(data.dietTrend)}

【頭痛・肩こりジャンルのトレンド】
${formatTrends(data.headacheTrend)}

【hinata_body_labo（ダイエットアカウント）先週トップ5投稿】
${formatPosts(data.bodyLaboPosts)}

【hinata_zutsuu（頭痛・姿勢アカウント）先週トップ5投稿】
${formatPosts(data.zutsuuPosts)}

---
以下の構成でレポートを作成してください：

## 1. 今週のトレンドテーマ
### ダイエット・健康
（注目テーマを3〜5項目、箇条書きで）

### 頭痛・肩こり
（注目テーマを3〜5項目、箇条書きで）

## 2. 自アカウント分析
### hinata_body_labo
- ベスト投稿と、なぜ伸びたかの分析
- 改善できる点

### hinata_zutsuu
- ベスト投稿と、なぜ伸びたかの分析
- 改善できる点

## 3. 来週の投稿テーマ提案
### hinata_body_labo おすすめテーマ（3つ）
### hinata_zutsuu おすすめテーマ（3つ）

## 4. 今週の総括・アドバイス
（全体を通じた気づき・改善ポイントを2〜3つ）

読みやすく、具体的で実践的な内容にしてください。`

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
  })

  return message.content[0].text
}

// ===== Markdown → HTML 変換（簡易） =====
function mdToHtml(text) {
  return text
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>")
}

// ===== PDF 生成 =====
async function generatePDF(reportContent, reportDate) {
  const puppeteer = require("puppeteer")

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Kaku Gothic Pro", "Meiryo", sans-serif;
    font-size: 12px; line-height: 1.9; color: #2d3748;
    margin: 0; padding: 32px 40px;
  }
  .cover {
    background: linear-gradient(135deg, #1a365d 0%, #2b6cb0 100%);
    color: white; padding: 32px; border-radius: 12px; margin-bottom: 28px;
  }
  .cover h1 { font-size: 22px; font-weight: bold; margin-bottom: 6px; }
  .cover .subtitle { font-size: 13px; opacity: 0.85; }
  h2 {
    font-size: 15px; color: #1a365d; margin: 22px 0 10px;
    border-left: 5px solid #3182ce; padding: 6px 12px;
    background: #ebf8ff; border-radius: 0 6px 6px 0;
  }
  h3 { font-size: 13px; color: #2c5282; margin: 14px 0 6px; font-weight: bold; }
  p { margin: 6px 0; }
  ul { margin: 6px 0 6px 20px; }
  li { margin: 3px 0; }
  strong { color: #2c5282; }
  .footer {
    margin-top: 32px; border-top: 1px solid #e2e8f0;
    padding-top: 12px; font-size: 10px; color: #a0aec0; text-align: center;
  }
</style>
</head>
<body>
<div class="cover">
  <h1>📊 Threads 週次運用レポート</h1>
  <div class="subtitle">レポート生成日：${reportDate} ／ 対象アカウント：hinata_body_labo ／ hinata_zutsuu</div>
</div>
<div class="content">
${mdToHtml(reportContent)}
</div>
<div class="footer">
  本レポートはAI（Claude）とTavily APIによって自動生成されました。
</div>
</body>
</html>`

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  })
  const page = await browser.newPage()
  await page.setContent(html, { waitUntil: "networkidle0" })
  const pdf = await page.pdf({
    format: "A4",
    margin: { top: "15mm", bottom: "15mm", left: "12mm", right: "12mm" },
    printBackground: true,
  })
  await browser.close()
  return pdf
}

// ===== メール送信（Gmail / Nodemailer） =====
async function sendEmail(pdfBuffer, reportDate) {
  const nodemailer = require("nodemailer")

  const filename = `threads_report_${reportDate.replace(/\//g, "")}.pdf`

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  })

  await transporter.sendMail({
    from: `Threads Report <${process.env.GMAIL_USER}>`,
    to: process.env.REPORT_EMAIL,
    subject: `📊 Threads 週次レポート - ${reportDate}`,
    html: `<p>お疲れ様です。</p>
<p>今週のThreads運用レポートをお送りします。</p>
<p>添付のPDFをご確認ください。</p>
<hr>
<p style="color:#888;font-size:12px;">本メールはGitHub Actionsにより自動送信されています。</p>`,
    attachments: [
      {
        filename,
        content: pdfBuffer,
      },
    ],
  })

  console.log(`メール送信完了: ${filename}`)
}

// ===== メイン =====
async function main() {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const reportDate = `${jst.getFullYear()}/${String(jst.getMonth() + 1).padStart(2, "0")}/${String(jst.getDate()).padStart(2, "0")}`
  console.log(`=== 週次レポート生成開始 (${reportDate}) ===`)

  // 1. トレンド調査（並列）
  console.log("トレンド調査中...")
  const [dietTrend, headacheTrend] = await Promise.all([
    tavilySearch("ダイエット 40代 50代 女性 最新 トレンド 2026"),
    tavilySearch("頭痛 肩こり 猫背 改善 最新 トレンド 2026"),
  ])

  // 2. アカウント分析（並列）
  console.log("アカウントデータ取得中...")
  const [bodyLaboPosts, zutsuuPosts] = await Promise.all([
    getTopPosts(process.env.THREADS_USER_ID, process.env.THREADS_ACCESS_TOKEN),
    getTopPosts(process.env.THREADS_USER_ID_ZUTSUU, process.env.THREADS_ACCESS_TOKEN_ZUTSUU),
  ])

  // 3. Claude でレポート生成
  console.log("レポート本文生成中...")
  const reportContent = await generateReportContent({ dietTrend, headacheTrend, bodyLaboPosts, zutsuuPosts })

  // 4. PDF 生成
  console.log("PDF生成中...")
  const pdfBuffer = await generatePDF(reportContent, reportDate)

  // 5. メール送信
  console.log("メール送信中...")
  await sendEmail(pdfBuffer, reportDate)

  console.log("=== 完了！ ===")
}

main().catch((err) => {
  console.error("エラー:", err.message)
  console.error(err.stack)
  process.exit(1)
})
