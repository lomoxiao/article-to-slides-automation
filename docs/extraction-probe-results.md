# 取り込み計測の結果（段階1）

実行: 2026-11-16 00:14〜00:17 JST、`npm run extraction:probe -- docs/extraction-probe-urls.txt`
対象: `docs/extraction-probe-urls.txt` の 15 本（A 群 5、B 群 4、C 群 6）。
実装前の状態での計測は行っていない。「以前」の列はジョブ履歴（`jobs/`）に残っていた値。

## 結果

| 群 | サイト | 以前（ジョブ履歴） | Chrome の名乗り（既定） | 従来の名乗り |
|---|---|---|---|---|
| A | bvnk.com | 0 文字で完了扱い | full / 15,422 | full / 15,422 |
| A | izanami.dev | 0 文字で完了扱い | failed / 0（too_short） | failed / 0（too_short） |
| A | thequantuminsider.com | 91 文字（別記事）で完了扱い | full / 8,481 | full / 8,481 |
| A | reddit.com | 37 文字で完了扱い | failed / 0（too_short） | failed / 0（too_short） |
| A | business20channel.tv | 209 文字で完了扱い | full / 15,472 | full / 15,472 |
| B | businesswire.com | タイムアウト | failed（http_403、0.4 秒） | failed（timeout、30 秒） |
| B | openai.com | 403 | failed（http_403） | failed（http_403） |
| B | aiindex.stanford.edu（PDF） | 403 | failed / 200（too_short） | failed / 200（too_short） |
| B | arxiv.org/html | ID 抽出不可 | full / 42,175 | full / 42,175 |
| C | note.com | 全文 | full / 7,657 | full / 7,657 |
| C | zenn.dev | 全文 | full / 13,942 | full / 13,942 |
| C | qiita.com | 全文 | full / 5,825 | full / 5,825 |
| C | x.com | 全文 | full / 13,554（約 50 秒） | full / 13,554（約 40 秒） |
| C | youtu.be | 全文 | full / 10,232 | full / 10,232 |
| C | arxiv.org/pdf | 全文 | full / 55,441 | full / 55,441 |

集計はどちらの名乗りでも full=10、failed=5。

## 読み取れること

1. **関門は機能している。** 本文が取れない 5 本はすべて `failed` と判定され、空の本文が「完了」になる経路はなくなった。
2. **対照（C 群）は 6 本とも full。** 今回の変更で既存の取得は壊れていない。
3. **名乗りの変更で取れるようになったサイトは、この 15 本には無い。**
   違いは businesswire.com だけで、従来は 30 秒待って時間切れ、Chrome の名乗りでは即座に 403。
   結果は同じ「取れない」だが、待ち時間は 30 秒から 0.4 秒に縮んだ。
4. **A 群の 3 本（bvnk、thequantuminsider、business20channel）は、どちらの名乗りでも全文が取れた。**
   名乗りに関係なく取れているので、今回の実装の効果ではなく、サイト側の変化か、以前の失敗が一時的だった可能性が高い。
5. **arXiv の HTML 形式 URL は取得できるようになった**（T4 の効果）。
6. **取れないまま残った 4 サイト:**
   - izanami.dev、reddit.com: 取得はできるが本文が 0 文字。画面をプログラムで描くサイトの可能性が高く、
     ブラウザでの取り直しが効く見込みがある。
   - businesswire.com、openai.com: 403。ブラウザでの取り直しが効くかは不明。
   - スタンフォードの PDF: PDF 本体を取得できず、代替の 200 文字だけが返っている。

## 未確認の点

- thequantuminsider.com の 8,481 文字が、指定した記事の本文かどうか（以前は別記事を拾っていた）。
  誤抽出の検知（title_mismatch）は反応していないが、本文の中身は目で確認していない。
- 判定が `failed` のときに実際の依頼でスライドが作られないこと（単体テストでは確認済み、実依頼では未確認）。

## 補足

- 実行時に出る `Could not parse CSS stylesheet` は、ページ解析ライブラリ（jsdom）の警告で、結果には影響しない。
