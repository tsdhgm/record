#!/usr/bin/env node
// record — CLI セッションレコーダ
//
// 使い方:
//   record [オプション] [--] <コマンド> [引数...]   コマンドを起動して記録する
//   record convert <file.cast> [-o out.txt]        既存の .cast を可読テキストへ変換
//
// 記録モードでは 3 つへ同時に tee する:
//   1. 実端末（そのまま操作できる passthrough）
//   2. <dir>/<tool>-<ts>.cast   … asciicast v2（lossless 原本、asciinema play で再生可）
//   3. <dir>/<tool>-<ts>.txt    … 可読テキスト（リアルタイム追記、tail -f で追える）
//
// オプション:
//   -d, --dir <dir>       出力ディレクトリ（既定: カレントの .harness-log/）
//   -p, --profile <name>  可読化プロファイル（既定: コマンド名から自動選択）
//       --no-txt          可読テキストの同時出力を無効化（.cast のみ）
//   -o, --out <file>      convert モードの出力先（既定: 入力と同名 .txt）
import * as fs from 'fs';
import * as path from 'path';
import { AsciicastWriter } from '../lib/asciicast.mjs';
import { Reconstructor } from '../lib/reconstruct.mjs';
import { selectProfile } from '../lib/profiles.mjs';

function usage(code) {
    process.stderr.write(
        'usage: record [-d dir] [-p profile] [--no-txt] [--screen] [--] <command> [args...]\n' +
        '       record convert <file.cast> [-p profile] [-o out.txt] [--follow]\n' +
        '\n' +
        '  --screen: 現在画面のスナップショットを <base>.screen.txt へ毎秒上書きする\n' +
        '  （VS Code 等で「今の画面」を常時表示する用途。追記ログ .txt とは別物）。\n' +
        '  convert --follow: 記録中の .cast を tail 追従し、可読 txt をリアルタイム生成する。\n' +
        '  （例: 別端末の `asciinema rec -c claude x.cast` と併用）\n'
    );
    process.exit(code);
}

function timestampBase(tool) {
    const n = new Date();
    const p = (v) => String(v).padStart(2, '0');
    return `${tool}-${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

function uniquePath(dir, base, ext) {
    let candidate = path.join(dir, `${base}${ext}`);
    let counter = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base}-${counter}${ext}`);
        counter++;
    }
    return candidate;
}

// ---- 引数解析 ----
const argv = process.argv.slice(2);
if (argv.length === 0) usage(1);

if (argv[0] === 'convert') {
    await convertMain(argv.slice(1));
} else {
    await recordMain(argv);
}

