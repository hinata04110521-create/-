const https = require("https")
const fs = require("fs")
const path = require("path")

// .env.local を読み込む
function loadEnv() {
  const envPath = path.join(__dirname, ".env.local")
  const lines = fs.readFileSync(envPath, "utf-8").split("\n")
  const env = {}
  for (const line of lines) {
    const [key, ...rest] = line.split("=")
    if (key && rest.length) env[key.trim()] = rest.join("=").trim()
  }
  return env
}

// POST リクエスト
function post(url, params) {
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

async function postToThreads(text) {
  const env = loadEnv()
  const TOKEN = env.THREADS_ACCESS_TOKEN
  const USER_ID = env.THREADS_USER_ID
  const BASE = "https://graph.threads.net/v1.0"

  if (!TOKEN || !USER_ID) {
    console.error("エラー: .env.local に THREADS_ACCESS_TOKEN と THREADS_USER_ID を設定してください")
    process.exit(1)
  }

  // Step 1: コンテナ作成
  const container = await post(`${BASE}/${USER_ID}/threads`, {
    media_type: "TEXT",
    text,
    access_token: TOKEN,
  })

  if (container.error) {
    console.error("コンテナ作成失敗:", container.error.message)
    process.exit(1)
  }

  // API 安定待ち
  await new Promise((r) => setTimeout(r, 5000))

  // Step 2: 公開
  const result = await post(`${BASE}/${USER_ID}/threads_publish`, {
    creation_id: container.id,
    access_token: TOKEN,
  })

  if (result.error) {
    console.error("投稿失敗:", result.error.message)
    process.exit(1)
  }

  console.log("投稿成功！投稿ID:", result.id)
  return result.id
}

// コマンドライン引数からテキストを受け取る
const text = process.argv.slice(2).join(" ")
if (!text) {
  console.error("使い方: node post_threads.js \"投稿したいテキスト\"")
  process.exit(1)
}

postToThreads(text)
