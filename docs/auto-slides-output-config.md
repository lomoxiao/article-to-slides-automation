# auto-slides-template の JSON 出力設定

`templates/auto-slides-template.md` の内容を、Codex が参照しやすい JSON 設定として整理しました。

設定ファイル:

```text
config/auto-slides-output-config.json
```

## 何を設定しているか

- 出力は `slideData` 配列のみ
- `const slideData =` や説明文を出さない
- 許可するスライドタイプ
- スライドタイプごとの必須フィールド
- パターン選定ルール
- 文字数・装飾・notes の検証ルール
- グラフ用 JSON のチャートタイプ

## 使い方

Codex が記事や論文を読むときに、この設定を参照して `slideData` 形式の JSON を生成します。

たとえば、出力は次のような配列そのものになります。

```json
[
  {
    "type": "title",
    "title": "Quantum AI の優位性をどう引き出すか",
    "date": "2026.04.29",
    "notes": "本日は、Quantum AI に関する記事の要点と社内での示唆を共有します。"
  },
  {
    "type": "agenda",
    "title": "本日の構成",
    "items": ["背景", "提案手法", "社内への示唆"],
    "notes": "まず背景を確認し、次に提案手法、最後に社内で注視すべきポイントを整理します。"
  }
]
```

## 今後の接続先

次の実装では、既存の `SlideOutline` 形式に加えて、この `slideData` 形式を Google Slides 生成処理へ渡せるようにします。

テンプレート方式では、`type` ごとに対応する Google Slides テンプレートページを複製し、プレースホルダーを置換する流れにするのが自然です。