// ---------------------------------------------------------------- record
async function recordMain(argv) {
    let dir = null;
    let profileName = null;
    let wantTxt = true;
    let wantScreen = false;
    let i = 0;
    for (; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { i++; break; }
        else if (a === '-d' || a === '--dir') dir = argv[++i];
        else if (a === '-p' || a === '--profile') profileName = argv[++i];
        else if (a === '--no-txt') wantTxt = false;
        else if (a === '--screen') wantScreen = true;
        else if (a === '-h' || a === '--help') usage(0);
        else if (a.startsWith('-')) { process.stderr.write(`record: unknown option: ${a}\n`); usage(1); }
        else break;
    }
    const command = argv.slice(i);
    if (command.length === 0) usage(1);

    const { default: pty } = await import('node-pty');

    const tool = path.basename(command[0]);
    // claude --ax-screen-reader はフラットテキスト出力（alt-screen 不使用）なので専用プロファイルへ
    const axMode = /^claude/.test(tool) && command.includes('--ax-screen-reader');
    const profile = selectProfile(profileName || (axMode ? 'claude-ax' : tool));
    dir = dir || path.join(process.cwd(), '.harness-log');
    fs.mkdirSync(dir, { recursive: true });

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const base = timestampBase(tool);
    const castPath = uniquePath(dir, base, '.cast');
    const txtPath = wantTxt ? uniquePath(dir, base, '.txt') : null;

    const cast = new AsciicastWriter({ filePath: castPath, cols, rows, command: command.join(' ') });

    let txtStream = null;
    let recon = null;
    if (wantTxt || wantScreen) {
        if (wantTxt) txtStream = fs.createWriteStream(txtPath, { flags: 'a' });
        recon = new Reconstructor({
            cols, rows, profile,
            onLine: (line) => txtStream?.write(line + '\n'),
        });
    }

    // --screen: 現在画面のスナップショットを毎秒上書き（VS Code での常時表示用）
    let screenTimer = null;
    let screenPath = null;
    if (wantScreen) {
        screenPath = uniquePath(dir, base, '.screen.txt');
        screenTimer = setInterval(() => {
            fs.writeFile(screenPath, recon.screenText(), () => {});
        }, 1000);
    }

    const child = pty.spawn(command[0], command.slice(1), {
        name: process.env.TERM || 'xterm-256color',
        cols, rows,
        cwd: process.cwd(),
        env: process.env,
    });

    // 実端末 passthrough: 入力は raw で素通し（Ctrl+C も pty のアプリに渡る）
    const stdinIsTTY = process.stdin.isTTY;
    if (stdinIsTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => child.write(d.toString()));

    child.onData((data) => {
        process.stdout.write(data);
        cast.write(data);
        recon?.feed(data);
    });

    const onResize = () => {
        const c = process.stdout.columns || cols;
        const r = process.stdout.rows || rows;
        child.resize(c, r);
        cast.resize(c, r);
        recon?.resize(c, r);
    };
    process.stdout.on('resize', onResize);

    const exitCode = await new Promise((resolve) => {
        child.onExit(({ exitCode }) => resolve(exitCode));
    });

    // 後始末: 端末を戻し、残りのチャンクを flush してから閉じる
    if (stdinIsTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.removeListener('resize', onResize);
    if (screenTimer) clearInterval(screenTimer);
    if (recon) {
        await recon.finish();
        if (txtStream) await new Promise((r) => txtStream.end(r));
    }
    await cast.close();

    process.stderr.write(`\nrecord: saved\n  cast: ${castPath}\n`);
    if (wantTxt) process.stderr.write(`  txt : ${txtPath}\n`);
    if (screenPath) process.stderr.write(`  scr : ${screenPath}\n`);
    process.exit(exitCode);
}

// --------------------------------------------------------------- convert
async function convertMain(argv) {
    let out = null;
    let profileName = null;
    let input = null;
    let follow = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-o' || a === '--out') out = argv[++i];
        else if (a === '-p' || a === '--profile') profileName = argv[++i];
        else if (a === '-f' || a === '--follow') follow = true;
        else if (a === '-h' || a === '--help') usage(0);
        else if (a.startsWith('-')) { process.stderr.write(`record: unknown option: ${a}\n`); usage(1); }
        else if (!input) input = a;
        else usage(1);
    }
    if (!input) usage(1);

    if (follow) return convertFollow(input, out, profileName);

    const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean);
    const { cols, rows } = parseCastHeader(lines[0]);
    const profile = autoProfile(profileName, lines[0], input);

    out = out || input.replace(/\.cast$/, '') + '.txt';
    const txtStream = fs.createWriteStream(out);
    const recon = new Reconstructor({
        cols, rows, profile,
        onLine: (line) => txtStream.write(line + '\n'),
    });

    for (const l of lines.slice(1)) applyCastEvent(recon, l);
    await recon.finish();
    await new Promise((r) => txtStream.end(r));
    process.stderr.write(`record: wrote ${out} (profile: ${profile.name})\n`);
}

// asciicast v2 と v3 の両対応:
//   v2: {"version":2,"width":W,"height":H,...}       イベント時刻=開始からの絶対経過秒
//   v3: {"version":3,"term":{"cols":W,"rows":H},...} イベント時刻=前イベントからの相対秒
// 可読化はイベント順しか使わないので時刻の解釈差は無視できる。サイズだけ吸収する。
function parseCastHeader(headerLine) {
    const header = JSON.parse(headerLine);
    const cols = header.version === 3 ? header.term?.cols : header.width;
    const rows = header.version === 3 ? header.term?.rows : header.height;
    if (!cols || !rows) {
        process.stderr.write(`record: unsupported cast header (version=${header.version})\n`);
        process.exit(1);
    }
    return { cols, rows };
}

