// 可読化層 v2（scroll-commit 方式）: スクロールで画面から破棄される瞬間の行を捕まえて確定する。
//
// 旧 v1（frame-stitch ＋ 重複除去）の限界:
//   - 同一内容の行が畳まれる（AAAA…×26 が 1 行になる）
//   - 多重度カウントでも「同時に見えた最大数」までしか復元できない
//   - 正規化でインデントとアンカー（❯/●）が失われる
//
// v2 の原理（wkwk の実 claude セッション .cast で実証）:
//   claude の TUI はスクロール領域(DECSTBM)＋SU(CSI S) で過去をビューポート外へ破棄する。
//   破棄は 1 行ずつ順番に起きるので、「破棄される直前の行」をフックで拾えば
//   物理行を正確に 1 回ずつ・元の並び・インデント付きで復元できる。
//   破棄されずに終了した残り（最終画面）は alt-screen 退出(?1049l)の直前に snapshot する。
//
// 行の供給源は 3 つ（すべて chrome フィルタを通して onLine へ）:
//   1. SU コミット   … CSI S で領域先頭から destroy される行（適用前にフック）
//   2. LF コミット   … 領域底での改行スクロール（データを \n 直前で分割し、書き込み前に判定。
//                       xterm の onLineFeed はスクロール適用後に発火するため使えない＝実測）
//   3. 最終 snapshot … ?1049l（alt 退出）直前 or finish() 時の可視領域
// 補助: 通常バッファのツール（bash 等）は xterm の scrollback に全行残るので、
//       finish() で全バッファを dump する（claude は normalBufferIsChrome で skip）。
import pkg from '@xterm/headless';
const { Terminal } = pkg;

