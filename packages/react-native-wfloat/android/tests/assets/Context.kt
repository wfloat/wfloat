package android.content
// Host-only seam: production code receives the real Android Context.
class Context(val noBackupFilesDir: java.io.File)
