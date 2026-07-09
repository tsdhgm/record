# record — CLI セッションレコーダ（lossless 記録 ＋ リアルタイム可読ログ）

CLI AI ハーネス（claude 等）のセッションを、**その端末の中で**（screen / script / asciinema と同じ方式で）記録するコマンドラインツール。新しいウィンドウは開かない。

English version: [README.md](README.md) / 設計判断の記録: [docs/adr/](docs/adr/) / 開発の経緯: [docs/history.md](docs/history.md)

2 つのファイルを**同時に**出力する:

| ファイル | 内容 | 性質 |
|---|---|---|
| `<tool>-<ts>.cast` | asciicast v2（生バイト全履歴＋タイミング） | lossless 原本。ツール非依存・`asciinema play` で再生可 |
| `<tool>-<ts>.txt` | 可読テキスト（制御コード・TUI chrome 除去済み） | **リアルタイム追記**。記録中に `tail -f` や VS Code で追える |

## 使い方

```bash
# 推奨: claude をクラシックレンダラー（alt-screen 不使用の旧来型TUI）で記録する。
# 見た目・操作感は従来の claude のまま、会話が scrollback に素直に流れるので
# 可読ログの品質が最良・端末サイズ非依存・リアルタイム追記になる
node bin/record.mjs claude --settings '{"tui": "default"}'

# ~/.claude/settings.json に {"tui": "default"} を書いておけば、これだけでよい
node bin/record.mjs claude

# 現在画面のスナップショットも毎秒書き出す（VS Code で「今の画面」を常時表示する用途）
node bin/record.mjs --screen claude

# 別端末（や VS Code）からリアルタイムに可読ログを追う
tail -f .harness-log/claude-*.txt

# 既存の .cast（asciicast v2/v3 どちらでも）を可読テキスト化
node bin/record.mjs convert session.cast

# asciinema 本体で記録しつつ、可読ログだけこのツールで並走生成
asciinema rec -c claude session.cast               # 端末A
node bin/record.mjs convert --follow session.cast  # 端末B（記録終了で自動終了）
```

オプション: `-d <dir>` 出力先（既定 `.harness-log/`）、`-p <profile>` 可読化プロファイル（既定はコマンド名＋`--ax-screen-reader` の有無から自動選択）、`--no-txt` cast のみ、`--screen` 現在画面を `<base>.screen.txt` へ毎秒上書き。

## claude の 3 つの描画モードと記録品質

| モード | 指定方法 | 見た目 | 記録品質 |
|---|---|---|---|
| **classic（推奨）** | `--settings '{"tui": "default"}'` または settings.json | 従来の claude TUI（❯/●・色・ツール表示） | **最良**。alt-screen 不使用で会話が scrollback に流れる → 「scrollback 到達＝確定」の単純ロジックでリアルタイム追記・端末サイズ非依存（実測: 80×24 でバナー/メニュー/スピナー全除去・会話完全復元） |
| fullscreen（既定） | 指定なし | 同上＋alt-screen | best-effort。scroll-commit 方式（下記）。**大きい端末（≥40行）必須**。小端末では中間が描画されず原理的に欠落 |
| ax（スクリーンリーダー） | `--ax-screen-reader` | フラットテキスト（`you:`/`claude:`）。操作感は大きく変わる | classic 同様に最良。ただし対話の使い勝手が犠牲になるので、通常は classic を使う |

プロファイルは自動選択される: `--ax-screen-reader` があれば `claude-ax`、それ以外は `claude`。`claude` プロファイルは **alt-screen を一度も使わなければ classic、使えば fullscreen** と動的に判定するので、tui 設定がどこで（CLI / settings.json）行われても対応できる。

gemini / codex 等のほかの CLI は generic プロファイル（通常バッファなら同じ scrollback 確定ロジックが効く）で記録する。

## 仕組み

- **記録層**（ツール非依存・lossless）: pty の生バイトを asciicast v2 でイベント追記。
  画面から流れて・消されて見えなくなった行も、書かれた瞬間のバイトとして残る。
- **可読化層**（通常バッファ = scrollback 到達コミット）: `@xterm/headless` に生バイトを
  食わせ、**scrollback に押し出された行＝アプリがもう書き換えられない＝確定**として
  その瞬間に追記する。classic モードの claude・bash・多くの CLI はこれで完全に取れる。
