import { NextRequest, NextResponse } from "next/server"

// ユーザーがアプリ許可を取り消した時に Threads が POST してくるエンドポイント
export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    console.log("[uninstall] signed_request received:", body)
  } catch {
    // ログ失敗は無視
  }
  // 200 を返すだけでOK（Threads の仕様）
  return NextResponse.json({ success: true })
}

// Threads が疎通確認で GET することもあるため念のため対応
export async function GET() {
  return NextResponse.json({ ok: true })
}
