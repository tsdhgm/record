# ADR 索引

設計判断の記録（Architecture Decision Records）。背景の時系列は [../history.md](../history.md) を参照。

| # | タイトル | 日付 | ステータス |
|---|---|---|---|
| [0001](0001-in-terminal-pty-recording-and-asciicast.md) | 端末内 pty tee による記録と asciicast v2 の採用 | 2026-07-07 | 採用 |
| [0002](0002-custom-readable-reconstruction.md) | 可読化エンジンの自作とプロファイル層の分離 | 2026-07-07 | 採用 |
| [0003](0003-scroll-commit-engine.md) | frame-stitch から scroll-commit への置き換え | 2026-07-07 | 採用（フォールバック） |
| [0004](0004-input-bg-fragment-filter.md) | 入力背景色フィルタによるペースト断片の除去 | 2026-07-09 | 採用 |
| [0005](0005-classic-renderer-primary.md) | classic レンダラー主軸と scrollback 到達コミット | 2026-07-09 | 採用 |
| [0006](0006-cast-as-insurance-hybrid-logging.md) | ハイブリッドログ戦略（JSONL 正本・.cast 保険） | 2026-07-09 | 採用 |
| [0007](0007-language-choice-nodejs.md) | 実装言語としての JavaScript (Node.js) | 2026-07-09 | 採用（事後追認） |
