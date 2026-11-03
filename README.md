# Books Book!（最終版）

漫画の新刊・発売予定を管理するWebアプリ。v2 の UI（タブ＋本棚デザイン）に、Supabase 認証とクラウド同期を組み込んだ統合版です。

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` | 画面構造（ログイン画面＋アプリ本体） |
| `styles.css` | デザイン |
| `app.js` | アプリ本体（補完高速化・ショートカット・表紙拡大を含む） |
| `auth.js` | Supabase ログインとクラウド同期（保存キュー） |
| `config.js` | Supabase URL と公開用キー（publishable key のみ） |
| `sw.js` / `manifest.webmanifest` | PWA |
| `favicon.svg` | アイコン |

## データの扱い

- 蔵書データ（作品・発売予定・通知日数）はログイン中のアカウントのクラウドデータが正
- Google Books APIキー・Discord Webhook・自動通知のオン/オフは端末ごとの保存
- 初回ログイン時、このブラウザに旧バージョンのローカルデータがあれば、クラウドへ取り込むか確認が出ます

## 公開方法

GitHub Pages: Settings → Pages → Source を「Deploy from a branch」、ブランチ `main` / `(root)` に設定。

PNG アイコン（icon-192.png / icon-512.png）は任意です。置くと PWA のインストールアイコンが整います（無くても動作します）。