- **可読化層（alt-screen = scroll-commit 方式、best-effort）**: fullscreen TUI 向け。
  **スクロールで画面から破棄される瞬間の行**をフックで捕まえて確定する。
  - `CSI S`(SU) 適用前にスクロール領域(DECSTBM)先頭の破棄行をコミット
  - 領域底での改行スクロールは、`\n` 直前でデータを分割し書き込み前に判定してコミット
  - alt-screen 退出(`?1049l`)直前・終了時に、画面に残った行を snapshot
  物理行を**元の並び・インデント・アンカー（`❯`=ユーザー / `●`=アシスタント）付き**で
  1 回ずつ復元する（同一内容の繰り返し行も畳まれない）。
- **chrome 除去**: 起動バナー・ダイアログ・スピナー・罫線・補完メニュー等をプロファイル
  （`lib/profiles.mjs`）のパターンで除去。ツールごとの知識はすべてこの層に閉じ込める。
- **入力ボックス断片フィルタ**（claude プロファイル）: 巨大テキストをペーストすると、
  送信前の入力ボックス内プレビューがスクロールし、その断片が「送信前に・順序も狂って」
  コミットされてしまう（実測: 1783 行ペーストで冒頭に 42 行の重複断片）。
  claude はユーザー入力系を専用の背景色（入力ボックス/エコー `#373737`、bash モード
  `#413c41`）で描くので、**入力背景色の連続ブロックはアンカー（`❯`/`!`）で始まる場合のみ
  本文（送信済みエコー）とみなし、アンカー無しのブロックは捨てる**。
  背景色はダークテーマ実測値（`lib/profiles.mjs` の `inputBgs`）。

## なぜ asciinema の txt 変換を使わないか

asciinema 3.x の `convert -f txt` は最終画面バッファのダンプであり、
claude のような alt-screen ＋スクロール領域再描画型 TUI では
**会話本文がほぼ全て失われる**（実測: 冒頭ダイアログのみ残り会話は消失）。
本ツールの可読化層は「行が確定する瞬間」を捕まえることでこれを回避する。

## asciicast 対応状況

- 書き込み: v2（`asciinema play` / agg 等でそのまま利用可）
- 読み込み（convert / --follow）: v2 ＋ v3（asciinema 3.x の既定形式。
  v3 の `x`(exit) イベントで --follow は自動終了する）
- zstd 圧縮された `.cast.zst` は未対応（`zstd -d` してから渡す）

## 制約（既知）

- 可読化は best-effort。**TUI が端末に描画した行しか原理的に取れない**。
- fullscreen モード限定の制約:
  - スクロールせず**同一位置の上書き再描画**で消えた行は取れない（実測: 26 行中 1 行）。
  - **端末は十分に大きく（目安: 40 行以上）**。小さい端末（実測: 80×24）では claude の
    レンダラがスクロールをほぼ使わず、速い応答の中間部分を**端末に一度も描画しない**
    （実測: 40 項目中 19 項目が cast の生ストリームに不存在＝どんな端末レコーダでも不可）。
  - TUI 内履歴スクロール（ユーザーが遡る操作）で再表示された行が重複コミットされ得る
    （実測: 17 分の実開発セッションで 3 行/201 行）。
  - → **classic モード（`tui: "default"`）を使えばこれらは全て起きない。**
- claude プロファイルの chrome パターンは claude のバージョン更新で崩れ得る
  （その場合も `.cast` 原本は無傷なので、パターン修正後に convert し直せる）。
- scrollback 10 万行を超える長大な通常バッファセッションでは、確定済みインデックスが
  ずれる（xterm が先頭行を捨てるため）。
- 完全クリーンな会話ログが必要な場合は claude の JSONL
  （`~/.claude/projects/<encoded-cwd>/<sid>.jsonl`）を使う（ハイブリッド方針、ADR-0006）。

## ファイル構成

```
bin/record.mjs      CLI 本体（record / convert / convert --follow）
lib/asciicast.mjs   asciicast v2 追記ライタ（記録層）
lib/reconstruct.mjs 可読化エンジン（scrollback 到達コミット＋scroll-commit）
lib/profiles.mjs    可読化プロファイル（claude / claude-ax / generic）
docs/adr/           設計判断の記録（ADR）
docs/history.md     開発の経緯（ADR の背景資料）
```
