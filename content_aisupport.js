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
- 右腕AIに任せる業務は、集客・SNSだけでなく、事務・売上/数字の把握・シフト・スタッフ対応・労務まわりまで広がっている。任せられる範囲が"少しずつ増え続けている"（育成が進んでいる）幅と手応えも見せる。ただし給与計算などは専用ソフト＋人が担い、AIは下ごしらえ、という現実的な線引きも正直に語る。
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
    weight: 12,
    kosei: ["B", "A", "E"],
    prompt: `【今日の投稿：AIスタッフ育成日記（運用の知見）】
自院で回しているAI（右腕スタッフ）の"今日の一場面"を書く。ただし初心者の試行錯誤ではなく、**使いこなしている立場からの知見・工夫**として語る。
・任せている業務／精度を上げた指示の工夫／AIが担えるようになった範囲 のどれか1つ。
・「AIは最初の設計・教育で結果が変わる」というプロの目線を自然ににじませる（＝任せれば自院も変わる、と伝わる）。
参考トーン：
「うちではGoogleマップ投稿はAIに任せています。コツは『患者さんの不安を先に書かせる』こと。ここを設計するだけで、広告っぽさが消えて自然になります。細かい"教え方"で仕上がりが変わりますね。」`,
  },
  daily_report: {
    label: "AIスタッフの日報",
    weight: 15,
    kosei: ["C", "B"],
    prompt: `【今日の投稿：AIスタッフの日報】
今日「AIがやった仕事」と「人（院長）がやった仕事」を対比し、生まれた時間の使い道まで見せる。
・箇条書きは短く。AIがやったこと／自分がやったこと を分ける。
・締めは「生み出したいのは投稿ではなく時間」という方向へ。ただし毎回同じ言い回しにしない。
参考トーン：
「今日AIがやったこと：Threads投稿・LINE文・Googleマップ投稿。僕がやったこと：施術・カウンセリング・家族との夕食。AIで作りたいのは投稿じゃなくて時間です。」`,
  },
  clinic_problem: {
    label: "治療院経営者の悩み",
    weight: 25,
    kosei: ["E", "A"],
    prompt: `【今日の投稿：治療院経営者の悩み（＝みんなが本当に困っていること）】
施術後の発信疲れ・LINE返信が溜まる・Googleマップ更新が止まる・集客を学ぶ時間がない・一人院で全部抱える——等の"あるある"に深く共感する。
・**現場で実際に聞く"生の困りごと"を、具体的な一場面に落として書く**（「集客が大変」のような抽象ではなく、「◯◯が溜まる」「◯◯する時間が取れない」という具体の場面）。
・院を経営していて／同業と話していて分かる、リアルな悩みを1つに絞る。あれこれ盛らない。
・答えやAI解決策は軽く触れる程度でよい（教えすぎない）。共感が主役。
・必ず、読者が答えやすい疑問形で終える。
参考トーン：
「患者さんが帰ったあと、Threads、Instagram、LINE、Googleマップ。全部自分で考えていませんか？ 施術より、施術以外の仕事に疲れている先生は多い気がします。一番時間を取られている仕事は何ですか？」`,
  },
  ai_philosophy: {
    label: "AI活用の考え方",
    weight: 8,
    kosei: ["D"],
    prompt: `【今日の投稿：AI活用の考え方】
短く強いメッセージ。「AIは人を減らすものではなく、人にしかできない時間を増やすもの」という思想を、治療院の具体例を1つ添えて言い切る。
・抽象論だけで終わらせない。必ず治療院の現場に着地させる。
・毎回同じ結論（同じ言い回し）にしない。
参考トーン：
「AIは人を減らすためのものじゃない。患者さんを見る時間を増やすためのもの。僕がAIで作りたいのは、投稿じゃなくて余白です。」`,
  },
  case_study: {
    label: "実際の業務改善",
    weight: 25,
    kosei: ["C"],
    prompt: `【今日の投稿：実際の業務改善（＝うちでこれを自動化して、これだけ手が空いた）】
「どの業務を」「AIでどう自動化して」「どれだけ時間・手間が空いて」「その時間を何に使ったか」——この4点を必ず具体的に。
・**1行目でどの業務を自動化したかを出す**（例：「Googleマップ投稿、もう自分では書いていません。」）。
・可能なら「◯分→◯分」「毎日◯分」「週◯時間空いた」のように、空いた時間を具体的に見せる。
・数字は、下の【使える実績データ】に書かれた"事実"だけを使う。データが無ければ数字を作らず、「ぐっと減った」等の定性表現にとどめる。
・空いた時間の"使い道"（施術・カウンセリング・家族・休息など）まで必ず書く。ここが読者の憧れになる。
・誇張・根拠のない数字は禁止。
参考トーン：
「以前はSNS20分・LINE15分・Googleマップ10分・ブログ30分で毎日約75分。今はAIが下書きを作るので確認だけ。戻ってきた時間は、患者さんのカウンセリングに使っています。」`,
  },
  failure_story: {
    label: "失敗談・改善記録",
    weight: 5,
    kosei: ["B", "A"],
    prompt: `【今日の投稿：つまずき→解決の知見】
AI活用で以前つまずいた点を、**今は解決している経験者の立場**から書く（＝失敗自慢ではなく、乗り越えて得た知見の共有）。
・「AIが悪いのではなく、指示・設計の問題」という本質に着地させる。
・"だから今はこう設計している"という一段上の視点まで見せる（権威づけになる）。
参考トーン：
「昔はAIに大量に投稿を作らせて、ほぼボツでした。原因は"誰に何を伝えるか"を決めずに投げた設計ミス。今はそこを固めてから任せるので、精度が段違いです。大事なのはプロンプトより仕事の設計でした。」`,
  },
  question: {
    label: "問いかけ型",
    weight: 0, // 独立抽選はしない（全体の質問締め50%以上ルールで担保）。タグとしては有効。
    kosei: ["E", "A"],
    prompt: `【今日の投稿：問いかけ型】
反応を取るための、答えやすい質問を中心にした短い投稿。1〜2文の状況共有＋質問。
質問例：SNSで一番面倒な作業は？／投稿を考えるのに何分？／AIに最初に任せたい仕事は？／施術以外で一番時間を取られている仕事は？`,
  },
  service: {
    label: "サービス案内",
    weight: 10,
    kosei: ["D", "A"],
    prompt: `【今日の投稿：サービス案内（本気でやっている前提・でも押し付けない）】
自院で実証済みのAIの仕組みを、同じ治療院・サロンに「AI導入支援」として提供している——という立場で書く。
・成果や自信は見せてよい（本気でやっている）。ただし「お問い合わせください！」の連呼のような、うるさい営業文句は避ける。
・"何を代行するか"ではなく、"先生が施術に集中できる時間を作る"という価値で語る。
・本文の最後に連絡先・LINE誘導などのCTAは書かない（相談導線はシステムが自動で付ける）。あなたは価値が伝わる中身だけを書く。
参考トーン：
「AIで投稿を作る"だけ"のサービスではありません。先生が施術に集中できる時間そのものを作る仕組みを、自院で実証してから提供しています。」`,
  },
}

