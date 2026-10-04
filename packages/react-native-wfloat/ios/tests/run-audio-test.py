#!/usr/bin/env python3
"""Compile a tiny simulator app against real audio helpers; no RN engine stubs."""
from pathlib import Path
import plistlib
import subprocess
import tempfile
import sys
HERE = Path(__file__).resolve().parent
DEVICE = sys.argv[1] if len(sys.argv) > 1 else "booted"
BUNDLE = "com.wfloat.next-audio-contract-test"
sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], text=True).strip()
with tempfile.TemporaryDirectory(prefix="wfloat-next-audio-") as tmp:
    app = Path(tmp) / "AudioTest.app"
    app.mkdir()
    with (app / "Info.plist").open("wb") as f:
        plistlib.dump({"CFBundleIdentifier": BUNDLE, "CFBundleExecutable": "AudioTest", "CFBundleName": "Wfloat Audio Test", "CFBundlePackageType": "APPL", "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0", "MinimumOSVersion": "15.1", "UIDeviceFamily": [1,2], "UILaunchScreen": {}}, f)
    subprocess.run(["xcrun", "clang++", "-fobjc-arc", "-std=c++17", "-target", "arm64-apple-ios15.1-simulator", "-isysroot", sdk,
                    "-I", str(HERE.parent.parent / "example/ios/Pods/Headers/Public/React-Core"), "-framework", "Foundation", "-framework", "UIKit", "-framework", "AVFoundation", "-lAppleArchive",
                    str(HERE / "audio_test.mm"), str(HERE.parent / "WfloatNextAudio.mm"), str(HERE.parent / "WfloatNextAssets.mm"), "-o", str(app / "AudioTest")], check=True)
    subprocess.run(["xcrun", "simctl", "install", DEVICE, str(app)], check=True, timeout=90)
    try:
        result = subprocess.run(["xcrun", "simctl", "launch", "--console", "--terminate-running-process", DEVICE, BUNDLE], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        print(result.stdout)
        if "PASS:" not in result.stdout: raise SystemExit("Audio contract test did not pass")
    finally:
        try:
            subprocess.run(["xcrun", "simctl", "uninstall", DEVICE, BUNDLE], check=False, timeout=20)
        except subprocess.TimeoutExpired:
            print("Simulator uninstall timed out; test bundle remains installed:", BUNDLE)
