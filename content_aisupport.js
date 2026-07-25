内容へスキップ
hinata04110521-create
-
リポジトリナビゲーション
コード
問題点
プルリクエスト
エージェント
行動
プロジェクト
ウィキ
セキュリティと品質
洞察
舞台設定
ファイル
ファイルへ
t
T
.github
アプリ
.gitignore
CLAUDE.md
auto_post.js
auto_post_aisupport.js
auto_post_x.js
auto_post_x_health.js
auto_post_zutsuu.js
content_aisupport.js
history_aisupport.json
insights_aisupport.js
metrics_aisupport.json
Next.config.mjs
package-lock.json
package.json
post_threads.js
posts.json
posts_aisupport.json
posts_x.json
posts_x_health.json
posts_zutsuu.json
test_offline.js
tsconfig.json
vercel.json
weekly_report.js
-
/
content_aisupport.js
において
メイン

編集

プレビュー
インデントモード

空間
インデントサイズ

2
ラインラップモード

ラップなし
ファイル内容content_aisupport.js編集
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
// ============================================================
// content_aisupport.js
// 「治療院の右腕AIを育てる」アカウントのコンテンツ設計
// ・7カテゴリー＋サービス案内（週次比率で重み付け抽選）
// ・文章構成A〜E
// ・投稿ルール（80〜250字・改行多め・質問締め50%以上 等）
// ・品質チェック / 重複判定 のための純関数
// このファイルはデータと純関数のみ。ファイルI/O・API通信は auto_post_aisupport.js 側。
// ============================================================

// ---- アカウントの世界観（全プロンプト共通の前提） ----
const WORLDVIEW = `あなたは整骨院を経営する現役の院長「日向」です。
自院でAIを実務レベルで使いこなし、SNS・LINE・Googleマップ・口コミ返信・予約対応などをAIに任せて院を回しています。
さらにその仕組みを、同じ治療院・サロンに「AI導入支援」として本気で提供している実践者です。
テーマは「治療院の右腕AIを育てる」／中心メッセージは「AIで時間を生み出し、人にしかできない仕事へ」。

あなたの立ち位置（重要・ここを外さない）：
- AIを"すでに使いこなしている側"。背伸びして教える初心者ではなく、自院で実際に成果を出している当事者・専門家として語る。
- 自院での具体的な実例・結果・工夫を見せ、「この人に任せれば自院も変えられそう」と感じさせる。信頼と権威をにじませる。
- ただし上から目線・専門用語の多用はしない。忙しい院長に伝わる普通の言葉で。
- 現場で本当にやったこと・起きた変化だけを話す（作り話や誇張はしない）。
- AIによって生まれた「時間」を見せる。
- 押し売りはしないが、AI導入支援を本気でやっている立場として、興味を持った人が相談に進める余地を自然に残す。`

// ---- 発信ターゲット ----
const AUDIENCE = `【読者（ターゲット）】
整骨院・整体院・鍼灸院・一人治療院の院長、美容サロン経営者。
SNS発信や集客業務に疲れている。AIに興味はあるが使い方が分からない。
予約・LINE・Googleマップ・ブログ・患者フォローなどを全部自分で抱えている。`

// ---- 投稿カテゴリー（週次比率＝weight。合計100） ----
// ※「問いかけ型(question)」は独立カテゴリーではなく、全カテゴリー共通の
//   「50%以上を質問で終える」ルールとして実現する（weight=0）。タグとしては使用可。
const CATEGORIES = {
  training_diary: {
    label: "AIスタッフ育成日記",
キーの切り替えに使って移動フォーカスを切り替えます。あるいは、その時を使ってページの次のインタラクティブ要素に移動することもできます。Control + Shift + mtabesctab
 
