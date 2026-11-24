Prebuilt desktop JNI libraries for other machines, packed into the jar as-is:

    macos-aarch64/libniimblue_jni.dylib
    macos-x86_64/libniimblue_jni.dylib
    linux-x86_64/libniimblue_jni.so
    linux-aarch64/libniimblue_jni.so
    windows-x86_64/niimblue_jni.dll

Build one on the target machine with

    cmake -S native -B build-jni -DNIIM_BUILD_JNI=ON -DNIIM_BUILD_SHARED=OFF -DNIIM_BUILD_STATIC=OFF -DNIIM_BUILD_TESTS=OFF
    cmake --build build-jni --config Release --target niimblue_jni

The library for the machine running Gradle is built automatically.
