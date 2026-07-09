// 可読化プロファイル: アンカー正規化と chrome（UIノイズ）判定をツールごとに持つ。
// エンジン（frame-stitch）は汎用、ここの設定だけが per-tool。
// 由来: ChatLog/app/tools/u2recon.mjs v4（claude JSONL 採点で Recall/Precision 100%）。

const CLAUDE_SPIN = /(Fermenting|Puzzling|Thinking|Working|Cooking|Brewed|…|·\s*thinking|\(\d+s)/i;

const claude = {
        // 画面レイアウト: row0=上ステータス行、下 inputRows 行=入力ボックス。
        // その間だけを「本文領域」とみなす。
        topRows: 1,
        inputRows: 4,
        // ユーザー入力系の背景色（24bit RGB、ダークテーマ実測値）:
        //   0x373737 = 入力ボックス／送信済みプロンプトのエコー（❯）
        //   0x413c41 = bash モード（!）
        // この背景の連続ブロックは、先頭行が inputAnchor で始まる場合のみ本文
        // （送信済みエコー）。アンカー無しは入力ボックス内プレビューのスクロール
        // 断片（巨大ペースト時に発生、送信後のエコーと二重になる）なので落とす。
        // ライトテーマの値は未計測（テーマ違いで断片が混入したらここに追加）。
        inputBgs: [0x373737, 0x413c41],
        inputAnchor: /^[❯!]/,
        // 通常バッファの内容（起動時の信頼確認ダイアログ・終了時の resume 案内）は
        // すべて chrome なので、finish() での通常バッファ dump を行わない
        normalBufferIsChrome: true,
        normalize(l) {
            // 深いインデント（24桁以上）は補完メニュー説明の折返し（classic モードで scrollback に流れ得る）
            if (/^\s{24,}\S/.test(l)) return '';
            l = l.replace(/\s{2,}Jump to bottom.*$/, '').replace(/\s{2,}\(ctrl\+End\).*$/, '');
            l = l.replace(/^[●❯>»⎿⏵*✢✶✻✽◐◓◑◒·]+\s*/, '');
            return l.trim();
        },
        isChrome(l) {
            if (!l) return true;
            if (/[╭╮╰╯│─═┌┐└┘]/.test(l)) return true;
            if (CLAUDE_SPIN.test(l)) return true;
            if (/^\/\S+\s{2,}/.test(l)) return true;              // スラッシュコマンド補完メニュー
            if (/^\/[a-z][a-z0-9-]*$/i.test(l)) return true;      // プロンプトに打った /exit 等の単独コマンド
            if (/^No commands match/.test(l)) return true;
            if (/^[A-Z][a-z]+ for \d+s$/.test(l)) return true;    // "Cogitated for 2s" 等の完了行
            if (/Jump to bottom/.test(l)) return true;
            if (/^Resume this session with:|^claude --resume /.test(l)) return true;
            if (/^▎/.test(l)) return true;                        // お知らせバナー（左バー付き）
            if (/\((user|project|plugin)\)$/.test(l)) return true; // スラッシュメニューの説明の折返し尾
            if (/trust this folder|^\d+\.\s*No, exit/.test(l)) return true; // 信頼確認の残骸（resume時等の保険）
            if (/^⏸ |manual mode on|accept edits on|plan mode on|bypass permissions on/.test(l)) return true; // 権限モードのステータス行
            if (/(esc to|shortcuts|to interrupt|tokens|\/effort|needs authentication|MCP server|Meet Sonnet|\/model|Switch anytime|for shortcuts|how does <filepath>)/i.test(l)) return true;
            return false;
        },
};

export const profiles = {
    claude,

    // claude --ax-screen-reader（スクリーンリーダーモード）用。
    // alt-screen を使わずフラットテキストを通常バッファに流すので、
    // 可読化は「scrollback に入った行＝確定」の単純ロジックで済む
    // （scroll-commit のフック群・入力bg判定は一切不要、端末サイズにも非依存）。
    // 会話は "you: " / "claude: " プレフィックス付き。スピナーや途中描画は
    // claude 自身が行内消去で片付けるため scrollback に残らない。
    'claude-ax': {
        topRows: 0,
        inputRows: 0,
        normalBufferIsChrome: false,
        normalize(l) {
            // 深いインデント（24桁以上）は補完メニュー説明の折返し。会話本文は列0起点
            // （"you: "/"claude: " プレフィックス）なので誤爆しにくい
            if (/^\s{24,}\S/.test(l)) return '';
            return l.trim();
        },
        isChrome(l) {
            if (!l) return true;
            if (claude.isChrome(l)) return true;                 // スピナー・補完メニュー・モード行等の共通chrome
            if (/^\[Accessible screen reader mode/.test(l)) return true;
            if (/^Claude Code v\d/.test(l)) return true;         // 起動バナー
            if (/^Welcome back!$|Tips for getting started|^What's new$/.test(l)) return true;
            if (/^Run \/init to create|^\/release-notes/.test(l)) return true;
            if (/· Claude (Max|Pro|Team|Enterprise)/.test(l)) return true;
            if (/^You've used \d+% of/.test(l)) return true;
            if (/^\$\s*$|^\$\s{2,}\S/.test(l)) return true;      // 入力プロンプト行（"$" / "$  /exit"）
            return false;
        },
    },

    // 未知ツール向けの汎用フォールバック: 罫線と明らかな装飾だけ落とす。
    generic: {
        topRows: 0,
        inputRows: 0,
        normalize(l) {
            return l.replace(/^[●❯>»⎿⏵*✢✶✻✽◐◓◑◒·]+\s*/, '').trim();
        },
        isChrome(l) {
            if (!l) return true;
            if (/^[╭╮╰╯│─═┌┐└┘\s]+$/.test(l)) return true;        // 罫線だけの行
            return false;
        },
    },
};

/** コマンド名からプロファイルを選ぶ（見つからなければ generic）。 */
export function selectProfile(toolName) {
    const key = String(toolName || '').toLowerCase();
    return profiles[key] ? { name: key, ...profiles[key] } : { name: 'generic', ...profiles.generic };
}
