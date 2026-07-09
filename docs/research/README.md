# research — 開発時の検討資料

[../history.md](../history.md) から参照される一次資料。

- `1.txt`〜`10.txt` — ユーザーが ChatGPT と並行検討した会話の記録（2026-07-09）。
  奇数番号=ユーザーの質問、偶数番号=ChatGPT の回答。番号順が会話順。
  1〜6: 端末レコーダの選択肢調査（script/asciinema/tmux、`--ax-screen-reader` の発見、
  CCHV の発見、VS Code でのリアルタイム閲覧）。
  7〜10: .cast のリアルタイム可読化の実現性、tmux capture-pane 差分方式の筋の良し悪し。
  検証結果と採否は history.md と ADR-0005/0006 を参照。
- `20260708-01.md` — record 自身で録った「scroll-commit エンジン改良セッション」の
  可読化ログ（2026-07-08）。初期エンジンの実戦品質のサンプルであり、
  ツールが自分自身の開発過程を記録した最初の例。
