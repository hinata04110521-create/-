// ============================================================
// insights_aisupport.js
// Threads API から各投稿の反応（閲覧・いいね・返信・リポスト）を取得し、
// history_aisupport.json に記録して、カテゴリー別のレポートを出す。
// これにより「どの型が伸びたか」を計測し、生成に学習として反映する。
// 必要スコープ: threads_manage_insights（トークンに付いていない場合は取得失敗＝レポートに表示）。
// ============================================================
const https = require("https")
const fs = require("fs")
const path = require("path")
const content = require("./content_aisupport.js")

const HISTORY_PATH = path.join(__dirname, "history_aisupport.json")

function getJson(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => { try { resolve(JSON.parse(data || "{}")) } catch { resolve({ error: { message: "JSON以外の応答" } }) } })
    }).on("error", (e) => resolve({ error: { message: e.message } }))
  })
}

async function fetchInsights(mediaId, token) {
  const metric = "views,likes,replies,reposts,quotes"
  const url = `https://graph.threads.net/v1.0/${mediaId}/insights?metric=${metric}&access_token=${token}`
  const res = await getJson(url)
  if (res.error) return { error: res.error.message }
  const out = {}
  for (const d of res.data || []) {
    out[d.name] = (d.values && d.values[0] && d.values[0].value) || 0
  }
  return out
}

async function fetchFollowers(userId, token) {
  const url = `https://graph.threads.net/v1.0/${userId}/threads_insights?metric=followers_count&access_token=${token}`
  const res = await getJson(url)
  if (res.error || !res.data) return null
  const d = res.data.find((x) => x.name === "followers_count")
  return d ? (d.total_value ? d.total_value.value : (d.values && d.values[0] && d.values[0].value)) : null
}

function parsePostId(result) {
  const m = /^posted:(.+)$/.exec(result || "")
  return m ? m[1] : null
}

async function main() {
  const token = process.env.THREADS_ACCESS_TOKEN
  const userId = process.env.THREADS_USER_ID
  if (!token) throw new Error("THREADS_ACCESS_TOKEN が設定されていません")

  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"))
  const now = Date.now()
  let fetched = 0, failed = 0, firstError = null

  for (const h of history) {
    const id = parsePostId(h.result)
    if (!id) continue
    // 未取得 or 直近14日以内（反応は時間で増えるので再取得）
    const ageMs = now - (Date.parse(h.postedAt || h.createdAt || "") || now)
    const recent = ageMs < 14 * 24 * 60 * 60 * 1000
    if (h.insights && !recent) continue

    const ins = await fetchInsights(id, token)
    if (ins.error) { failed++; if (!firstError) firstError = ins.error; continue }
    h.insights = { ...ins, fetchedAt: new Date().toISOString() }
    fetched++
    await new Promise((r) => setTimeout(r, 500))
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(-500), null, 2))
  console.log(`\nインサイト取得: 成功${fetched} / 失敗${failed}`)
  if (failed > 0) console.log(`※失敗の主因: ${firstError}（トークンに threads_manage_insights スコープが必要な場合あり）`)

  const followers = userId ? await fetchFollowers(userId, token) : null
  if (followers != null) console.log(`現在のフォロワー数: ${followers}`)

  // ---- カテゴリー別レポート ----
  const rows = content.categoryPerformance(history)
  console.log("\n===== カテゴリー別 反応レポート（平均） =====")
  if (rows.length === 0) {
    console.log("まだ反応データがありません（投稿後、時間が経つと蓄積されます）")
  } else {
    console.log("カテゴリー".padEnd(20) + "件数  平均いいね  平均返信  平均閲覧")
    for (const r of rows) {
      const label = (content.CATEGORIES[r.category] && content.CATEGORIES[r.category].label) || r.category
      console.log(
        label.padEnd(20) +
        String(r.n).padEnd(6) +
        r.avgLikes.toFixed(1).padEnd(11) +
        r.avgReplies.toFixed(1).padEnd(10) +
        r.avgViews.toFixed(0)
      )
    }
    const hint = content.buildEngagementHint(history)
    console.log(`\n学習ヒント: ${hint || "（まだデータ不足。蓄積が進むと生成に自動反映されます）"}`)
  }
}

main().catch((err) => {
  console.error("エラー:", err.message)
  process.exit(1)
})
