// 記録層（U1 の CLI 移植）: pty の生バイト列を asciicast v2 形式で「追記」保存する。
//
// buffer-dump（最後の1画面の写真）と違い、出力イベントを 1 行ずつ追記するので
// タイミング付き・lossless・全履歴が残る。alt-screen で流れて消えた行も
// 書かれた瞬間の生バイトとして .cast に残る。
//
// フォーマット（asciicast v2, https://docs.asciinema.org/manual/asciicast/v2/）:
//   1 行目: ヘッダ JSON  {"version":2,"width":W,"height":H,"timestamp":<unix秒>,"env":{...}}
//   以降  : イベント JSON 配列を 1 行ずつ
//     [経過秒, "o", "<出力データ>"]   出力（output）
//     [経過秒, "r", "<W>x<H>"]        リサイズ（resize）
//   → `asciinema play file.cast` で再生でき、agg で gif 化もできる。
import * as fs from 'fs';

export class AsciicastWriter {
    constructor({ filePath, cols, rows, command }) {
        this.filePath = filePath;
        this.lastCols = cols;
        this.lastRows = rows;
        this.startMs = Date.now();
        this.disposed = false;

        this.stream = fs.createWriteStream(filePath, { flags: 'a' });
        const header = {
            version: 2,
            width: cols,
            height: rows,
            timestamp: Math.floor(this.startMs / 1000),
            command: command || undefined,
            env: { TERM: process.env.TERM || 'xterm-256color', SHELL: process.env.SHELL || '' },
        };
        this.stream.write(JSON.stringify(header) + '\n');
    }

    elapsed() {
        return (Date.now() - this.startMs) / 1000;
    }

    /** pty の出力を 1 イベントとして追記する。 */
    write(data) {
        if (this.disposed || !data) return;
        // JSON.stringify が引用符・制御文字・非ASCIIを正しくエスケープする。
        this.stream.write(JSON.stringify([this.elapsed(), 'o', data]) + '\n');
    }

    /** 端末サイズ変更を resize イベントとして追記する（変化した時だけ）。 */
    resize(cols, rows) {
        if (this.disposed) return;
        if (cols === this.lastCols && rows === this.lastRows) return;
        this.lastCols = cols;
        this.lastRows = rows;
        this.stream.write(JSON.stringify([this.elapsed(), 'r', `${cols}x${rows}`]) + '\n');
    }

    close() {
        if (this.disposed) return;
        this.disposed = true;
        return new Promise((resolve) => this.stream.end(resolve));
    }
}
