# ADR-0005: classic レンダラー（tui: "default"）主軸と scrollback 到達コミット

- ステータス: 採用
- 日付: 2026-07-09

## コンテキスト

fullscreen（alt-screen）モードの可読化には、実測で確認された構造的な限界が残った:

- 小さい端末（80×24）では claude がスクロールをほぼ使わず上書き再描画になり、
  さらに速い応答の中間部分を**端末に一度も描画しない**（40 項目中 19 項目が cast の
  生ストリームに不存在＝どんな端末レコーダでも原理的に不可）。
- 同一位置上書きの喪失、履歴スクロールの少量重複（ADR-0003 の結果参照）。

外部調査（ChatGPT との比較検討、docs/history.md 参照）で `--ax-screen-reader` を発見。
alt-screen を使わずフラットテキストを流すため記録品質は完璧だったが、**対話の
操作感が大きく変わり、ユーザーが「かなり使いにくい」と却下**。

その ax のドキュメントに「classic レンダラーを強制するため `tui` 設定は無効」という
記述があり、`tui` 設定を調査。**公式ドキュメントの記載（true/false）は古く、実際の
有効値は `"default"` / `"fullscreen"`**（`false` を渡すと SettingsError ダイアログが
出る）。`"tui": "default"` = classic レンダラー = **alt-screen 導入前の旧来型 TUI**
（❯/●・色・ツール表示はそのまま、会話が通常バッファの scrollback に流れる）と判明。

## 決定

1. **記録の推奨モードを classic（`tui: "default"`）とする。**
   `record claude --settings '{"tui": "default"}'`、または ~/.claude/settings.json に
   恒久設定。
2. 通常バッファ用の確定判定として **scrollback 到達コミット**を実装する:
   「scrollback に押し出された行はアプリがもう書き換えられない＝確定」。
   書き込みごとに baseY までの未確定行を追記する。スクロール領域追跡・SU フック・
   背景色判定が一切不要な約 20 行のロジックで、端末サイズにも依存しない。
3. モード判別は**動的**に行う: claude プロファイルは「セッション中に alt-screen を
   一度も見なければ classic（通常バッファ＝本文）、見れば fullscreen（通常バッファ＝
   chrome）」と判定（sawAlt フラグ）。tui 設定が CLI 引数でも settings.json でも
   record 側の指定は不要。
4. scroll-commit エンジン（ADR-0003/0004）は fullscreen モードで録られた cast の
   ためのフォールバックとして**削除せず維持**する。

## 理由

- classic モードでは fullscreen の構造的限界が**発生源ごと消える**。実測（80×24）:
  バナー/メニュー/スピナー全除去・会話完全復元・A×50 行も 50/50（scroll-commit では
  25/26 だった鬼門）・選択肢クイズの Q&A も保存。
- ax と違い操作感は従来のままなので、ユーザーの日常利用に耐える。
- `tui` 設定や classic レンダラーが将来消えるリスクへの備え: `.cast` 原本は不変、
  scroll-commit フォールバックも残るため、その日から fullscreen 運用に戻れる。
- scrollback 到達コミットは bash や他 CLI（generic プロファイル）にもそのまま効き、
  通常バッファ系ツール全般がリアルタイム化する。

## 結果

- 実運用初回（2026-07-09、80×34）で品質確認済み。
- 既知の限界: scrollback 10 万行超の長大セッションでインデックスがずれる（xterm が
  先頭行を破棄するため）。実用上は十分遠い上限として README に明記。
- 公式ドキュメントと実装の乖離（true/false vs "default"/"fullscreen"）に注意。
  無効値を渡すと SettingsError ダイアログが出て、パイプ入力が誤選択を起こし得る。
