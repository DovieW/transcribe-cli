<p align="center">
  <img src="assets/transcribe-cli-logo.png" alt="transcribe-cli logo" width="180">
</p>

<h1 align="center">transcribe-cli</h1>

[![CI](https://github.com/DovieW/transcribe-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/DovieW/transcribe-cli/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A terminal transcription workbench for local media and YouTube. `transcribe`
combines an interactive TUI with a scriptable CLI, a resumable job engine, and
a local SQLite library.

It supports OpenAI, Microsoft MAI, Groq, Fireworks AI, and existing YouTube subtitles. API
keys can be saved in your system wallet using the TUI. Environment variables
remain supported and override saved credentials.

## Highlights

- Responsive workbench with Nerd Font icons, searchable actions, remembered navigation, and a noninteractive CLI
- Simultaneous transcription runs with independent progress and pause controls
- Local audio/video, individual YouTube videos, and playlists
- File picker: Enter selects the highlighted file or opens a folder; review lets you change the file
- Resumable chunked jobs with retries and configurable concurrency
- OpenAI speaker diarization
- Named alternate runs and AI-assisted transcript comparison
- Copy transcript from the run menu; searchable viewer, OSC 52 clipboard copy, and `$EDITOR` handoff
- TXT and JSON exports browse folders, then prompt for a filename and confirm the saved path
- TXT and structured JSON exports
- Private XDG storage with portable manifests beside every run

## Requirements

The prebuilt release currently supports Linux x86-64, including WSL 2.

- `ffmpeg` and `ffprobe` for local media and audio preparation
- `yt-dlp` for YouTube URLs and subtitles
- One provider key for hosted transcription, unless using YouTube subtitles

On Ubuntu or Debian:

```bash
sudo apt install ffmpeg yt-dlp
```

## Install

Install the latest standalone binary to `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/DovieW/transcribe-cli/master/install.sh | bash
```

Make sure `~/.local/bin` is on `PATH`, then inspect the runtime dependencies:

```bash
transcribe doctor
```

The installer verifies the release checksum before replacing the binary. Set
`TRANSCRIBE_INSTALL_DIR` to choose another destination or
`TRANSCRIBE_VERSION=v2.0.1` to install a specific release.

### Build from source

Building requires npm; the pinned development dependencies provide Bun and
TypeScript locally.

```bash
git clone https://github.com/DovieW/transcribe-cli.git
cd transcribe-cli
npm ci
npm test
npm run check
npm run build
install -Dm755 dist/transcribe ~/.local/bin/transcribe
```

After compilation, the `transcribe` executable does not require npm, Node.js,
or Bun.

## Workbench

The TUI keeps navigation on the left and shows a details or transcript preview pane
on wide terminals. Narrow terminals use a compact navigation bar and one content
pane. FiraCode Nerd Font Mono (or another Nerd Font) supplies the icons; select
**Settings → Appearance → Icon style** for plain symbols.

Type to filter the focused list. **Ctrl-P** opens the action palette, **F6** and
**Shift-F6** change panes, **F1** opens help, and **Esc** clears a list search or
goes back. Search and selection are remembered when you return. Mouse selection
and scrolling work alongside keyboard navigation. **Ctrl-Q** quits safely.

**New transcription** opens a file picker followed by one setup screen for the
run name, provider, model, language, speaker labels, and advanced options.
**Quick Transcribe** starts a local file with remembered defaults. **Library**
shows all runs with status filtering and an optional source-grouped view.

Runs continue while you browse, copy, export, or start more runs. There is no
app-level concurrency cap; each run retains its chunk concurrency and provider
retry settings. **Jobs** shows independent progress and pause controls.
**Ctrl-C** pauses all active runs; when idle it quits. Quitting with active runs
asks whether to pause them and waits for current work to settle before closing.
Jobs run inside the app, not as a detached service; interrupted runs can be
resumed manually from Library.

The pickers support **Ctrl-H** for Home, **Ctrl-D** for Downloads, **Ctrl-B** for
the parent folder, and **Tab** completion. Exports select a folder, then a
filename; existing files require confirmation before replacement. Appearance,
last-used folders, and the preferred library view are stored in `ui.json` beside
`config.json`. Provider credentials remain in the system wallet.

## Configure a provider

Open `transcribe` → **Authentication** → choose a provider → **Set API key**.
Type or paste the key into the masked field and press Enter. Keys persist in
KWallet on KDE, or in the desktop Secret Service on other Linux desktops.
Microsoft also has a **Set Speech endpoint** action. Saved credentials work
for both the TUI and CLI, including OpenAI comparison and subtitle cleanup.

You can replace a saved key or remove a provider's saved credentials from this
screen. Existing keys are never displayed. Removal leaves environment variables
in effect. Keys are passed to the wallet through private process pipes; they
are not written to settings, run manifests, logs, command arguments, or plaintext
credential files. The system wallet may prompt you to unlock or grant access.

KDE requires KWallet and `python3-dbus`; other Linux desktops require
`libsecret-tools` and an active Secret Service. Without a desktop wallet
(for example, a headless server or WSL without a secret service), use environment
variables. There is no plaintext storage fallback.

Alternatively, export the key for the provider you want to use:

```bash
export GROQ_API_KEY='...'
# or OPENAI_API_KEY / FIREWORKS_API_KEY
```

Keep keys out of Git. For source development, Bun loads the ignored `.env`
file automatically. The standalone binary uses saved wallet credentials and the process
environment; exported variables take precedence.

The OpenAI picker includes `gpt-transcribe`, `gpt-4o-transcribe`,
`gpt-4o-mini-transcribe`, `whisper-1`, and
`gpt-4o-transcribe-diarize`. Groq offers its Whisper Large v3 models, and
Fireworks offers its Whisper v3 models. Availability, limits, and billing are
controlled by each provider.

Microsoft offers `MAI-Transcribe-2` (default) and `MAI-Transcribe-1.5` through
the Azure Speech enhanced transcription API. Configure its key and endpoint
in Authentication, or export `AZURE_SPEECH_KEY` and
`AZURE_SPEECH_ENDPOINT=https://YOUR-RESOURCE.cognitiveservices.azure.com`.
Use `--provider microsoft --model MAI-Transcribe-2`; speaker labels are
available with `--diarize`. Use `--language auto` for automatic language
detection or a language code such as `en`. MAI does not use the freeform prompt
or continuity context settings. Azure resource region/model access is required.

MAI requires enhanced mode; the CLI always enables it. If Azure returns
`Enhanced mode with model is currently not supported yet`, check the resource
region and use the Speech endpoint from that resource's **Keys and Endpoint**.
Create a separate resource in a [supported LLM Speech region](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions#llm-speech)
(for example East US), then update both its key and endpoint in Authentication.
Environment variables override saved credentials, so update or unset any older
`AZURE_SPEECH_KEY` and `AZURE_SPEECH_ENDPOINT` values too.

See [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
and [Microsoft MAI transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe).

## Use

Run without arguments to open the TUI:

```bash
transcribe
```

Or use the CLI directly:

```bash
transcribe run recording.mp4 --name interview --provider openai --model gpt-4o-transcribe
transcribe run 'https://www.youtube.com/watch?v=...' --provider youtube-transcript
transcribe resume RUN_ID
transcribe restart RUN_ID
transcribe compare RUN_A RUN_B
transcribe export RUN_ID --format json --output ./transcript.json
transcribe settings
transcribe doctor
```

Run `transcribe --help` for every job setting.

## Data and privacy

New installations use:

- Configuration: `${XDG_CONFIG_HOME:-~/.config}/transcribe/config.json`
- Library: `${XDG_STATE_HOME:-~/.local/state}/transcribe`

Override these with `TRANSCRIBE_CONFIG_DIR` and `TRANSCRIBE_STATE_DIR`.
Settings, the SQLite database, source metadata, work files, and transcripts are
created with private permissions. Existing users of the earlier dotfiles build
continue using its library automatically and have their settings copied to the
new configuration path.

Local media is normalized on your machine, then audio chunks are uploaded to
the provider you select. YouTube mode also sends the URL to `yt-dlp`/YouTube.
Transcript comparison and optional subtitle cleanup use OpenAI. Review the
chosen provider's data policies before processing sensitive recordings.

## Development

```bash
npm ci
npm test
npm run check
npm run build
```

Tests mock network requests; they do not require provider keys or make paid API
calls. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## License

[MIT](LICENSE)
