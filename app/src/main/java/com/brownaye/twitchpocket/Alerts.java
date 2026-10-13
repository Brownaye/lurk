package com.brownaye.twitchpocket;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

// Notifications: "X is live" (once per broadcast, whether the app or the background check noticed it), and the
// channels they are posted on.
final class Alerts {
    static final String LIVE = "live";
    static final String PLAYBACK = "playback";

    private Alerts() { }

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel live = new NotificationChannel(LIVE, "Going live", NotificationManager.IMPORTANCE_DEFAULT);
        live.setDescription("A favourite, or a channel with a heart, has gone live");
        nm.createNotificationChannel(live);
        NotificationChannel play = new NotificationChannel(PLAYBACK, "Now playing", NotificationManager.IMPORTANCE_LOW);
        play.setDescription("Shown while a stream is playing, so it can carry on with the screen off");
        play.setShowBadge(false);
        nm.createNotificationChannel(play);
    }

    static boolean allowed(Context c) {
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    // The broadcasts already known about (login -> when it started), so each is announced once.
    private static JSONObject seenMap(Context c) {
        try {
            String s = Store.get(c, "seen");
            return s.isEmpty() ? new JSONObject() : new JSONObject(s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    // Marks a broadcast as known. True if it was new.
    static synchronized boolean markSeen(Context c, String login, String startedAt) {
        JSONObject seen = seenMap(c);
        if (startedAt.equals(seen.optString(login))) return false;
        try { seen.put(login, startedAt); } catch (Exception e) { return false; }
        Store.set(c, "seen", seen.toString());
        return true;
    }

    // "X is live", unless this broadcast has been announced or noted before. Tapping it opens the stream.
    static void live(Context c, String login, String display, String title, String startedAt) {
        if (markSeen(c, login, startedAt)) post(c, login, display, title);
    }

    static void post(Context c, String login, String display, String title) {
        if (!allowed(c)) return;
        channels(c);
        Intent open = new Intent(c, MainActivity.class).putExtra("login", login).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, login.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(c, LIVE)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFF9146FF)
                .setContentTitle(display + " is live")
                .setContentText(title)
                .setStyle(new Notification.BigTextStyle().bigText(title))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_EVENT)
                .build();
        c.getSystemService(NotificationManager.class).notify(login, 1, n);
    }
}
