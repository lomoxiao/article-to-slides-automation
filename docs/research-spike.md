# 深掘りリサーチの事前確認（段階7 の T0）

作成: 2026-11-21
目的: 固定課金の Codex / Claude Code で Web 検索が使え、出典 URL が実在するかを、実装の前に確かめる。
計画書: `docs/catchup-stage7-plan.md` の 3 章。**この確認の結果を見て、本人と方式を決めてから実装に進む。**

## 比べる候補

| 候補 | 実行のしかた | ファイル・コマンド | Web の扱い |
|---|---|---|---|
| `codex-cached` | `codex exec --sandbox read-only -c web_search="cached"` | 変更・実行できない | OpenAI が管理する検索インデックスの結果だけ。ページをその場では開かない |
| `codex-live` | `codex exec --sandbox read-only -c web_search="live"` | 変更・実行できない | その場で検索・取得する |
| `claude` | `claude -p --allowedTools WebSearch,WebFetch --disallowedTools Bash Edit Write Read …` | 禁止 | その場で検索・取得する |

- 公式の説明（2026-11-21 確認）
  - Codex: 既定の Web 検索は "cached"。インデックス済みの結果を返すため、任意のページからの指示の混入（プロンプトインジェクション）にさらされにくい。それでも結果は信頼できない入力として扱う。"live" はその場で取得する。
    https://developers.openai.com/codex/agent-approvals-security
  - Codex のサンドボックスは `read-only` / `workspace-write` / `danger-full-access`。
    https://developers.openai.com/codex/cli/reference
  - Claude Code の非対話実行（`-p`）では、`--allowedTools` で許可したツールだけを確認なしで使う。
    https://code.claude.com/docs/en/headless
- どの候補も、Web から来た文章を「ファイルを書き換えられる AI」に渡さない作りにしてある（段階7 計画の 12 章）。
- 使うのは固定課金の枠（Codex / Claude Code のログイン）だけ。API キーは使わない。

## 実行のしかた（本人の PC で）

常駐プロセスが生成中でないときに、`article-to-slides-automation` のフォルダで次を実行する。

```
npm run research:spike
```

- 3 候補 × 3 問で 20〜40 分ほどかかる見込み。一部だけ試すときは、例えば次のようにする。
  ```
  npm run research:spike -- --only codex-cached --questions 1
  ```
- 結果は `docs/research-spike-results.md`（表）と `jobs/research-spike/<日時>/`（AI の出力そのもの）に出る。
- Firebase への書き込みや Slack 通知はしない。

## 結果の見方

| 見るところ | 目安 |
|---|---|
| 失敗 | 0 が望ましい。失敗の理由が「Web 検索が使えない」なら、その候補は使えない |
| 挙げた事実 | 1 問あたり 5 件以上 |
| 取得できた割合 | 出典 URL のうち実際に取得できた割合。**70% 以上**を目安にする（実在しない URL を作る候補は使わない） |
| 平均秒 | 1 問 5 分以内なら実用の範囲 |

取得できなかった出典の一覧も出る。「サイトに拒否された（403）」は URL 自体は実在する可能性が高く、
「見つからない（404）」や接続できないものが多い場合は、URL を作っている疑いがある。

## 次の判断

結果を見て、本人と次を決める。

1. 使う候補（取得できた割合・速さ・内容の質で選ぶ。`codex-cached` で足りるなら、混入のリスクが低いのでそれを優先する）
2. どの候補も使えない場合の代わり（例: 調べる URL を人が渡し、AI は取得済みの本文だけをまとめる）
