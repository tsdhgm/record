# ADR-0001: 端末内 pty tee による記録と asciicast v2 の採用

- ステータス: 採用
- 日付: 2026-07-07

## コンテキスト

CLI AI ハーネス（claude 等）のセッションログが欲しい。前身プロジェクト ChatLog は
Electron アプリ内の xterm.js タブで CLI を起動する方式だったが、ユーザー要件として
「**新しいウィンドウを開かず、いま使っている端末の中で**記録したい」がある
（screen / script / asciinema と同じ使用感）。

記録フォーマットの候補: 独自形式、script の typescript、asciicast。

## 決定

1. node-pty で対象コマンドを擬似端末上に起動し、出力を「実端末への素通し／記録
   ファイル／可読化エンジン」の 3 方向へ tee する。新規ウィンドウは開かない。
2. lossless 原本のフォーマットは **asciicast v2** とする。自前の追記ライタ
   （`lib/asciicast.mjs`）で書き、外部の asciinema バイナリには依存しない。

## 理由

- pty tee は screen/script/asciinema と同じ原理で、アプリから見える環境が通常の
  端末と同一（TUI がそのまま動く）。tmux 中継や capture-pane ポーリングより層が薄い。
- asciicast v2 は newline-delimited JSON でイベント毎にリアルタイム追記でき、
  タイミング付き・リサイズイベント付き・`asciinema play` で再生可能・広く使われて
  枯れている。独自形式を発明する理由がない。
- 書かれた瞬間のバイトを全部残すので、画面上で後から消された内容も原本には残る
  （可読化やパターン修正のやり直しが常に可能 = ADR-0006 の保険の基盤）。

## 結果

- `record <cmd>` で `.cast`（原本）と `.txt`（可読、ADR-0002/0003/0005）を同時出力。
- 読み込み側（convert / --follow）は v2 に加えて v3（asciinema 3.x 既定）にも対応。
- node-pty がネイティブ依存の唯一の箇所。convert 系は pure JS なので全 OS で動く。
