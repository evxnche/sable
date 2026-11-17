# Sable

Sable is a desktop app for working with coding agents. It runs the Claude Code and Codex CLIs you already have installed and signed in, and gives both one calm place to work: a conversation that shows what the agent is doing while it does it, answers that can hold charts and small interactive views, and a side panel with your changes, files, a browser, a terminal and the agent's tasks. Sable has no model or account of its own. Your agents do the work; Sable shows it.

![A finished turn with a chart in the answer](docs/session.png)

## What is different

**The agent can answer with an interface.** Both agents get a `show_widget` tool. When a chart, a diagram, a small form or a simulation explains something better than prose, the agent draws it and it appears inline in the answer. Clicking a choice in a widget can send it back as your next message. Widgets run in a sandboxed frame with no network access and no access to Sable or your files. Answers also draw `mermaid` code blocks as diagrams, preview `html` and `svg` code blocks, and lay out wide tables properly.

**A conversation you can follow.** While a turn runs you see one live line on top and a trail of steps below it, one short line each: reads and searches fold into runs, a running command shows its last lines, edits show their diff on demand. Text streams at an even pace. When the turn ends, the steps gather into a single summary line with the time it took and the files it changed, and the answer stays in view.

![A live turn with the trail of steps and the Changes panel](docs/live.png)

**Several accounts per agent, and their limits in view.** Add as many Claude Code or Codex accounts as you use, each with its own config folder, and switch between them from the sidebar. The switcher shows how much of each plan window is used. When a turn hits a plan limit, Sable offers to continue the same conversation with another account that has room, or does it for you if you turn that on.

![The account switcher with one account's limits](docs/accounts.png)

**Usage you can read.** Settings › Usage shows each account's plan windows with when they reset and whether you are on pace to hit them, plus the tokens your agents used by day, model, project and session, read from the transcripts the agents already keep on disk.

![Settings, Usage](docs/usage.png)

## Everything else

- Claude Code (through the Claude Agent SDK) and Codex (through `codex app-server`) in one timeline: messages, thinking, commands, file edits with diffs, searches, sub-agents, MCP tools, plans and todos.
- Permission cards with diff previews (allow once, always allow, deny with feedback) and keyboard-driven question cards.
- Queue a message while the agent works, or steer it into the running turn.
- Slash commands and skills (`/`), file mentions (`@`), shell commands (`!`), attachments and images.
- Model, permission mode and thinking level per session, including Ultracode for Claude and the ultra level for Codex.
- Side panel: git changes, file tree, a browser next to the conversation, a terminal, tasks and context usage.
- History: browse and resume the conversations your agents keep on disk. Rewind to an earlier message, optionally restoring files.
- Command palette and keyboard shortcuts for everything.
- A dithered backdrop that reacts when you send, when a turn ends and when something fails, and goes still when you stop. Presets, your own image and a live editor in Settings › Appearance.

![Settings, Appearance](docs/appearance.png)

The screenshots use Sable's built-in Demo agent with its made-up project and accounts.

## Install

Download `Sable-Setup-<version>.exe` from the [Releases page](https://github.com/Leonxlnx/sable/releases) and run it. It installs for your user only, with no admin prompt, and opens Sable when it finishes.

Sable is Windows only for now. The installer is not code-signed, so Windows SmartScreen warns on first run: choose "More info", then "Run anyway". There are no in-app updates yet; new versions are published on the Releases page.

Sable keeps its data in `~/.sable`. The uninstaller leaves that folder alone.

## Requirements

- Windows 10 or 11.
- Claude Code and/or the Codex CLI, installed and signed in. Sable uses their own sign-in and never sees your password or tokens: plan limits are asked of the agents themselves, and usage is counted from their transcripts.

## Development

You need Node 22 or newer and pnpm.

```sh
pnpm install
pnpm dev                  # http://localhost:5173, with the bridge attached
pnpm test                 # vitest
pnpm typecheck
pnpm desktop:dist         # Windows installer in release/
pnpm desktop:dist:mac     # macOS (Apple silicon) .dmg and .zip in release/, ad-hoc signed
```

`pnpm desktop:pack` builds `release/win-unpacked/Sable.exe` without an installer. `pnpm desktop:dist:sable` packages into `release-sable/` instead, for when a copy running from `release/` keeps its files locked.

In a dev build the scripted Demo agent is available, so you can work on the interface without spending quota. In the browser console, `sable.demo('refactor the session module')` opens a Demo session and sends a prompt; keywords in the prompt pick what the Demo does. To see generative UI, try `chart`, `form`, `dashboard`, `diagram`, `table`, `widget` or `gallery`, for example `sable.demo('show me a chart of latency')`.

Architecture, conventions and design rules are in [CLAUDE.md](CLAUDE.md).

## Trademarks

Sable is an independent project and is not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; OpenAI and Codex are trademarks of OpenAI. The Claude and Codex marks shown next to each agent come from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) (MIT) and are used only to identify those products.

## License

[MIT](LICENSE)
