import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"

// データ削除リクエスト時に Threads が POST してくるエンドポイント
// Meta の仕様: confirmation_code と status 確認 URL を返す必要がある
export async function POST(req: NextRequest) {
  // confirmation_code をランダム生成（16進数16文字）
  const confirmationCode = crypto.randomBytes(8).toString("hex")

  const host = req.headers.get("host") ?? "your-app.vercel.app"
  const protocol = host.startsWith("localhost") ? "http" : "https"
  const statusUrl = `${protocol}://${host}/api/delete/status?code=${confirmationCode}`

  console.log("[delete] data deletion requested, code:", confirmationCode)

  // Meta が要求するレスポンス形式
  return NextResponse.json({
    url: statusUrl,
    confirmation_code: confirmationCode,
  })
}

export async function GET() {
  return NextResponse.json({ ok: true })
}
