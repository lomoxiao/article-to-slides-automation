# Instapaper → Kobo Phase 0 PoC

目的は、認証付きリーダーURLとAPIで直接渡したHTML本文から作った記事が、KoboのInstapaper Homeへ同期されることを確認することです。Phase 0では本番の生成パイプラインには接続しません。

## 現在の進捗（2026-09-06）

- OAuth 1.0aクライアント、xAuthトークン取得CLI、2方式のPoC送信CLIを実装済み
- URL + content、Private Source、OAuth署名、APIエラーの自動テストに合格
- 型検査、全自動テスト、lint、資格情報なしのドライランに合格
- URL + content方式は実アカウントへ送信済み（bookmark ID: `2039364107`）で、Kobo実機の同期・日本語本文表示に合格
- Private Source方式も比較送信済み（bookmark ID: `2039364563`）で、Kobo実機への同期に合格
- Phase 0合格。元記事への導線を保てるURL + content方式を本番方式として採用

## 1. Consumer token

Instapaper Full APIのconsumer key / secretを申請し、承認後に`.env`へ設定します。

```dotenv
INSTAPAPER_CONSUMER_KEY=...
INSTAPAPER_CONSUMER_SECRET=...
```

consumer tokenの発行はInstapaper側の人手審査です。

## 2. Access token

パスワードは`.env`に保存しません。CLIの対話入力を使い、xAuth交換時だけInstapaperへ送信します。

```powershell
npm run instapaper:token
```

`Instapaper username/email:`にはログイン用メールアドレス、`Instapaper password:`にはパスワードを入力します。パスワードは画面に表示されません。

出力されたaccess token / secretだけを`.env`へ追加します。

```dotenv
INSTAPAPER_ACCESS_TOKEN=...
INSTAPAPER_ACCESS_TOKEN_SECRET=...
```

## 3. URL + content方式

資格情報を使わない事前確認:

```powershell
npm run instapaper:poc:dry-run
```

実送信:

```powershell
npm run instapaper:poc
```

同じURLを使うため、再実行時はInstapaper上の既存ブックマークが更新され、Home先頭へ移動する想定です。

## 4. Private Source比較

```powershell
npm run instapaper:poc:private
```

Kobo公式仕様では一部の保存形式が同期対象外です。Private Source方式は、実際にKobo Homeへ現れるかを比較確認する目的だけで使用します。

## 合格条件

- URL + content方式の記事がKoboのHomeへ同期される
- 日本語タイトル、見出し、段落、箇条書きが欠落しない
- 文字サイズ変更、ページ送り、アーカイブ、お気に入りが動作する
- 同じURLの再送で不要な重複記事が作られない
- 認証付きURLをInstapaperが直接取得できなくても、渡したHTML本文が表示される

結果を確認したら、この文書へ実施日、Kobo機種、ファームウェア、URL + content結果、Private Source結果を追記します。

## 本番統合（Phase 1〜3）

PoC合格後、次を実装しています。

- 共通のKobo向けHTML生成（19px、行間1.85、最大42rem、ダークモード、3行要約、元記事リンク）
- Viewerの`?reader=<articleId>`パーマリンクと、認証後の保存本文直接表示
- スライド生成完了後のInstapaper Full API `bookmarks/add`（Reader URL + `content`）
- 本文・タイトル・要約が同一の場合の重複送信防止
- 送信障害をスライド生成の成否から分離するbest-effort実行
- 送信状態は`/instapaperDeliveries/{articleId}`へ保存し、資格情報と本文は保存しない

自動送信は明示的に有効化します。

```dotenv
INSTAPAPER_AUTO_SEND=true
READER_BASE_URL=https://lomoxiao.github.io/multimodal-article-viewer/
```

4つのOAuth資格情報がそろっていない場合は送信をスキップします。`READER_BASE_URL`を変更すると、同じ本文でも新しいReader URLとして再送されます。
