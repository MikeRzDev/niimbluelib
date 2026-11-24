// swift-tools-version:5.9
//
// Swift package `Niimblue`: the native niimbluelib (native/, C + embedded QuickJS)
// compiled by SwiftPM, with a Swift API in native/bindings/swift. macOS, iOS and Linux.
// It sits at the repository root because SwiftPM only reads manifests there.
//
//   .package(url: "https://github.com/MultiMote/niimbluelib.git", branch: "main")
//   .package(path: "../niimbluelib")
//   .product(name: "Niimblue", package: "niimbluelib")
import PackageDescription

let package = Package(
    name: "Niimblue",
    platforms: [.macOS(.v11), .iOS(.v14)],
    products: [
        .library(name: "Niimblue", targets: ["Niimblue"]),
    ],
    targets: [
        // The C library. The .c files here only #include the real sources (src/,
        // generated/, third_party/quickjs/), so they exist once in the repository.
        .target(
            name: "CNiimblue",
            path: "native/bindings/swift/Sources/CNiimblue",
            cSettings: [
                .headerSearchPath("../../../../include"),
                .headerSearchPath("../../../../third_party/quickjs"),
                .define("NIIM_STATIC"),
                .define("QUICKJS_NG_BUILD"),
                .define("_GNU_SOURCE", .when(platforms: [.linux])),
            ],
            linkerSettings: [
                .linkedLibrary("m", .when(platforms: [.linux])),
                .linkedLibrary("pthread", .when(platforms: [.linux])),
                .linkedLibrary("dl", .when(platforms: [.linux])),
            ]
        ),
        .target(
            name: "Niimblue",
            dependencies: ["CNiimblue"],
            path: "native/bindings/swift/Sources/Niimblue"
        ),
        .testTarget(
            name: "NiimblueTests",
            dependencies: ["Niimblue"],
            path: "native/bindings/swift/Tests/NiimblueTests"
        ),
    ]
)
