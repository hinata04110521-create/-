import { NextRequest, NextResponse } from "next/server"

// Meta がデータ削除完了を確認しに来るエンドポイント
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "unknown"
  return NextResponse.json({ status: "completed", confirmation_code: code })
}
