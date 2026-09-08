# Building the Creator Works MCP Launcher

The Tauri launcher provides a native GUI for discovering Unity projects, installing the bridge, and configuring Creator Works MCP for Codex or Claude Code. It builds on Windows and Linux (and macOS, with caveats around code signing).

## Prerequisites

### Windows

1. **Install Rust** (required for Tauri):
   ```powershell
   # Download and run rustup-init.exe from:
   # https://rustup.rs/

   # Or use winget:
   winget install Rustlang.Rustup
   ```

2. **Restart your terminal** after installing Rust

3. **Verify installation:**
   ```powershell
   rustc --version
   cargo --version
   ```

### Linux (CachyOS / Arch / Ubuntu)

1. **Install Rust and the Tauri system dependencies**:
   ```bash
   # Arch / CachyOS
   sudo pacman -S --needed rustup webkit2gtk-4.1 base-devel curl wget file libappindicator librsvg dpkg fakeroot binutils
   rustup default stable

   # Ubuntu / Debian
   sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf build-essential file
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
   ```

2. **Restart your terminal** or `source ~/.cargo/env`.

3. **Verify installation:**
   ```bash
   rustc --version
   cargo --version
   ```

## Building the App

### Windows

```powershell
Set-Location <path-to-creator-works-mcp>
npm ci
npm run release:launcher

# Install Tauri CLI
cargo install tauri-cli --version "^2"

# Build release version
Set-Location launcher
cargo tauri build
```

The built executable will be at:
```
launcher\src-tauri\target\release\creator-works-mcp-launcher.exe
```

A local Windows `cargo tauri build` produces the configured NSIS and MSI bundles under `launcher\src-tauri\target\release\bundle\`. The tagged GitHub release workflow intentionally requests NSIS only.

### Linux

```bash
cd <path-to-creator-works-mcp>
npm ci
npm run release:launcher

# Install Tauri CLI
cargo install tauri-cli --version "^2"

# Build release version
cd launcher
NO_STRIP=1 cargo tauri build
```

> **Note:** `NO_STRIP=1` works around a known incompatibility between the
> `strip` binary bundled inside Tauri's `linuxdeploy` AppImage and modern
> CachyOS / Arch toolchains (glibc 2.36+). The bundled `strip` does not
> recognise the `.relr.dyn` ELF section and aborts. Tauri's release binaries
> are already produced with debug info stripped by `cargo`, so the AppImage
> build is unaffected.

The bare release binary will be at:
```
launcher/src-tauri/target/release/creator-works-mcp-launcher
```

A local Linux build can produce `.deb`, `.rpm`, and `.AppImage` bundles under `launcher/src-tauri/target/release/bundle/`. Exact filenames follow the Tauri `productName` (`Creator Works MCP`) and target packaging conventions.

The build runs the standalone server bundle and smoke test, downloads the pinned official Node.js 24.17.0 archive for the host platform, verifies both the archive and extracted binary hashes, and packages the private runtime with the server, Unity bridge, `LICENSE`, and `THIRD_PARTY_NOTICES.md`. Archive pins match the official [Node.js v24.17.0 SHASUMS256.txt](https://nodejs.org/download/release/v24.17.0/SHASUMS256.txt); Unix binary pins were derived from `bin/node` inside those verified archives. The launcher resolves installed resources dynamically and does not require a `C:/tools/banter-mcp` checkout or system Node.js installation.

Run `cargo fmt --check` and `cargo test` in `launcher/src-tauri` before creating a release build. Building the launcher does not update an already installed copy under `%LOCALAPPDATA%` / `~/.local/share`; distribute or install the newly built artifact deliberately.

Version tags matching `v<package version>` run the multi-platform release workflow. It creates a draft release containing the Windows NSIS installer, Linux `.AppImage`, `.deb`, and `.rpm` bundles, macOS `.dmg` bundle, standalone Node 20+ ZIP, and a consolidated `SHA256SUMS.txt`. Version metadata must agree across `package.json`, the MCP handshake, Cargo, and Tauri configuration; verify it with `npm run check:version`.

## Code Signing

The repository does not contain code-signing certificates or signing secrets. Local builds and the default Windows release workflow are therefore unsigned and may trigger **Unknown publisher** or Microsoft Defender SmartScreen warnings. Before broad public distribution, sign the launcher and installer artifacts with the publisher's code-signing certificate and a trusted timestamp, then verify them with `Get-AuthenticodeSignature`. Continue publishing `SHA256SUMS.txt`; checksums verify artifact integrity but do not establish publisher identity.

## Development Mode

For development with hot-reload:
```bash
cargo tauri dev
```

## What the App Does

- **Discover Unity Hub projects** and select a project folder directly
- **Set up a first project and detected clients** in one action
- **Manage and switch between multiple Unity projects**
- **Configure Codex** (`~/.codex/config.toml`), Claude Code (`~/.claude.json`), Antigravity (`~/.gemini/config/mcp_config.json`), and OpenCode (`~/.config/opencode/opencode.jsonc`)
- **Install or update the Unity bridge** and show live readiness status
- **Use a private packaged Node.js runtime** for launcher-managed clients

## Alternative: Setup Scripts

The launcher is optional. The cross-platform Node CLI in `scripts/cli/setup.mjs` is the shared headless implementation. `setup.sh` wraps it on Linux/macOS; the existing Windows PowerShell flow remains supported and points to the Node CLI commands for Antigravity and OpenCode.

### Windows

```powershell
.\setup.bat
# Or
powershell -ExecutionPolicy Bypass -File setup.ps1
```

### Linux / macOS

```bash
./setup.sh                 # show command help
./setup.sh install         # build/validate the MCP server bundle
./setup.sh add-project "My Project" /path/to/UnityProject
./setup.sh list-projects
./setup.sh set-active 1
./setup.sh set-profile all
./setup.sh apply-claude
./setup.sh apply-codex
./setup.sh apply-antigravity
./setup.sh apply-opencode
./setup.sh install-bridge
./setup.sh config-path
```

The shell wrapper invokes `scripts/cli/setup.mjs` which calls into the cross-platform library at `scripts/cli/setup-lib.mjs`. The PowerShell setup script on Windows uses the same library so JSON / TOML file formats stay in sync.
