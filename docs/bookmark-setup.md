# 簡易ブックマークの設定（iPhone・PC）

読みたい記事を 1 操作で Viewer に保存するための設定。保存した時点ではスライド等は作られない。
常駐プロセスが動いていれば、あとから 3 行要約とタイトルが付く（`INBOX_SUMMARY_ENABLED=true` のとき）。

| 入口 | しくみ | PC が止まっていても保存できるか |
|---|---|---|
| iPhone の共有メニュー | ショートカット → GitHub → 記事を登録 | できる |
| PC のブックマークバー | ボタン → Viewer の小窓 → 依頼キュー → 常駐プロセスが登録 | できない（常駐プロセスが必要） |

## 1. iPhone：共有メニューから 1 タップで保存する

### 1.1 GitHub のアクセストークンを作る（最初の 1 回）

1. GitHub の Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token。
2. Repository access は **Only select repositories** にし、`lomoxiao/article-to-slides-automation` だけを選ぶ。
3. Repository permissions は **Contents: Read and write** だけにする。ほかは付けない。
   - `repository_dispatch` を送るのに必要な権限。足りない場合、GitHub の応答ヘッダー
     `X-Accepted-GitHub-Permissions` に必要な権限が出るので、それに合わせる。
4. 有効期限を設定する（例: 90 日）。期限が切れると保存できなくなるので、切れる前に作り直す。
5. 表示されたトークンを控える（この画面でしか見られない）。

注意: このトークンはショートカットの中に保存される。漏れた場合に操作されるのはこのリポジトリだけだが、
内容の書き換えもできる権限なので、iPhone のショートカットを人に共有しないこと。不要になったら GitHub 側で削除する。

### 1.2 ショートカットを作る

「ショートカット」アプリで新規作成し、次の順にアクションを並べる。

1. 詳細（ⓘ）で **共有シートに表示** をオン。受け取る種類は「URL」「Safari の Web ページ」。
2. **URL の内容を取得**
   - URL: `https://api.github.com/repos/lomoxiao/article-to-slides-automation/dispatches`
   - 方法: `POST`
   - ヘッダー: `Authorization` = `Bearer <控えたトークン>`、`Accept` = `application/vnd.github+json`
   - 本文を要求: `JSON`
     - `event_type`（テキスト）= `register-article`
     - `client_payload`（辞書）
       - `url`（テキスト）= ショートカットの入力（共有された URL）
       - `title`（テキスト）= ショートカットの入力の「名前」（取れない場合は空でよい）
       - `from`（テキスト）= `shortcut`
3. **通知を表示**: 「Viewer に保存しました」

使い方: Safari などで共有 → このショートカットを選ぶ。Viewer は開かない。
GitHub 側の処理に 1 分ほどかかるので、Viewer に出るまで少し待つ。

うまくいかないとき: GitHub のリポジトリの Actions タブで「Register Article」の実行結果を見る。
実行自体が無い場合は、トークンの権限か期限を確かめる。

## 2. PC：ブックマークバーのボタンで保存する

### 2.1 ボタンを作る（最初の 1 回）

ブラウザのブックマークバーに新しいブックマークを作り、名前を「Viewerに保存」、URL を次の 1 行にする。

```
javascript:(function(){window.open("https://lomoxiao.github.io/multimodal-article-viewer/?save="+encodeURIComponent(location.href)+"&title="+encodeURIComponent(document.title),"viewer-save","width=420,height=280");})();
```

### 2.2 使い方

保存したいページでボタンを押す。小さな窓が開き、「Viewer に保存しました」と出て自動で閉じる。

- 初回や、Viewer にサインインしていないときは、小窓にサインイン画面が出る。サインインすると保存が続く。
- 小窓が出ない場合は、ブラウザのポップアップブロックでこのサイトを許可する。
- 常駐プロセスが止まっていると、依頼は待ち行列に残り、次に起動したときに登録される。

## 3. 保存した記事はどこに出るか

Viewer の一覧に「未着手」の記事として出る（画面下のタブを入れたあとは「受信箱」）。
詳細から、あとでスライド・漫画・動画の生成や、束への追加ができる。

3 行要約を付けるには、常駐プロセスの `.env` に次を設定して再起動する。

```
INBOX_SUMMARY_ENABLED=true
```

- 保存した記事のうち、まだ何も生成しておらず、要約の無いものが対象。10 分ごとに最大 3 件ずつ処理する。
- 本文が取れないサイトの記事は、要約の代わりに「本文が取れていません（理由）」が出る。その記事は再試行しない。
