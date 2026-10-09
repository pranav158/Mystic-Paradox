use std::path::Path;

fn main() {
    // Optional modules are compiled in when their folders are present: the P2P module (src/p2p) and, with it,
    // the private anti-cheat module (src/anticheat). Whether co-op is used is decided at runtime (p2p/mod.rs);
    // without the folders the launcher is dedicated-only and Guard runs as Guard Lite.
    println!("cargo:rustc-check-cfg=cfg(mystic_p2p)");
    println!("cargo:rustc-check-cfg=cfg(mystic_anticheat)");
    let p2p = Path::new("src/p2p/mod.rs").exists();
    let anticheat = p2p && Path::new("src/anticheat/mod.rs").exists();
    // Watch the modules when present, otherwise the source tree, so adding or removing one reruns this.
    for (present, folder) in [(p2p, "src/p2p"), (anticheat, "src/anticheat")] {
        println!(
            "cargo:rerun-if-changed={}",
            if present { folder } else { "src" }
        );
    }
    if p2p {
        println!("cargo:rustc-cfg=mystic_p2p");
    }
    if anticheat {
        println!("cargo:rustc-cfg=mystic_anticheat");
    }
    tauri_build::build()
}
