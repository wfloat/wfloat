package com.k2fsa.sherpa.onnx;

public class Vad {
    private long ptr = 0;

    public Vad(VadModelConfig config) {
        ptr = newFromFile(config);
        if (ptr == 0) {
            throw new IllegalArgumentException("Invalid VadModelConfig: failed to create native Vad");
        }
    }

    @Override
    protected void finalize() throws Throwable {
        release();
    }

    public void release() {
        if (this.ptr == 0) {
            return;
        }
        delete(this.ptr);
        this.ptr = 0;
    }

    public void acceptWaveform(float[] samples) {
        acceptWaveform(this.ptr, samples);
    }

    public boolean empty() {
        return empty(this.ptr);
    }

    public void pop() {
        pop(this.ptr);
    }

    public void reset() {
        reset(this.ptr);
    }

    public void flush() {
        flush(this.ptr);
    }

    public SpeechSegment front() {
        return front(this.ptr);
    }

    private native void delete(long ptr);

    private native long newFromFile(VadModelConfig config);

    private native void acceptWaveform(long ptr, float[] samples);

    private native boolean empty(long ptr);

    private native void pop(long ptr);

    private native SpeechSegment front(long ptr);

    private native void reset(long ptr);

    private native void flush(long ptr);

    static {
        System.loadLibrary("sherpa-onnx-jni");
    }
}
