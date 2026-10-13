package com.brownaye.lurk;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;

// Runs while something is playing, so Android keeps the app (and the sound) going with the screen off. It shows
// the "now playing" notification with a Stop button, and holds the phone's CPU and Wi-Fi awake meanwhile.
public class PlaybackService extends Service {
    private static final String STOP = "com.brownaye.lurk.STOP";
    static volatile Runnable onStop; // set by the activity: stop the video

    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    static void start(Context c, String what) {
        try {
            c.startForegroundService(new Intent(c, PlaybackService.class).putExtra("what", what));
        } catch (Exception e) { /* not allowed right now: playing carries on, just without the screen-off help */ }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, PlaybackService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lurk:playback");
        wake.setReferenceCounted(false);
        wake.acquire(12 * 60 * 60 * 1000L);
        WifiManager wm = getApplicationContext().getSystemService(WifiManager.class);
        if (wm != null) {
            wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "lurk:playback");
            wifi.setReferenceCounted(false);
            wifi.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            Runnable r = onStop;
            if (r != null) r.run();
            stopSelf();
            return START_NOT_STICKY;
        }
        Alerts.channels(this);
        String what = intent == null ? "" : String.valueOf(intent.getStringExtra("what"));
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, PlaybackService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, Alerts.PLAYBACK)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFF9146FF)
                .setContentTitle(what.isEmpty() ? "Playing" : what)
                .setContentText("Lurk")
                .setContentIntent(open)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .build();
        startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
