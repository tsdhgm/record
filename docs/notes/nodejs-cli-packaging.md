# Node.js 製 CLI の配布とパッケージ化 — なぜ `claude` は `node` と打たずに動くのか

学習ノート（2026-07-09）。ADR-0007（実装言語の事後追認）の補足資料。
「AI エージェント CLI は npm でインストールする JavaScript 製が多いが、
`node` から起動せずに済むのはなぜか。Node 自体を不要にするパッケージ化はあるのか」
という疑問への整理。

## 1. `claude` と打つだけで動く仕組み（Node は必要）

npm パッケージの `package.json` にある `bin` フィールドが鍵:

```json
"bin": { "claude": "./cli.js" }
```

`npm install -g` すると、npm が PATH の通った場所（`~/.npm-global/bin` 等）に
**シンボリックリンク**を作る。スクリプト先頭の shebang 行:

```js
#!/usr/bin/env node
```

を OS が解釈して、自動的に node で起動する。Windows では npm が `claude.cmd` という
薄いラッパー（シム）を生成して同じことをする。
つまり「node と打たなくていい」だけで、**裏では毎回 node が起動している**。

本リポジトリの record も `"bin": {"record": "./bin/record.mjs"}` を持っており、
`npm link`（または `npm install -g .`）で `record claude` と打てるようになる。
同じ慣習に乗っている。

## 2. Node.js 自体を不要にする方法（ランタイム同梱の単一実行ファイル）

| 方法 | 仕組み | 特徴 |
|---|---|---|
| **Node SEA**（公式、Node 20+） | node バイナリのコピーにスクリプトを埋め込む | 公式機能だがまだ手作業が多い |
| **Bun** `bun build --compile` | Bun ランタイム同梱の単一バイナリを生成 | 現在の主流。クロスコンパイル可 |
| **Deno** `deno compile` | 同上（Deno ランタイム） | 手軽だが npm 互換に癖 |
| pkg / nexe | 旧世代のツール | pkg は開発終了（コミュニティフォークが継続） |

**Claude Code 自体がこの 2 段構え**である。当初は npm 配布
（`npm install -g @anthropic-ai/claude-code`、要 Node）だったが、現在推奨の
native installer（`curl ... | bash`）は**ランタイムを同梱した実行ファイル**を
配布するため、Node が入っていないマシンでも動く。
「JavaScript 製なのに Node のインストールが要らない」はこうして実現されている。

## 3. 代償と使い分け

- **サイズ**: ランタイム同梱のため 1 バイナリ 50〜100MB 級になる。
- **ネイティブモジュール問題**: record がまさに該当する。`node-pty` は C++ アドオン
  （`.node` ファイル）で単一バイナリへの埋め込みが難しく、プラットフォーム別の
  ビルド・同梱が必要になる。一方 record の `convert` / `--follow` は pure JS なので、
  そこだけなら `bun build --compile` で単一バイナリ化できる。
- **対象が開発者なら npm のままが楽**: 開発者はほぼ Node を持っており、npm は
  バージョン管理・更新も担う。native installer は非開発者にリーチしたくなった
  段階の投資。

## まとめ

「CLI なのに JavaScript」への違和感（ADR-0007）と同根の話。
**shebang + npm bin で「見た目は普通のコマンド」にし、必要になったら Bun 等で
ランタイムごと固めて「本物の単一バイナリ」にする** — これが現在の JS 製 CLI の
標準的な成長経路である。
