# record — CLI session recorder (lossless capture + realtime readable log)

A command-line tool that records CLI AI harness sessions (claude, etc.) **inside the terminal you are already using** — the same approach as screen / script / asciinema. No new window is opened.

日本語版は [README_ja.md](README_ja.md) にあります。 Design decisions: [docs/adr/](docs/adr/) / Project background: [docs/history.md](docs/history.md)

It writes two files **simultaneously**:

| File | Content | Nature |
|---|---|---|
| `<tool>-<ts>.cast` | asciicast v2 (every raw byte + timing) | Lossless original. Tool-agnostic, replayable with `asciinema play` |
| `<tool>-<ts>.txt` | Readable text (control codes and TUI chrome stripped) | **Appended in realtime**. Follow it with `tail -f` or open it in VS Code while recording |

## Usage

```bash
# Recommended: record claude with the classic renderer (the pre-alt-screen TUI).
# Looks and feels like the traditional claude UI, and the conversation flows
# into the scrollback — best log quality, terminal-size independent, realtime.
node bin/record.mjs claude --settings '{"tui": "default"}'

# If you put {"tui": "default"} in ~/.claude/settings.json, this is all you need
node bin/record.mjs claude

# Also write a snapshot of the current screen every second
# (to keep "what is on screen right now" visible in VS Code)
node bin/record.mjs --screen claude

# Follow the readable log in realtime from another terminal (or VS Code)
tail -f .harness-log/claude-*.txt

# Convert an existing .cast (asciicast v2 or v3) to readable text
node bin/record.mjs convert session.cast

# Record with the asciinema binary and generate the readable log alongside
asciinema rec -c claude session.cast               # terminal A
node bin/record.mjs convert --follow session.cast  # terminal B (exits when the recording ends)
```

Options: `-d <dir>` output directory (default `.harness-log/`), `-p <profile>` readability profile (auto-selected from the command name and the presence of `--ax-screen-reader`), `--no-txt` cast only, `--screen` overwrite the current screen to `<base>.screen.txt` every second.

## claude's three render modes and their recording quality

| Mode | How to enable | Look | Recording quality |
|---|---|---|---|
| **classic (recommended)** | `--settings '{"tui": "default"}'` or settings.json | Traditional claude TUI (❯/●, colors, tool display) | **Best.** No alt-screen, so the conversation flows into the scrollback → the simple "reached scrollback = final" logic gives realtime appends, independent of terminal size (measured: full conversation recovered at 80×24 with banner/menu/spinner noise fully removed) |
| fullscreen (default) | nothing | Same + alt-screen | Best-effort via the scroll-commit engine (below). **A tall terminal (≥40 rows) is required.** On small terminals the middle of fast responses is never drawn, hence unrecoverable |
| ax (screen reader) | `--ax-screen-reader` | Flat text (`you:`/`claude:`); very different feel | As good as classic, but the interactive experience suffers — use classic instead |

The profile is selected automatically: `claude-ax` when `--ax-screen-reader` is present, otherwise `claude`. The `claude` profile decides dynamically: **if the session never enters the alt-screen it is treated as classic, otherwise as fullscreen** — so it works no matter where the tui setting comes from (CLI flag or settings.json).

Other CLIs (gemini, codex, …) are recorded with the generic profile; anything that renders in the normal buffer benefits from the same scrollback-commit logic.

## How it works

- **Recording layer** (tool-agnostic, lossless): raw pty bytes are appended as asciicast v2 events. Lines that scrolled away or were overwritten on screen still exist as the bytes that were written.
- **Readability layer (normal buffer = scrollback-commit)**: raw bytes are fed to `@xterm/headless`; a line that has been **pushed into the scrollback can no longer be modified by the application, i.e. it is final** — it is appended to the .txt at that moment. Classic-mode claude, bash, and most CLIs are captured completely this way.
- **Readability layer (alt-screen = scroll-commit, best-effort)**: for fullscreen TUIs. Hooks capture each line **at the moment scrolling destroys it**:
  - on `CSI S` (SU), commit the doomed lines at the top of the DECSTBM scroll region before the scroll is applied
  - for newline scrolls at the region bottom, split the input right before each `\n` and decide before writing
  - snapshot whatever remains on screen just before alt-screen exit (`?1049l`) and at the end
  Physical lines are reconstructed **exactly once, in original order, with indentation and speaker anchors (`❯` = user / `●` = assistant)**; repeated identical lines are not collapsed.
- **Chrome removal**: startup banners, dialogs, spinners, box-drawing, completion menus, etc. are filtered by per-tool patterns in `lib/profiles.mjs`. All tool-specific knowledge lives in that one layer.
- **Input-box fragment filter** (claude profile): pasting a huge text makes the pre-submission input-box preview scroll, and those fragments would be committed out of order before submission (measured: a 1783-line paste produced 42 duplicated fragment lines). claude paints user input with dedicated background colors (input box / echo `#373737`, bash mode `#413c41`), so **a contiguous run of input-background lines is kept only when it starts with an anchor (`❯`/`!`) — i.e. it is a submitted-prompt echo — and dropped otherwise**. Colors are measured values for the dark theme (`inputBgs` in `lib/profiles.mjs`).

## Why not asciinema's txt conversion

`asciinema convert -f txt` (3.x) dumps the final screen buffer. For an alt-screen TUI that redraws inside a scroll region — like claude — **almost the entire conversation is lost** (measured: only the startup dialog survived). This tool avoids that by capturing each line at the moment it becomes final.

## asciicast support

- Writing: v2 (directly usable with `asciinema play`, agg, etc.)
- Reading (convert / --follow): v2 and v3 (the default format of asciinema 3.x; `--follow` auto-exits on the v3 `x` (exit) event)
- zstd-compressed `.cast.zst` is not supported (run `zstd -d` first)

## Known limitations

- Readability is best-effort. **Only lines the TUI actually drew to the terminal can ever be recovered.**
- Fullscreen-mode-only limitations:
  - Lines that disappear via **in-place overwriting** (no scroll) cannot be captured (measured: 1 line out of 26).
  - **Use a tall terminal (≥40 rows).** On small terminals (measured: 80×24) claude barely scrolls and never even draws the middle of fast responses (measured: 19 of 40 items absent from the raw cast stream — unrecoverable by any terminal recorder).
  - Scrolling back through the TUI history can re-commit re-displayed lines (measured: 3 duplicated lines out of 201 in a 17-minute real session).
  - → **None of these happen in classic mode (`tui: "default"`).**
- The claude chrome patterns may break when claude updates its UI (the `.cast` originals are unaffected — fix the patterns and re-convert).
- Normal-buffer sessions longer than 100k scrollback lines will drift the commit index (xterm drops the oldest lines).
- When a perfectly clean conversation log is required, use claude's own JSONL (`~/.claude/projects/<encoded-cwd>/<sid>.jsonl`) — the hybrid strategy, see ADR-0006.

## Layout

```
bin/record.mjs      CLI entry point (record / convert / convert --follow)
lib/asciicast.mjs   asciicast v2 appending writer (recording layer)
lib/reconstruct.mjs readability engine (scrollback-commit + scroll-commit)
lib/profiles.mjs    readability profiles (claude / claude-ax / generic)
docs/adr/           architecture decision records
docs/history.md     project background (context for the ADRs)
```
