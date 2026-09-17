package com.wfloat.bench;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.TrafficStats;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import org.json.JSONObject;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.DatagramSocket;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Test APK only. Runs in the target app's UID while the real dashboard collects. */
public class NetworkTransferInstrumentation extends Instrumentation {
  private Bundle arguments;
  @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
  private void boundary(String stage) throws Exception {
    JSONObject row = new JSONObject().put("stage", stage).put("uid", Process.myUid()).put("pid", Process.myPid())
      .put("uptimeMs", SystemClock.elapsedRealtime()).put("wallMs", System.currentTimeMillis())
      .put("received", Long.toString(TrafficStats.getUidRxBytes(Process.myUid())))
      .put("sent", Long.toString(TrafficStats.getUidTxBytes(Process.myUid())))
      .put("receivedPackets", Long.toString(TrafficStats.getUidRxPackets(Process.myUid())))
      .put("sentPackets", Long.toString(TrafficStats.getUidTxPackets(Process.myUid())));
    Log.i("WfloatNetworkProbe", row.toString());
  }
  @Override public void onStart() {
    Socket socket = new Socket();
    long deadlineAt = SystemClock.elapsedRealtime() + 90000;
    java.util.concurrent.atomic.AtomicReference<DatagramSocket> udpSocket = new java.util.concurrent.atomic.AtomicReference<>();
    java.util.concurrent.ScheduledExecutorService deadline = Executors.newSingleThreadScheduledExecutor();
    deadline.schedule(() -> {
      try { socket.close(); } catch (Exception ignored) {}
      DatagramSocket udp = udpSocket.get(); if (udp != null) udp.close();
    }, 90, TimeUnit.SECONDS);
    Bundle result = new Bundle();
    try {
      String host = arguments.getString("host");
      int port = Integer.parseInt(arguments.getString("port"));
      if (host == null || host.isEmpty()) throw new IllegalArgumentException("Supply the controlled server host and port");
      Intent launch = getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if (launch == null) throw new IllegalStateException("Missing launch activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      Thread.sleep(10000);
      long rx0 = TrafficStats.getUidRxBytes(Process.myUid()), tx0 = TrafficStats.getUidTxBytes(Process.myUid());
      if (rx0 < 0 || tx0 < 0) throw new IllegalStateException("TrafficStats unavailable on this device");
      boundary("idle_end");
      socket.connect(new InetSocketAddress(host, port), 5000);
      socket.setSoTimeout(10000);
      OutputStream output = socket.getOutputStream(); InputStream input = socket.getInputStream();
      byte[] block = new byte[65536];
      for (int i = 0; i < block.length; ++i) block[i] = (byte)(i % 251);
      boundary("upload_start");
      for (int i = 0; i < 32; ++i) { output.write(block); output.flush(); Thread.sleep(250); }
      if (input.read() != 1) throw new IllegalStateException("Server rejected upload contents");
      Thread.sleep(8000); // Allow accounting to settle; not a source cadence guarantee.
      boundary("upload_settled");
      output.write(2); output.flush();
      boundary("download_start");
      int received = 0;
      while (received < 4 * 1024 * 1024) {
        int count = input.read(block, 0, Math.min(block.length, 4 * 1024 * 1024 - received));
        if (count < 0) throw new IllegalStateException("Truncated download");
        for (int i = 0; i < count; ++i)
          if ((block[i] & 255) != ((received + i) % 65536) % 251) throw new IllegalStateException("Download contents differ");
        received += count;
      }
      if (input.read() != -1) throw new IllegalStateException("Unexpected extra download bytes");
      socket.close();
      Thread.sleep(8000);
      boundary("download_settled");
      long rxDelta = TrafficStats.getUidRxBytes(Process.myUid()) - rx0;
      long txDelta = TrafficStats.getUidTxBytes(Process.myUid()) - tx0;
      if (rxDelta < 4 * 1024 * 1024 || txDelta < 2 * 1024 * 1024)
        throw new IllegalStateException("Network counters did not cover the known payloads: rx=" + rxDelta + " tx=" + txDelta);
      if ("true".equals(arguments.getString("packetCheck"))) {
        boundary("udp_idle");
        try (DatagramSocket udp = new DatagramSocket()) {
          udpSocket.set(udp);
          if (SystemClock.elapsedRealtime() >= deadlineAt) throw new IllegalStateException("Check deadline elapsed");
          udp.setSoTimeout(5000); udp.connect(InetAddress.getByName(host), port);
          long stopAt = SystemClock.elapsedRealtime() + 15000;
          for (int i = 0; i < 32; ++i) {
            if (SystemClock.elapsedRealtime() >= stopAt) throw new IllegalStateException("UDP check timed out");
            byte[] payload = new byte[128]; java.util.Arrays.fill(payload, (byte)i);
            udp.send(new DatagramPacket(payload, payload.length));
            DatagramPacket reply = new DatagramPacket(new byte[129], 129); udp.receive(reply);
            if (reply.getLength() != payload.length) throw new IllegalStateException("UDP reply size differs");
            for (int j = 0; j < payload.length; ++j)
              if (reply.getData()[j] != payload[j]) throw new IllegalStateException("UDP reply content differs");
            Thread.sleep(50);
          }
        }
        Thread.sleep(8000);
        boundary("udp_settled");
      }
      result.putString("stream", "Verified 2097152 upload and 4194304 download payload bytes. UID counter deltas: rx=" + rxDelta + " tx=" + txDelta + "\n");
      finish(Activity.RESULT_OK, result);
    } catch (Exception error) {
      Log.e("WfloatNetworkProbe", "Transfer failed", error);
      result.putString("stream", "FAILED: " + error + "\n"); finish(Activity.RESULT_CANCELED, result);
    } finally { deadline.shutdownNow(); try { socket.close(); } catch (Exception ignored) {} }
  }
}
