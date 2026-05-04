export default function Home() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: 40 }}>
      <h1>Threads Callback Server</h1>
      <ul>
        <li><code>/api/callback</code> — OAuth リダイレクト先</li>
        <li><code>/api/uninstall</code> — アンインストール通知</li>
        <li><code>/api/delete</code> — データ削除リクエスト</li>
      </ul>
    </main>
  )
}
