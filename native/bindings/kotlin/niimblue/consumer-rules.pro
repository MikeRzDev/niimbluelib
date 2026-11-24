# The JNI layer registers natives on NiimNative and calls these by name.
-keep class io.github.multimote.niimblue.NiimNative { native <methods>; }
-keep class io.github.multimote.niimblue.NiimException { <init>(int, java.lang.String); }
-keep interface io.github.multimote.niimblue.NiimEventListener { void onEvent(java.lang.String, java.lang.String); }
-keep interface io.github.multimote.niimblue.NiimTransport { boolean write(byte[]); }
-keep class * implements io.github.multimote.niimblue.NiimEventListener { void onEvent(java.lang.String, java.lang.String); }
-keep class * implements io.github.multimote.niimblue.NiimTransport { boolean write(byte[]); }
