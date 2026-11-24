fn main() {
    // 只改图标时 tauri.conf.json 不变，Cargo 不会重编 Windows 资源，exe 会一直用旧图标。
    for path in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/icon.icns",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    tauri_build::build()
}