export class Reconstructor {
    /**
     * @param {object} opts
     * @param {number} opts.cols
     * @param {number} opts.rows
     * @param {object} opts.profile  profiles.mjs のプロファイル
     * @param {(line: string) => void} opts.onLine  可読行が確定するたびに呼ばれる
     */
    constructor({ cols, rows, profile, onLine }) {
        // scrollback はリアルタイム確定（normalCommitted）のインデックス基準なので大きめに取る。
        // これを超える長さの通常バッファセッションでは xterm が先頭から行を捨て、
        // インデックスがずれて以降の確定が狂う（既知の限界）。
        this.term = new Terminal({ cols, rows, scrollback: 100000, allowProposedApi: true });
        this.cols = cols;
        this.rows = rows;
        this.profile = profile;
        this.onLineRaw = onLine;
        this.queue = Promise.resolve();     // term.write は非同期なので直列化
        this.lastWasBlank = true;           // 空行の連続を 1 行に畳む（先頭の空行も抑止）
        this.altSnapshotDone = false;       // alt 退出 snapshot 済みフラグ（finish との二重取り防止）
        this.inputRun = null;               // 入力背景色ブロックの状態: null | 'keep' | 'drop'
        this._cell = null;                  // getCell 用の使い回しバッファ（xterm API 仕様）
        this.normalCommitted = 0;           // 通常バッファで確定済みの行数（scrollback 到達コミット用）
        this.sawAlt = false;                // alt-screen を一度でも使ったか。claude は tui 設定で
                                            // fullscreen(alt) / default(classic, alt不使用) が切り替わるため、
                                            // 「altを見た後の通常バッファ＝chrome」「一度も見ない＝本文」と動的判定する

        // DECSTBM スクロール領域の自前追跡（0-based, 両端含む）
        this.regionTop = 0;
        this.regionBottom = rows - 1;
        this.sawRegion = false; // DECSTBM を一度でも見たか（フル画面リセットと未使用の区別）
        this.term.parser.registerCsiHandler({ final: 'r' }, (params) => {
            this.sawRegion = true;
            this.regionTop = (params[0] || 1) - 1;
            this.regionBottom = (params[1] || this.rows) - 1;
            return false; // 既定の処理も走らせる
        });

        // SU (CSI S): 適用前に、破棄される領域先頭 n 行をコミット
        this.term.parser.registerCsiHandler({ final: 'S' }, (params) => {
            const n = Math.min(params[0] || 1, this.regionBottom - this.regionTop + 1);
            for (let i = 0; i < n; i++) this.commitRow(this.regionTop + i);
            return false;
        });

        // alt-screen 退出 (?1049l / ?1047l / ?47l): 画面が破棄される前に最終 snapshot
        this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
            for (let i = 0; i < params.length; i++) {
                const p = params[i];
                if ((p === 1049 || p === 1047 || p === 47) && this.term.buffer.active.type === 'alternate') {
                    this.snapshotRegion();
                    this.altSnapshotDone = true;
                }
            }
            return false;
        });
    }

    lineAt(row) {
        const buf = this.term.buffer.active;
        return (buf.getLine(buf.baseY + row)?.translateToString(true) ?? '').replace(/\s+$/, '');
    }

    /** バッファ行の非空白セルの過半が profile.inputBgs の背景色か。 */
    isInputBg(bufLine) {
        const bgs = this.profile.inputBgs;
        if (!bgs?.length || !bufLine) return false;
        this._cell = bufLine.getCell(0, this._cell) ?? this._cell;
        let total = 0, hits = 0;
        for (let x = 0; x < bufLine.length; x++) {
            const c = bufLine.getCell(x, this._cell);
            if (!c || !c.getChars().trim()) continue;
            total++;
            if (c.isBgRGB() && bgs.includes(c.getBgColor())) hits++;
        }
        return total > 0 && hits * 2 > total;
    }

    /** 画面上の 1 行を、背景色情報付きで commit する。 */
    commitRow(row) {
        const buf = this.term.buffer.active;
        const bufLine = buf.getLine(buf.baseY + row);
        const text = (bufLine?.translateToString(true) ?? '').replace(/\s+$/, '');
        this.commit(text, this.isInputBg(bufLine));
    }

    /** 1 行を入力ボックス断片・chrome フィルタ・空行畳みを通して出力する。 */
    commit(rawLine, inputBg = false) {
        const line = rawLine.replace(/\s+$/, '');
        if (!line.trim()) {
            // 空行は背景色を持たないので inputRun を維持したまま扱う
            if (this.inputRun === 'drop') return;
            if (!this.lastWasBlank) { this.onLineRaw(''); this.lastWasBlank = true; }
            return;
        }
        if (inputBg) {
            // 入力背景色の連続ブロック: 先頭行のアンカー（❯/!）で
            // 送信済みエコー(keep)か入力ボックス内プレビュー断片(drop)かを決める
            if (this.inputRun === null) {
                this.inputRun = this.profile.inputAnchor?.test(line.trimStart()) ? 'keep' : 'drop';
            }
            if (this.inputRun === 'drop') return;
        } else {
            this.inputRun = null;
        }
        // chrome 判定は正規化した写しで行い、出力は生の行（インデント・アンカー保持）
        const norm = this.profile.normalize(line);
        if (!norm || this.profile.isChrome(norm)) return;
        this.onLineRaw(line);
        this.lastWasBlank = false;
    }

    /** 現在のスクロール領域（未設定ならプロファイルの本文領域）をコミットする。 */
    snapshotRegion() {
        let top = this.regionTop;
        let bottom = this.regionBottom;
        if (!this.sawRegion) {
            // DECSTBM 未使用ツール: プロファイルの固定レイアウトへフォールバック
            top = this.profile.topRows ?? 0;
            bottom = this.rows - 1 - (this.profile.inputRows ?? 0);
        }
        for (let i = top; i <= bottom; i++) this.commitRow(i);
    }

    /** pty 出力チャンクを 1 つ食わせる（呼び出し順に処理される）。 */
    feed(data) {
        // 領域底での LF はスクロールで先頭行を破棄する。onLineFeed では適用後で
        // 手遅れなので、\n の直前でデータを分割し「書き込む前」に判定・コミットする。
        // （エスケープ列が分割点をまたいでも xterm のパーサはストリーミング安全。）
        for (const piece of data.split(/(?=\n)/)) {
            this.queue = this.queue.then(
                () => new Promise((resolve) => {
                    if (piece[0] === '\n' && this.term.buffer.active.type === 'alternate') {
                        const y = this.term.buffer.active.cursorY;
                        if (y === this.regionBottom) this.commitRow(this.regionTop);
                    }
                    this.term.write(piece, () => { this.commitNormalScrollback(); resolve(); });
                })
            );
        }
        return this.queue;
    }

    /** 通常バッファ: scrollback に押し出された行はアプリがもう書き換えられない＝確定。
     *  書き込みごとに baseY までの未確定行をコミットする（リアルタイム追記の supply 源）。
     *  alt-screen 型 TUI（claude 通常モード等）はここを通らない。 */
    commitNormalScrollback() {
        const buf = this.term.buffer.active;
        if (buf.type === 'alternate') { this.sawAlt = true; return; }
        if (this.profile.normalBufferIsChrome && this.sawAlt) return;
        while (this.normalCommitted < buf.baseY) {
            const line = (buf.getLine(this.normalCommitted)?.translateToString(true) ?? '').replace(/\s+$/, '');
            this.commit(line);
            this.normalCommitted++;
        }
    }

    /** 現在の可視画面をプレーンテキストで返す（--screen の current-screen 出力用）。 */
    screenText() {
        const buf = this.term.buffer.active;
        const lines = [];
        for (let i = 0; i < this.rows; i++) {
            lines.push((buf.getLine(buf.baseY + i)?.translateToString(true) ?? '').replace(/\s+$/, ''));
        }
        return lines.join('\n').replace(/\n+$/, '') + '\n';
    }

    resize(cols, rows) {
        this.queue = this.queue.then(() => {
            this.cols = cols;
            this.rows = rows;
            // 端末仕様に合わせ、リサイズでスクロール領域はリセットされる前提を置く
            this.regionTop = 0;
            this.regionBottom = rows - 1;
            this.term.resize(cols, rows);
        });
        return this.queue;
    }

    /** 全チャンクの処理完了を待ち、画面に残っている行を確定する（終了時に呼ぶ）。 */
    async finish() {
        await this.queue;
        const buf = this.term.buffer.active;
        if (buf.type === 'alternate') {
            // alt のまま終了（kill 等）: 最終画面を snapshot
            if (!this.altSnapshotDone) this.snapshotRegion();
        } else if (!this.profile.normalBufferIsChrome || !this.sawAlt) {
            // 通常バッファのツール（bash / claude-ax / claude classic 等）: scrollback 到達分は
            // 確定済みなので、残り（可視画面を含む未確定部分）だけを dump する。
            // alt-screen 型ツール（claude fullscreen）は alt 退出後の通常バッファが
            // chrome（resume 案内等）なので dump しない（normalBufferIsChrome && sawAlt）
            for (let i = this.normalCommitted; i < buf.length; i++) {
                const line = (buf.getLine(i)?.translateToString(true) ?? '').replace(/\s+$/, '');
                this.commit(line);
            }
        }
        this.term.dispose();
    }
}