// ============================================================
// 【追加モジュール】業務ネタの引き出し(TOPICS)
// 目的: カテゴリー(型)は同じでも「何について書くか(ネタ)」を毎回変え、
//       LINE返信・初診質問ばかりの金太郎飴を根絶する。
// content_aisupport.js の CATEGORIES 定義の直後あたりに貼り付け。
// ============================================================
const TOPICS = [
  // --- SNS・発信まわり ---
  { id: "sns_auto",      t: "SNS投稿をAIが自動で作って自動で投稿する仕組み" },
  { id: "sns_stuck",     t: "投稿ネタが思いつかず、発信が止まってしまう問題" },
  { id: "sns_time",      t: "施術の合間に投稿を考える時間が地味に削られること" },
  { id: "reel_edit",     t: "施術動画にテロップを入れてリールを作る作業をAIで自動化した話" },
  { id: "hook_1line",    t: "投稿の1行目(フック)で読まれるか決まる、という気づき" },
  { id: "post_timing",   t: "時間帯によって見る人が違うので投稿数を増やす戦略" },
  { id: "blog_draft",    t: "ブログ記事の下書きをAIに任せて週1本ラクに出す方法" },
  // --- Google・口コミ ---
  { id: "gmap_post",     t: "Googleマップの投稿をAIで続ける工夫" },
  { id: "review_reply",  t: "口コミ返信を毎回ゼロから考えず、型を作って1分で返す話" },
  { id: "review_bad",    t: "低評価の口コミに、誠実で角の立たない返信をAIで書く話" },
  { id: "review_ask",    t: "お客様に口コミをお願いするのが気まずい問題と、その解決" },
  // --- LINE・予約 ---
  { id: "line_broadcast",t: "LINEの一斉配信文をAIで作って配信をラクにする話" },
  { id: "line_reply",    t: "LINEに来る同じ質問(初診・料金・予約)への自動返信" },
  { id: "reminder",      t: "予約リマインドの自動化で無断キャンセルを減らす話" },
  { id: "eve_inquiry",   t: "夕方〜夜の問い合わせを施術中に取りこぼす問題と対策" },
  { id: "reserve_flow",  t: "予約までの導線が長くて離脱される問題(リンク1つで解決)" },
  // --- 診断ツール・集客の仕組み ---
  { id: "shindan_tool",  t: "症状タイプ診断のWebツールを自作して集客の入口にした話" },
  { id: "line_funnel",   t: "投稿→診断→LINE登録→来院、という自動で回る導線の設計" },
  { id: "no_followers",  t: "フォロワーは多くないのに閲覧・来院につながる理由(導線)" },
  { id: "no_ad_cost",    t: "ホットペッパー等の広告費に頼らずSNSで集客する考え方" },
  { id: "ad_check",      t: "インスタ広告の効果(続ける/止める)を数字で判断する話" },
  // --- 事務・経営 ---
  { id: "flyer_pop",     t: "チラシ・院内POP・メニュー表の文章をAIで作る話" },
  { id: "sales_analysis",t: "月の売上・来院データをAIに見せて次の打ち手を考える話" },
  { id: "manual",        t: "スタッフ用マニュアルや接遇の手順をAIで整える話" },
  { id: "self_care_doc", t: "患者さんに渡すセルフケア資料をAIで作る話" },
  { id: "campaign_idea", t: "季節のキャンペーン企画のたたき台をAIに出させる話" },
  { id: "task_triage",   t: "AIに任せる仕事と、人がやるべき仕事の線引き" },
  // --- 考え方・失敗・時間 ---
  { id: "time_not_post", t: "AIで作りたいのは投稿ではなく「時間」だという考え" },
  { id: "trust_by_human",t: "患者さんとの信頼は人が作る。だからAIに雑務を渡す" },
  { id: "design_matters",t: "うまくいく鍵はプロンプトより「仕事の設計」だった失敗談" },
  { id: "too_much_ai",   t: "AIに丸投げして大量にボツを出した失敗と、そこから学んだこと" },
  { id: "start_small",   t: "いきなり全部自動化せず、まず1つの作業から始める勧め" },
  { id: "afraid_ai",     t: "「AIは難しそう」という思い込みと、実際はコピペで始まる話" },
  { id: "night_desk",    t: "閉店後の事務作業で2時間残っていたのが30分になった話" },
  { id: "family_time",   t: "浮いた時間を家族や自分の勉強に使えるようになった話" },
  { id: "repeat_visit",  t: "新規より、来た人がまた来たくなる仕組み(次回予約・LINE)" },
  { id: "one_person",    t: "一人院・少人数店で全部抱え込む大変さと、その手放し方" },
  { id: "consistency",   t: "発信で一番大事なのは質より「続けられること」だという話" },
  { id: "voice_input",   t: "パソコンが苦手でも、音声やコピペでAIを使い始められる話" },
  { id: "study_group",   t: "治療院・サロン向けにAIの勉強会を始めた話" },

  // ============================================================
  // その他業務をAIに任せる（集客・SNS以外へ幅を広げる。2026-08-26追加）
  // ねらい：「右腕AI」は発信だけでなく、事務・数字・シフト・スタッフ・労務まで
  //         少しずつ任せられる——という幅と"育っていく感"を見せる。
  // ============================================================
  // --- 事務・バックオフィス ---
  { id: "receipt_expense", t: "経費やレシートの整理を、AIの下準備でラクにした話" },
  { id: "invoice_prep",    t: "請求書・領収書づくりや確認をAIで速くした話" },
  { id: "biz_email",       t: "業者や取引先へのメール文をAIに下書きさせる話" },
  { id: "night_admin",     t: "閉店後に残る細かい事務を、AIにまとめさせて短縮した話" },
  { id: "doc_forms",       t: "問診票・同意書・院内案内などの書類をAIでたたき台にする話" },
  // --- 数字・経営 ---
  { id: "kpi_review",      t: "月の来院数・売上をAIに読ませて『次の一手』を一緒に考える話" },
  { id: "reserve_view",    t: "予約の埋まり方・空き枠をAIで見える化して手を打つ話" },
  { id: "menu_pricing",    t: "メニュー・料金・回数券の設計のたたき台をAIに出させる話" },
  { id: "monthly_wrap",    t: "月末の数字のまとめ（振り返りメモ）をAIで整える話" },
  // --- シフト・スタッフ ---
  { id: "shift_draft",     t: "スタッフのシフト草案をAIに作らせ、微調整だけで済ませる話" },
  { id: "hiring_post",     t: "スタッフ募集の文章をAIで作って採用の手間を減らす話" },
  { id: "interview_q",     t: "面接で聞く質問リストをAIに用意させる話" },
  { id: "morning_meeting", t: "朝礼やミーティングの共有事項・ネタをAIでまとめる話" },
  { id: "staff_feedback",  t: "スタッフへのフィードバックや評価コメントの下書きをAIで整える話" },
  // --- 労務・給与（※計算は専用ソフト、AIは周辺の手間。自作しない線引き） ---
  { id: "payroll_tool",    t: "給与計算は専用ソフトに任せ、AIは明細の案内文や確認の手間を減らす話" },
  { id: "attendance_check",t: "勤怠の打ち間違いや締めのチェックをAIで下確認する話" },
  { id: "rule_notice",     t: "就業ルールやシフト変更の周知文をAIで作る話" },
  { id: "labor_line",      t: "給与・労務は『専用ツール＋人』、AIは下ごしらえ——という線引きの話" },
  // --- 患者対応・再来（CRM） ---
  { id: "after_care",      t: "来院後のフォローメッセージをAIで用意して再来につなげる話" },
  { id: "recall_lapsed",   t: "しばらく来ていない方への声かけ文をAIで作る話" },
  { id: "survey_summary",  t: "患者アンケートの自由記述をAIで集計・要約する話" },
  // --- 物販・在庫 ---
  { id: "stock_note",      t: "物販の在庫・発注メモをAIで整える話" },
  { id: "ec_text",         t: "物販のネット販売文・商品説明をAIで作る話" },
  // --- 幅・育っていく感（どんどんアップデート） ---
  { id: "ai_task_map",     t: "院の業務を棚卸しして『AIに任せる/人がやる』を仕分けした話" },
  { id: "back_office_all", t: "集客だけでなく、事務・数字・シフトまで少しずつAIに移している話" },
  { id: "grow_scope",      t: "右腕AIに任せられる仕事が、毎月少しずつ増えているという話" },
];

