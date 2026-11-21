# 夜間の自動生成（受信箱の記事のスライド）

条件は brain Vault の `projects/catchup-platform/questions.md` P003（2026-11-21 の本人の回答）、タスクは T007。

## 何をするか

保存しただけで何も作っていない記事（受信箱の記事）のうち、その日に登録されたものについて、夜のうちにスライドを作る。
朝には記事一覧にスライドができている状態にする。

| 項目 | 決めたこと |
|---|---|
| 対象 | その日に登録された記事。0〜5 時の夜なら、前日 0〜24 時（日本時間）に登録された記事 |
| 時間帯 | 24 時〜5 時（`NIGHTLY_SLIDES_START_HOUR_JST=0`・`NIGHTLY_SLIDES_END_HOUR_JST=5`） |
| 本数 | 一晩に最大 5 本（`NIGHTLY_SLIDES_MAX`） |
| 外す記事 | 本文が取れなかった記事、3 行要約がまだの記事、削除した記事、1 日のまとめ、テキスト・束・深掘り |
| 作るもの | スライドだけ。自動で作った印は付けない |
| 記事ごとの除外 | 設けない |
| 前提 | PC と常駐プロセスがその時間も動いている |
| Codex の使用量の上限 | 見ない（本人の指示） |

## 仕組み

`src/requests/nightlySlides.ts`。常駐プロセスが 10 分ごとに確かめる。

1. 時間帯の外なら何もしない
2. 受信箱の記事から対象を選ぶ（登録の古い順）。その夜にすでに試した記事は外す
3. 1 本ずつ、Viewer からの URL の依頼と同じ処理（`handleUrlRequest`、スライドだけ）で作る。
   Viewer からの依頼と同じ順番待ち（`runInRequestQueue`）に並ぶので、同時に Codex が動くことはない
4. 1 本ごとに結果を `.runtime/nightly-slides.json` に書く。失敗した記事もその夜の本数に数え、同じ夜には繰り返さない
5. 5 時を過ぎたら新しく始めない（作っている途中の 1 本は最後まで作る）

本文が取れなかった記事は、受信箱の 3 行要約づくりの段階で「本文が取れていません」になり、要約が付かないので対象に入らない。

## 使い始め方

1. `.env` に `NIGHTLY_SLIDES_ENABLED=true` を足す（`INBOX_SUMMARY_ENABLED=true` も必要。要約が付いた記事だけが対象のため）
2. 常駐プロセスを再起動する。起動ログに `[nightly-slides] slides for today's inbox articles at 0:00-5:00 JST (up to 5 per night)` が出る
3. 翌朝、記事一覧にスライドができていることと、ログの `[nightly-slides] {"night":…,"done":…}` を確かめる

## 止め方

`.env` の `NIGHTLY_SLIDES_ENABLED=false` にして再起動する。
