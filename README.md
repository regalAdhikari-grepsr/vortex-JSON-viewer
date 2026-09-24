# Vortex JSON Viewer

Vortex JSON Viewer is a desktop app for exploring large JSON datasets. Open a local file, browse its records, inspect nested values, search specific fields, and find duplicate rows. File processing happens locally on your computer.

Built with Tauri, Rust, and vanilla JavaScript, Vortex indexes records in a memory-mapped file and renders only the visible rows. This lets you explore datasets without loading the entire document into a JSON tree at once. This means you will be able to view large JSON datasets easily using very low memory and CPU, and also perform blazingly fast search / index duplicates.

## Features

- **Browse records:** scroll through row previews and inspect each record in an expandable JSON tree.
- **Search quickly:** find text across raw JSON, including keys and values, with optional case sensitivity or regex-matching.
- **Search specific fields:** select key paths, enter nested paths such as `user.email` or `items.0.sku`, and optionally use regular expressions.
- **Find duplicates:** group matching rows by their entire contents or a combination of selected fields, then jump to a record for inspection.
- **Navigate with the keyboard:** move between records and search results without reaching for the mouse.
- **Customize the interface:** choose light or dark mode, accent colors, fonts, and text sizes. Appearance settings are saved locally.

## Download

Visit [GitHub Releases](https://github.com/regalAdhikari-grepsr/vortex-JSON-viewer/releases) and choose the package for your computer:

| Platform | Package |
| --- | --- |
| Linux x64 | `.AppImage` |
| Windows x64 | `.msi` or `.exe` installer |
| macOS Apple Silicon | ARM64 `.dmg` |
| macOS Intel | x64 `.dmg` |

On Linux, make the downloaded AppImage executable before opening it. On Windows, run the installer. On macOS, open the DMG and copy the app to Applications.

## Getting started

1. Click **Open File…** and choose a `.json`, `.jsonl`, or `.ndjson` file.
2. Select a row to inspect its contents. Expand nested objects and arrays in the detail pane.
3. Type in the search box to find matching rows, or open **Advanced Search** to search selected fields.
4. Open **Find Duplicates** and choose **Entire row** or **Selected keys** to compare records.
5. Open **Appearance** using the settings button to adjust the interface.

Key suggestions come from the first record. If your field is missing from the list, add its path manually.

### File formats

| Format | How records are displayed |
| --- | --- |
| Top-level JSON array | Each array element becomes a row. |
| JSON Lines / NDJSON with one object per line | Each non-empty line becomes a row. |
| Single JSON object on one line | The object appears as one row. |

For example, this JSON array opens as two rows:

```json
[
  { "id": 1, "user": { "email": "alex@example.com" } },
  { "id": 2, "user": { "email": "sam@example.com" } }
]
```

**Current format limitation:** a standalone object formatted across multiple lines is detected as JSON Lines. Compact it to one line or wrap it in a top-level array before opening it.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+F` / `Cmd+F` | Focus the search box |
| `↑` / `↓` | Select the previous or next row when no input or dialog is active |
| `Enter` / `Shift+Enter` | Go to the next or previous match while the search box is focused |
| `Esc` | Close an open dialog |

### Working with large files

Search reports the total number of matching rows and exposes the first 5,000 for navigation. Case-insensitive basic search caches a lowercase copy of the file, which increases memory usage. Advanced search and comparisons by selected fields parse records and can take longer on large datasets.

Vortex is a viewer: duplicate detection identifies groups for inspection and does not remove records or modify your file.

## Development

Install Node.js with npm, a stable Rust toolchain, and the system dependencies for your platform from the [Tauri 2 prerequisites guide](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/regalAdhikari-grepsr/vortex-JSON-viewer.git
cd vortex-JSON-viewer
npm ci
npm run tauri -- dev
```

The frontend is served directly from `src/`; there is no separate frontend build step.

To create a release build, run the command for your operating system:

| Platform | Command |
| --- | --- |
| Linux | `npm run tauri -- build --bundles appimage` |
| Windows | `npm run tauri -- build --bundles msi,nsis` |
| macOS | `npm run tauri -- build --bundles dmg` |

For these builds, packages are written under `src-tauri/target/release/bundle/`.

### macOS release signing

The macOS workflow uses ad hoc signing until Apple credentials are configured. Ad hoc signing may still require users to approve the app in Privacy & Security. To have Apple verify the downloaded app without that manual override, sign it with a **Developer ID Application** certificate and notarize it through Apple. This requires an Apple Developer account that supports notarization.

Add these values under the repository's **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 encoded `.p12` export of the Developer ID Application certificate, including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` file |
| `APPLE_SIGNING_IDENTITY` | Full certificate identity, such as `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Create the base64 certificate value with `openssl base64 -A -in certificate.p12`. Once these secrets are set, rerun the workflow or create a new version tag to build signed and notarized DMGs. The workflow checks for all required secrets and falls back to ad hoc signing when `APPLE_CERTIFICATE` is absent.

### Project layout

| Path | Purpose |
| --- | --- |
| `src/` | HTML, CSS, and JavaScript interface |
| `src-tauri/src/dataset.rs` | File indexing, record access, search, and duplicate detection |
| `src-tauri/src/commands.rs` | Commands connecting the interface to the Rust backend |
| `src-tauri/tauri.conf.json` | App metadata, window settings, and bundle configuration |
| `.github/workflows/config.yml` | Builds for Linux, Windows, and macOS; publishes releases on `v*` tags |
