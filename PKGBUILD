pkgname=vortex-json-viewer
pkgver=2.0.2
pkgrel=1
pkgdesc='Desktop viewer for large JSON datasets'
arch=('x86_64')
url='https://github.com/regalAdhikari-grepsr/vortex-JSON-viewer'
license=('unknown')
depends=('gtk3' 'webkit2gtk-4.1')
makedepends=('base-devel' 'nodejs' 'npm' 'rust')
source=("${url}/archive/refs/tags/v${pkgver}.tar.gz")
sha256sums=('SKIP')

build() {
  cd "${srcdir}/vortex-JSON-viewer-${pkgver}"
  npm ci
  npm run tauri -- build --no-bundle
}

package() {
  cd "${srcdir}/vortex-JSON-viewer-${pkgver}"
  install -Dm755 src-tauri/target/release/tauri-app "${pkgdir}/usr/bin/vortex-json-viewer"
  install -Dm644 src-tauri/icons/128x128.png "${pkgdir}/usr/share/icons/hicolor/128x128/apps/vortex-json-viewer.png"

  install -d "${pkgdir}/usr/share/applications"
  cat > "${pkgdir}/usr/share/applications/vortex-json-viewer.desktop" <<'EOF'
[Desktop Entry]
Name=Vortex JSON Viewer
Comment=Explore and search large JSON datasets
Exec=vortex-json-viewer %U
Icon=vortex-json-viewer
Terminal=false
Type=Application
Categories=Utility;
MimeType=application/json;application/x-ndjson;
EOF
}
