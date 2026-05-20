# PYLOT — Multi-Agent Session Manager

Desktop app for managing Claude Code, Codex, and Copilot CLI sessions in one place.

## Features

- Unified terminal with GPU-accelerated rendering (xterm.js + WebGL)
- Session history scanning and one-click resume
- Multi-tab terminal with rename support (right-click or double-click)
- Active agent detection and workspace info

## Install

Download the latest release from [Releases](https://github.com/BrenoForever/pylot/releases).

### macOS

1. Download `PYLOT_0.1.0_aarch64.dmg` (Apple Silicon) or `PYLOT_0.1.0_x64.dmg` (Intel)
2. Open the `.dmg` and drag **PYLOT** to your Applications folder
3. The app is unsigned, so macOS will block it. Open Terminal and run:

```bash
xattr -cr /Applications/PYLOT.app
codesign --force --deep --sign - /Applications/PYLOT.app
```

4. Open PYLOT from Applications normally

### Windows

1. Download `PYLOT_0.1.0_x64-setup.exe`
2. Run the installer
3. If Windows Defender shows a warning, click **"More info" → "Run anyway"**

## License

MIT
