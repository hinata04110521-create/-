import { NextRequest, NextResponse } from "next/server"

// OAuth 認証後に Threads がリダイレクトしてくるエンドポイント
// ?code=XXXX が付いてくる（手動でトークン交換する場合はここで取得）
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code")
  const error = req.nextUrl.searchParams.get("error")

  if (error) {
    return new NextResponse(
      `<html><body style="font-family:sans-serif;padding:40px">
        <h2>❌ 認証がキャンセルされました</h2>
        <p>エラー: ${error}</p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    )
  }

  if (!code) {
    return new NextResponse(
      `<html><body style="font-family:sans-serif;padding:40px">
        <h2>⚠️ code パラメータが見つかりません</h2>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    )
  }

  // code を表示するだけ（Claude Code でトークン交換に使う）
  return new NextResponse(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>✅ OAuth 認証成功</h2>
      <p>以下の <strong>code</strong> を Claude Code に貼り付けてください：</p>
      <pre style="background:#f4f4f4;padding:16px;border-radius:8px;font-size:14px;word-break:break-all">${code}</pre>
      <p style="color:#888;font-size:13px">※ code は短時間で失効します。すぐにトークン交換を行ってください。</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  )
}
