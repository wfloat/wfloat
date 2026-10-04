# JNI calls this callback by name; retain it in minified consumer applications.
-keepclassmembers class com.wfloat.WfloatNextModule {
    private void nativeEvent(java.lang.String, java.lang.String);
    native <methods>;
}
