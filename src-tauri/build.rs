fn main() {
    // Stage from the selected dependency's actual CMake output on every app
    // build. Cached dependencies do not rerun their build script; stale DLLs
    // beside an executable must not silently select a different runtime.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let source = std::path::PathBuf::from(
            std::env::var("DEP_WHISPER_RUNTIME_DIR").expect("Whisper runtime directory"),
        );
        println!("cargo:rerun-if-changed={}", source.display());
        let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let profile = out.ancestors().nth(3).unwrap();
        let bundle = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("../native");
        // Debug and release share the bundle input directory. A debug build
        // may replace its DLLs while the release build script remains cached.
        // Watch the destination too so the next release restores its own DLLs.
        println!("cargo:rerun-if-changed={}", bundle.display());
        for directory in [profile.to_path_buf(), profile.join("deps"), bundle] {
            std::fs::create_dir_all(&directory).unwrap();
            for entry in std::fs::read_dir(&source).unwrap() {
                let entry = entry.unwrap();
                if entry.path().extension().is_some_and(|s| s == "dll") {
                    let destination = directory.join(entry.file_name());
                    let bytes = std::fs::read(entry.path()).unwrap();
                    if std::fs::read(&destination).ok().as_ref() != Some(&bytes) {
                        std::fs::write(destination, bytes).unwrap();
                    }
                }
            }
        }
    }
    tauri_build::build();
}
