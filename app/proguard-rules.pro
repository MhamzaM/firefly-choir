# Methods called from JavaScript must keep their names.
-keepclassmembers class io.github.mhamzam.fireflychoir.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
