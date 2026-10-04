#!/usr/bin/env python3
"""Build/run the Foundation asset contract test without touching app data or dependencies."""
import http.server
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="wfloat-next-assets-") as tmp:
    root = Path(tmp)
    fixtures = root / "fixtures"
    fixtures.mkdir()
    (fixtures / "model.bin").write_bytes(os.urandom(2 * 1024 * 1024))
    espeak = fixtures / "espeak-ng-data"
    espeak.mkdir()
    (espeak / "phondata").write_bytes(b"test phondata")
    (espeak / "phontab").write_bytes(b"test phontab")
    subprocess.run(["aa", "archive", "-d", str(espeak), "-o", str(fixtures / "espeak.aar")], check=True)
    ranges = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            payload = (fixtures / self.path.lstrip("/")).read_bytes()
            start = 0
            if self.headers.get("Range"):
                start = int(self.headers["Range"].split("=")[1].split("-")[0])
                ranges.append(start)
            self.send_response(206 if start else 200)
            self.send_header("Content-Length", str(len(payload)-start))
            if start: self.send_header("Content-Range", f"bytes {start}-{len(payload)-1}/{len(payload)}")
            self.end_headers()
            try:
                for i in range(start, len(payload), 16384):
                    self.wfile.write(payload[i:i+16384]); self.wfile.flush(); time.sleep(0.004)
            except (BrokenPipeError, ConnectionResetError): pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        exe = root / "assets-test"
        subprocess.run(["xcrun", "clang++", "-fobjc-arc", "-std=c++17", "-framework", "Foundation", "-lAppleArchive", str(HERE / "assets_test.mm"), str(HERE.parent / "WfloatNextAssets.mm"), "-o", str(exe)], check=True)
        subprocess.run([str(exe), f"http://127.0.0.1:{server.server_port}", str(fixtures), str(root / "assets")], check=True, timeout=60)
        assert ranges and ranges[0] > 0, "Resume never sent a Range request"
    finally:
        server.shutdown(); server.server_close()