// 直近で使ったネタIDを避けて1つ選ぶ
function pickTopic(recentTopicIds = []) {
  const recent = new Set(recentTopicIds.slice(-16)); // 直近16ネタは避ける（ネタが増えたぶん被りをさらに防ぐ）
  let pool = TOPICS.filter((x) => !recent.has(x.id));
  if (pool.length === 0) pool = TOPICS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 1回の実行(5投稿)内で同じネタを避けるための集合
let _usedTopicsThisRun = new Set();

// ---- 文章構成A〜E ----
const KOSEI = {
  A: "構成A：悩み → 気づき → AIでの改善 → 問いかけ",
  B: "構成B：今日やったこと → 失敗 → 改善 → 学び",
  C: "構成C：以前の状態 → 現在の状態 → 生まれた時間 → その時間の使い道",
  D: "構成D：短い主張 → 理由 → 治療院の具体例",
  E: "構成E：治療院あるある → 共感 → 解決のヒント → 質問",
}

// ---- 投稿文の共通ルール ----
const GLOBAL_RULES = `【投稿文のルール（必ず守る）】
- 全体で80〜250文字程度。1文を短く。改行を多めに使う。
- 難しい専門用語は避ける。治療院経営者が共感できる具体例（SNS・LINE・Googleマップ・予約・口コミ・ブログ等）を必ず入れる。
- 抽象論だけで終わらせない。必ず現場の具体に着地させる。
- 売り込み感を強くしない。毎回同じ結論・同じ言い回しにしない。
- 絵文字は0〜2個まで。ハッシュタグは使わない。見出し記号（#や【】）は本文に使わない。
- 「AIはすごい」で終わらせない。仕事や時間がどう変わったかを伝える。
- 誇張した成果・根拠のない数字は使わない。医療効果や集客成果を断定しない（「必ず」「絶対」「治る」等は禁止）。
- 出力は投稿本文のみ。ラベル・前置き・説明・カテゴリー名・「MAIN:」等は一切書かない。`

// ---- フック（最初の1行）と、会話を生む締めの強化 ----
// いいね・フォローはThreadsでは「返信(会話)」の連鎖から生まれる。1行目で止め、答えやすい質問で締める。
const HOOK_RULES = `【最初の1行（フック）で必ずスクロールを止める・最重要】
- 1行目は短く、具体的な情景か意外な一言から入る（例：「今日、AIに口コミ返信を任せてみた。」「施術が終わった20時。」）。
- 説明・前置き・一般論から始めない。「AIは便利です」のような優等生な出だしは禁止。
- 数字や固有の場面（時間・業務名）を1行目に入れると止まりやすい。

【締めは"一言で答えられる質問"で会話を生む・リーチが伸びる核心】
- できるだけ2択（A/B）や「何分？」「どれ？」など、一言で返せる質問にする。
- 「どう思いますか？」「教えてください」のような漠然とした問いは避ける。
- 質問は1つだけ。あれこれ聞かない。`

// ============================================================
// 【追加】「無料AI集客診断」への相談導線（CTA）
// ・ダイエット垢と同じ方針で「CTAはコードで確実に付与」する（プロンプト任せだと入らない/カットされるため）。
// ・Threadsは露骨なCTAの連発でリーチが落ちるので、頻度は控えめ・言い回しはローテ・あくまで柔らかく。
// ・入口は「無料AI集客診断」に統一（オファーシートの入口と一致させる）。
// ============================================================
const DIAGNOSIS_CTA = [
  "もし「うちの院でもできる？」と気になったら、プロフィールのLINEで“無料AI集客診断”をやっています。",
  "今の集客で、AIに任せられる所はどこか。プロフィールのLINEの“無料AI集客診断”で一緒に見つけられます。",
  "SNSに時間を取られている先生へ。プロフィールのLINEで“無料AI集客診断”を受け付けています。",
  "気になる方は、プロフィールのLINEに「診断希望」と一言どうぞ。“無料AI集客診断”は無料です。",
]

// CTAを付ける頻度：サービス枠は常に付与、それ以外は N 投稿に 1 回だけ（付けすぎない＝リーチを守る）
const CTA_EVERY_NTH = 5

// ローテーションでCTAを1本返す（index はグローバル通し番号などを渡す）
function pickDiagnosisCTA(index = 0) {
  const n = DIAGNOSIS_CTA.length
  return DIAGNOSIS_CTA[((index % n) + n) % n]
}

// この投稿にCTAを付けるか判定（service は常に、それ以外は N 回に 1 回）
function shouldAttachCTA({ category, globalIndex = 0 } = {}) {
  if (category === "service") return true
  return globalIndex % CTA_EVERY_NTH === 0
}

// 本文にCTAを付与（空行で区切る）。CTAが空なら本文のまま返す。
function appendCTA(text, ctaLine) {
  const body = (text || "").trim()
  const cta = (ctaLine || "").trim()
  return cta ? `${body}\n\n${cta}` : body
}

// ---- 外部情報（ネット検索）を"背景として軽く"参考にするカテゴリーと検索クエリ ----
// 日報・失敗談は個人的な内容なので検索しない。他は世の中の動き/事例を軽く踏まえる。
const WEB_QUERIES = {
  training_diary: "整骨院 サロン AI活用 ChatGPT 業務効率化 事例 最新",
  clinic_problem: "治療院 整骨院 経営 集客 SNS 課題 悩み 最新",
  ai_philosophy: "AI 仕事 人間の役割 生産性 時間の使い方 最新",
  case_study: "整体 サロン AI 業務改善 時短 SNS LINE 事例 最新",
  service: "治療院 AI導入 集客 効率化 中小 事例 最新",
}
function usesWeb(categoryKey) {
  return !!WEB_QUERIES[categoryKey]
}
function searchQuery(categoryKey) {
  return WEB_QUERIES[categoryKey] || ""
}

// ============================================================
// 選択ロジック
// ============================================================

// 直近に使ったカテゴリーを避けつつ、週次比率で重み付け抽選する
function pickCategory(recentCategories = []) {
  const pool = Object.entries(CATEGORIES).filter(([, c]) => c.weight > 0)
  // 直近2件と同じカテゴリーは避ける（在庫があれば）
  const recent = recentCategories.slice(-2)
  let candidates = pool.filter(([key]) => !recent.includes(key))
  if (candidates.length === 0) candidates = pool
  const total = candidates.reduce((s, [, c]) => s + c.weight, 0)
  let r = Math.random() * total
  for (const [key, c] of candidates) {
    r -= c.weight
    if (r <= 0) return key
  }
  return candidates[0][0]
}

function pickKosei(categoryKey) {
  const cat = CATEGORIES[categoryKey]
  const list = (cat && cat.kosei && cat.kosei.length) ? cat.kosei : Object.keys(KOSEI)
  return list[Math.floor(Math.random() * list.length)]
}

// ============================================================
// プロンプト生成
// ============================================================

// metrics: metrics_aisupport.json の中身（事実のみ）。無ければ null
// avoidTexts: 直近投稿の本文配列（重複回避のためモデルに提示）
function buildPrompt({ categoryKey, koseiKey, metrics = null, avoidTexts = [], engagementHint = "", webContext = "" }) {
  const cat = CATEGORIES[categoryKey]
  // 【今回のネタ】型とは別に具体的な話題を1つ選んで注入（金太郎飴防止の核心）
  let _topic = pickTopic([..._usedTopicsThisRun])
  if (_usedTopicsThisRun.size >= TOPICS.length) _usedTopicsThisRun = new Set()
  _usedTopicsThisRun.add(_topic.id)
  const topicSection = "\n【今回はこのネタで書く（毎回ここが変わる。必ずこの話題に沿い、他のネタに逃げない）】\n■ " + _topic.t + "\n※指定ネタ以外の話（例：LINE返信・初診質問など指定外）に流れないこと。指定ネタを具体的な一場面に落として書く。\n"
  const usesMetrics = ["case_study", "daily_report"].includes(categoryKey)

  let metricsSection = ""
  if (usesMetrics) {
    if (metrics && Object.keys(metrics).length > 0) {
      metricsSection = `
【使える実績データ（事実。ここに書かれた数字だけ使ってよい。無い数字は作らない）】
${JSON.stringify(metrics, null, 2)}
※「業務別実績」がある場合は、今回の投稿に合う業務を1つだけ選び、その実測値（自動化前/後の分・頻度・使い道）だけを使う。他の業務の数字と混ぜない。
`
    } else {
      metricsSection = `
【実績データ】
具体的な数字は提供されていません。数字を創作せず、時間や手間が「減った」といった定性的な表現にとどめてください。
`
    }
  }

  const avoidSection = avoidTexts.length > 0 ? `
【直近の投稿（冒頭・主張・具体例・質問が似ないように。必ず違う切り口で）】
${avoidTexts.slice(0, 12).map((t, i) => `--- ${i + 1} ---\n${t}`).join("\n\n")}
` : ""

  const hintSection = engagementHint ? `\n${engagementHint}\n` : ""
  const webSection = webContext ? `
【参考情報（ネット検索の要約。背景として"ゆるく"参考にするだけ）】
${webContext}
※そのままコピーしない。数字・研究の羅列や引用にしない。断定もしない。あなた自身の体験・実感に絡めて、必要なら自然に一言ふれる程度でよい（無理に入れなくてもよい）。
` : ""

  return `${WORLDVIEW}

${AUDIENCE}

${cat.prompt}
${topicSection}
【今回の文章構成】${KOSEI[koseiKey]}
${metricsSection}${avoidSection}${hintSection}${webSection}
${HOOK_RULES}

${GLOBAL_RULES}`
}

// ============================================================
// 反応データからの学習（いいね・返信が良かった傾向を抽出）
// ============================================================

// history の各要素に insights:{views,likes,replies,...} が付いている前提で、
// カテゴリー別の平均反応スコア（返信を重視）を高い順に返す
function categoryPerformance(history = []) {
  const agg = {}
  for (const h of history) {
    if (!h.category || !h.insights) continue
    const ins = h.insights
    const score = (ins.likes || 0) + (ins.replies || 0) * 2 + (ins.reposts || 0) * 2
    if (!agg[h.category]) agg[h.category] = { n: 0, score: 0, likes: 0, replies: 0, views: 0 }
    const a = agg[h.category]
    a.n++; a.score += score; a.likes += ins.likes || 0; a.replies += ins.replies || 0; a.views += ins.views || 0
  }
  return Object.entries(agg)
    .map(([category, a]) => ({ category, n: a.n, avgScore: a.score / a.n, avgLikes: a.likes / a.n, avgReplies: a.replies / a.n, avgViews: a.views / a.n }))
    .sort((x, y) => y.avgScore - x.avgScore)
}

// 十分なデータが溜まったら、伸びているカテゴリーへ寄せるヒント文を返す（少ないうちは空）
function buildEngagementHint(history = [], minSamples = 15) {
  const withInsights = history.filter((h) => h.insights)
  if (withInsights.length < minSamples) return ""
  const rows = categoryPerformance(history).filter((r) => r.n >= 2)
  if (rows.length < 2 || rows[0].avgScore <= 0) return ""
  const top = rows.slice(0, 2).map((r) => CATEGORIES[r.category] && CATEGORIES[r.category].label).filter(Boolean)
  if (top.length === 0) return ""
  return `【これまで反応（いいね・返信）が良かった傾向】「${top.join("」「")}」系の投稿が伸びています。今回もこの方向の切り口・トーン・情景を意識してください。`
}

// ============================================================
// 品質チェック / 重複判定（純関数）
// ============================================================

const BUSINESS_TERMS = ["SNS", "LINE", "Google", "グーグル", "マップ", "ブログ", "投稿", "予約", "口コミ", "カルテ", "集客", "事務", "会計", "返信", "DM", "リマインド", "キャンセル", "ホームページ", "チラシ", "メニュー", "カウンセリング", "患者", "施術", "問い合わせ", "アンケート", "下書き", "配信", "告知", "キャンペーン", "発信",
  // その他業務（事務・数字・シフト・スタッフ・労務・物販）— 幅を広げたネタが品質チェックで弾かれないように
  "売上", "来院", "データ", "シフト", "スタッフ", "給与", "明細", "勤怠", "労務", "在庫", "発注", "経費", "レシート", "請求", "領収", "採用", "募集", "面接", "マニュアル", "朝礼", "評価", "フォロー", "再来", "物販", "問診", "同意書", "決算", "数字"]
const HARD_SELL = ["お問い合わせください", "お申し込み", "申し込みは", "購入", "今すぐ登録", "期間限定", "割引", "販売中", "お申込み", "ご登録ください"]
// 医療・成果の断定は薬機法/医療広告ガイドライン上NG。ただし「絶対に手放したくない」等の無害な用法まで
// 弾かないよう、必ず/絶対/100%は"成果語が近くにある時だけ"NGとする。
const MEDICAL_BANNED = ["治る", "完治", "確実に", "保証します"]
const STRONG_WORDS = ["必ず", "絶対", "100%"]
const OUTCOME_RE = /(治|痩|瘦|太|増え|集客|予約|成果|効果|儲|売上|来院|新規)/

function charCount(text) {
  return [...(text || "").trim()].length
}

function hasQuestion(text) {
  return /[?？]/.test(text || "")
}

// 品質チェック。ok=false なら reasons に理由。
function qualityCheck(text, { history = [], category = "" } = {}) {
  const reasons = []
  const t = (text || "").trim()
  const len = charCount(t)

  // 「AI活用の考え方」は"短く強いメッセージ"が方針なので下限を緩め、業務語も必須にしない
  const isPhilosophy = category === "ai_philosophy"
  const minLen = isPhilosophy ? 45 : 75
  if (len < minLen) reasons.push(`短すぎ(${len}字)`)
  if (len > 270) reasons.push(`長すぎ(${len}字)`)
  if (!isPhilosophy && !BUSINESS_TERMS.some((w) => t.includes(w))) reasons.push("具体的な業務語が無い（抽象的すぎ）")

  const hardSellHit = HARD_SELL.filter((w) => t.includes(w))
  if (hardSellHit.length > 0) reasons.push(`売り込みが強い(${hardSellHit.join("/")})`)

  const medHit = MEDICAL_BANNED.filter((w) => t.includes(w))
  if (medHit.length > 0) reasons.push(`医療・断定表現(${medHit.join("/")})`)
  // 必ず/絶対/100% は"成果語"が同じ投稿にある時だけ成果の断定としてNG
  const strongHit = STRONG_WORDS.filter((w) => t.includes(w))
  if (strongHit.length > 0 && OUTCOME_RE.test(t)) reasons.push(`成果の断定(${strongHit.join("/")})`)

  // 絵文字は0〜2個
  const emojiCount = (t.match(/\p{Extended_Pictographic}/gu) || []).length
  if (emojiCount > 2) reasons.push(`絵文字が多い(${emojiCount})`)

  // ハッシュタグ・見出し記号
  if (/#|＃/.test(t)) reasons.push("ハッシュタグ/#がある")

  // 重複チェック（過去30日）
  const dup = findDuplicate(t, history, 30)
  if (dup) reasons.push(`過去投稿と類似(${Math.round(dup.score * 100)}%)`)

  return { ok: reasons.length === 0, reasons, len, hasQuestion: hasQuestion(t) }
}

// 文字bigramのJaccard類似度
function normalize(text) {
  return (text || "").replace(/\s+/g, "").replace(/[、。！？!?「」（）()・…]/g, "")
}
function bigrams(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}
function similarity(a, b) {
  const A = bigrams(normalize(a))
  const B = bigrams(normalize(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

// history: [{text, postedAt|createdAt}]。days日以内で類似度0.55超があれば返す
function findDuplicate(text, history = [], days = 30) {
  const now = Date.now()
  const windowMs = days * 24 * 60 * 60 * 1000
  let best = null
  for (const h of history) {
    const ts = Date.parse(h.postedAt || h.createdAt || "") || now
    if (now - ts > windowMs) continue
    const score = similarity(text, h.text || "")
    if (score >= 0.55 && (!best || score > best.score)) best = { score, text: h.text }
  }
  return best
}

module.exports = {
  TOPICS, pickTopic,
  WORLDVIEW, AUDIENCE, CATEGORIES, KOSEI, GLOBAL_RULES, HOOK_RULES,
  DIAGNOSIS_CTA, CTA_EVERY_NTH, pickDiagnosisCTA, shouldAttachCTA, appendCTA,
  pickCategory, pickKosei, buildPrompt,
  usesWeb, searchQuery, WEB_QUERIES,
  categoryPerformance, buildEngagementHint,
  qualityCheck, similarity, findDuplicate, charCount, hasQuestion,
}
