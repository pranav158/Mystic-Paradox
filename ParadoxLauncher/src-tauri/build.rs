use std::path::Path;

fn main() {
    // The optional P2P module is compiled in when its folder is present (src/p2p). Whether co-op is used is decided at
    // runtime (p2p/mod.rs); without the folder the launcher is dedicated-only. Guard's integrity measurements are
    // public code (launch/guard_checks.rs) and need no folder of their own.
    println!("cargo:rustc-check-cfg=cfg(mystic_p2p)");
    let p2p = Path::new("src/p2p/mod.rs").exists();
    // Watch the module when present, otherwise the source tree, so adding or removing it reruns this.
    println!(
        "cargo:rerun-if-changed={}",
        if p2p { "src/p2p" } else { "src" }
    );
    if p2p {
        println!("cargo:rustc-cfg=mystic_p2p");
    }
    tauri_build::build()
}
