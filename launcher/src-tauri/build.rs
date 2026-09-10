fn main() {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let manifest =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("hosted_payload.rs");
    let mut output =
        std::fs::File::create(manifest).expect("Cannot create hosted payload identity");
    writeln!(output, "pub const FILES: &[(&str, &str)] = &[").unwrap();
    let runtime = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        ("runtime/node.exe", "../../release/runtime/node.exe")
    } else {
        ("runtime/node", "../../release/runtime/node")
    };
    for (name, source) in [
        (
            "creator-works-mcp.mjs",
            "../../release/creator-works-mcp.mjs",
        ),
        runtime,
        (
            "unity-extension/Editor/BanterMCPBridge.cs",
            "../../unity-extension/Editor/BanterMCPBridge.cs",
        ),
        (
            "unity-extension/Editor/CreatorWorksMCPLogo.png",
            "../../unity-extension/Editor/CreatorWorksMCPLogo.png",
        ),
    ] {
        println!("cargo:rerun-if-changed={source}");
        let mut file =
            std::fs::File::open(source).expect("Build the release payload before the launcher");
        let mut digest = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let count = file.read(&mut buffer).expect("Cannot hash release payload");
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        writeln!(
            output,
            "({name:?}, {:?}),",
            format!("{:x}", digest.finalize())
        )
        .unwrap();
    }
    writeln!(output, "]; ").unwrap();
    tauri_build::build();
    // Tauri emits the Windows manifest for bin targets only. The native smoke
    // example also needs Common Controls v6, or its imports fail before main.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let resource =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        println!("cargo:rustc-link-arg-examples={}", resource.display());
    }
}
