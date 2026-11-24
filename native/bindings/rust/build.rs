// Builds libniimblue (C + embedded QuickJS + niimbluelib bundle) as a static
// library with CMake and links it into the Rust crate. Nothing to install at
// runtime: the final binary is self-contained.
//
// NIIMBLUE_SRC overrides the C project location (defaults to ../.. of this crate).

use std::env;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = env::var("NIIMBLUE_SRC")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest.join("..").join(".."));

    for p in ["CMakeLists.txt", "include", "src", "generated", "third_party/quickjs", "cmake"] {
        println!("cargo:rerun-if-changed={}", src.join(p).display());
    }
    println!("cargo:rerun-if-env-changed=NIIMBLUE_SRC");

    let dst = cmake::Config::new(&src)
        .define("NIIM_BUILD_SHARED", "OFF")
        .define("NIIM_BUILD_STATIC", "ON")
        .define("NIIM_BUILD_TESTS", "OFF")
        .profile("Release")
        .build();

    println!("cargo:rustc-link-search=native={}", dst.join("lib").display());
    println!("cargo:rustc-link-search=native={}", dst.join("lib64").display());

    let target = env::var("TARGET").unwrap();
    if target.contains("msvc") {
        println!("cargo:rustc-link-lib=static=niimblue_static");
    } else {
        println!("cargo:rustc-link-lib=static=niimblue");
    }

    if target.contains("linux") || target.contains("android") {
        println!("cargo:rustc-link-lib=pthread");
        println!("cargo:rustc-link-lib=m");
        println!("cargo:rustc-link-lib=dl");
    }
}
