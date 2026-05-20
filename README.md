# PYLOT — Multi-Agent Session Manager

Desktop app for managing Claude Code, Codex, and Copilot CLI sessions in one place.

## Features

- Unified terminal with GPU-accelerated rendering (xterm.js + WebGL)
- Session history scanning and one-click resume
- Multi-tab terminal with rename support (right-click or double-click)
- Active agent detection and workspace info
- Word-delete keybindings (Ctrl+Backspace, Option+arrows)

## Build from Source (macOS)

### Prerequisites

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install Node.js (v20+) — via Homebrew
brew install node
```

### Build & Run

```bash
# Clone the repo
git clone https://github.com/BrenoForever/pylot.git
cd pylot

# Install dependencies
npm ci

# Run in development mode
npm run tauri dev

# Build production release
npm run tauri build
```

The built app will be at:
- `src-tauri/target/release/bundle/macos/PYLOT.app`
- `src-tauri/target/release/bundle/dmg/PYLOT_0.1.0_aarch64.dmg`

### Install (unsigned app)

Since the app is not code-signed, macOS will block it. After building or downloading:

```bash
# Copy to Applications
cp -R src-tauri/target/release/bundle/macos/PYLOT.app /Applications/

# Remove quarantine and ad-hoc sign
xattr -cr /Applications/PYLOT.app
codesign --force --deep --sign - /Applications/PYLOT.app

# Open
open /Applications/PYLOT.app
```

## Build from Source (Windows)

### Prerequisites

- [Node.js v20+](https://nodejs.org/)
- [Rust](https://rustup.rs/)
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (with "Desktop development with C++")

### Build

```bash
git clone https://github.com/BrenoForever/pylot.git
cd pylot
npm ci
npm run tauri build
```

Installers at `src-tauri/target/release/bundle/nsis/` and `src-tauri/target/release/bundle/msi/`.

## License

MIT
