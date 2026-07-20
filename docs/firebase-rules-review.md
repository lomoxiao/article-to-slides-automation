# Firebase Realtime Database Rules レビュー

実施: 2026-07-20（リファクタリング観点 B-5）
方法: `db.getRules()` でライブ Rules を取得してレビュー（このリポジトリに Rules の正本は置かない。
更新は `src/scripts/updateDatabaseRules.ts` の「ライブ取得→マージ→PUT」経路のみ）。

## 結論

**デフォルト deny が成立している。** ルート直下に `.read`/`.write` の許可はなく、全パスが
認証必須。未認証で読み書きできるパスは存在しない。書き込みはオーナー制 or
editors/viewers 許可リスト制で、自動化パイプラインの書き込みはすべて Admin SDK
（Rules バイパス）経由。

## パス別サマリ

| パス | read | write（クライアント） | 備考 |
|---|---|---|---|
| homeworkJobsV3 | オーナーのみ（クエリもオーナー限定） | オーナーのみ。ownerUid/sourceImage/createdAt は不変 | homework-manga v3 用 |
| articles | viewers | slides/manga/updatedAt/deletedAt/deletedBy の子のみ editors。URL プレフィックス・origin=manual・locked=true を検証 | 記事本体の生成・削除は Admin のみ |
| readState | 本人のみ | 本人 + viewers。state は read/later のみ | |
| artifactDiagnostics | editors | 不可（Admin のみ） | |
| access | 不可（自分のフラグのみ読める） | 不可（Admin のみ） | 許可リスト自体の管理は Admin |
| airflow | editors | editors（サブツリー全体） | tasks の status/runner は enum 検証 |
| generationRequests | オーナーのみ | viewers による新規作成のみ（owner=自分・status=queued・trigger=web を強制）。更新・削除は不可 | 消化は Admin の watcher |
| articleSources | viewers | 不可（Admin のみ) | |
| sessionStatus | viewers | 不可（Admin のみ） | |

## Admin SDK 書き込みの経路（コード側の統制）

Admin SDK は Rules をバイパスするため、書き込みはパスごとの専任モジュールに限定する
（任意パス書き込みのユーティリティは作らない）。2026-07-20 時点の対応:

| パス | 専任モジュール |
|---|---|
| /articles, /articleSources, /artifactDiagnostics | `src/shared/firebaseArticleStore.ts` |
| /sessionStatus | `src/shared/sessionStatusStore.ts` |
| /generationRequests | `src/domains/slides/generationRequestWatcher.ts` |
| Rules 自体 | `src/scripts/updateDatabaseRules.ts`（マージ+バックアップ方式のみ） |

## 改善候補（未適用・要判断）

1. `generationRequests/$requestId` に `"$other": { ".validate": false }` を追加し、
   検証対象外の未知キーの書き込みを拒否する（現状は kind/text/slides/createdAt 以外の
   キーも作成時に書ける）。
2. `airflow` は editors にサブツリー全体の write を許可しており広め。運用者が少数の
   信頼済みメンバーである前提なら現状維持で妥当。

いずれも攻撃面は「認証済み viewers/editors」に限られるため緊急性は低い。
適用する場合は `updateDatabaseRules.ts` のパッチ経路で行うこと。