// プロファイル自動選択: ヘッダの command かファイル名からツール名を推定
function autoProfile(profileName, headerLine, inputPath) {
    if (!profileName) {
        const header = JSON.parse(headerLine);
        const hint = `${header.command || ''} ${path.basename(inputPath)}`;
        profileName = /ax-screen-reader/.test(hint) ? 'claude-ax'
            : /claude/i.test(hint) ? 'claude' : 'generic';
    }
    return selectProfile(profileName);
}

/** イベント 1 行を Reconstructor へ適用する。'x'（v3 の exit）なら true を返す。 */
function applyCastEvent(recon, line) {
    let e;
    try { e = JSON.parse(line); } catch { return false; } // 書き込み途中の不完全行は無視
    if (e[1] === 'o') recon.feed(e[2]);
    else if (e[1] === 'r') {
        const [c, r] = String(e[2]).split('x').map(Number);
        if (c && r) recon.resize(c, r);
    }
    else if (e[1] === 'x') return true;
    return false;
}

// --follow: 記録中の .cast を tail 追従し、可読 txt をリアルタイム追記する。
// 終了条件: v3 の exit イベント('x') を見たら、または SIGINT/SIGTERM。
async function convertFollow(input, out, profileName) {
    const POLL_MS = 200;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ヘッダ行（最初の改行まで）が書かれるのを待つ。
    // 改行(0x0a)は JSON 行の中には生では現れない（エスケープされる）ので、
    // バイトのまま改行で切ってから UTF-8 デコードすれば多バイト文字は割れない。
    let offset = 0;
    let buf = Buffer.alloc(0);
    let headerLine = null;
    while (headerLine === null) {
        try {
            const chunk = readNewBytes(input, offset);
            offset += chunk.length;
            buf = Buffer.concat([buf, chunk]);
            const nl = buf.indexOf(0x0a);
            if (nl >= 0) {
                headerLine = buf.subarray(0, nl).toString('utf8');
                buf = buf.subarray(nl + 1);
            }
        } catch { /* まだファイルが無い */ }
        if (headerLine === null) await sleep(POLL_MS);
    }

    const { cols, rows } = parseCastHeader(headerLine);
    const profile = autoProfile(profileName, headerLine, input);

    out = out || input.replace(/\.cast$/, '') + '.txt';
    const txtStream = fs.createWriteStream(out, { flags: 'a' });
    const recon = new Reconstructor({
        cols, rows, profile,
        onLine: (line) => txtStream.write(line + '\n'),
    });
    process.stderr.write(`record: following ${input} -> ${out} (profile: ${profile.name}, Ctrl+C で終了)\n`);

    let stop = false;
    const onSignal = () => { stop = true; };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    let sawExit = false;
    while (!stop && !sawExit) {
        const chunk = readNewBytes(input, offset);
        if (chunk.length > 0) {
            offset += chunk.length;
            buf = Buffer.concat([buf, chunk]);
            let nl;
            while ((nl = buf.indexOf(0x0a)) >= 0) {
                const line = buf.subarray(0, nl).toString('utf8');
                buf = buf.subarray(nl + 1);
                if (line && applyCastEvent(recon, line)) sawExit = true;
            }
        } else {
            await sleep(POLL_MS);
        }
    }
    const rest = buf.toString('utf8');
    if (rest.trim()) applyCastEvent(recon, rest); // 最終行に改行が無いケース
    await recon.finish();
    await new Promise((r) => txtStream.end(r));
    process.stderr.write(`record: wrote ${out}\n`);
    process.exit(0);
}

/** input の offset 以降の新規バイトを Buffer で読む（無ければ空 Buffer）。 */
function readNewBytes(input, offset) {
    const size = fs.statSync(input).size;
    if (size <= offset) return Buffer.alloc(0);
    const fd = fs.openSync(input, 'r');
    try {
        const len = size - offset;
        const b = Buffer.alloc(len);
        const n = fs.readSync(fd, b, 0, len, offset);
        return b.subarray(0, n);
    } finally {
        fs.closeSync(fd);
    }
}
