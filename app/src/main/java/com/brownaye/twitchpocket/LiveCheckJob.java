package com.brownaye.twitchpocket;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

// Alerts with the app closed: about every 15 minutes (Android decides exactly when, and stretches it while the
// phone is idle) this asks Twitch which followed channels are live and announces favourites and hearts that have
// gone live since the last look (including ones added from search, which are not followed on Twitch). While the app is open it does nothing: the app checks every minute itself.
public class LiveCheckJob extends JobService {
    private static final int ID = 1;

    static void schedule(Context c, boolean on) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (!on) { js.cancel(ID); return; }
        if (js.getPendingJob(ID) != null) return;
        js.schedule(new JobInfo.Builder(ID, new ComponentName(c, LiveCheckJob.class))
                .setPeriodic(15 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        if (MainActivity.started) return false;
        new Thread(() -> {
            try { check(getApplicationContext()); } catch (Exception e) { /* next time */ }
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }

    private static Set<String> logins(JSONObject prefs, String key) {
        Set<String> out = new HashSet<>();
        JSONArray a = prefs.optJSONArray(key);
        for (int i = 0; a != null && i < a.length(); i++) out.add(a.optString(i));
        return out;
    }

    static void check(Context c) throws Exception {
        String rawPrefs = Store.get(c, "prefs");
        JSONObject prefs = rawPrefs.isEmpty() ? new JSONObject() : new JSONObject(rawPrefs);
        if (!prefs.optBoolean("alerts")) return;
        String rawAuth = Store.get(c, "auth");
        if (rawAuth.isEmpty()) return;
        JSONObject auth = new JSONObject(rawAuth);
        String userId = auth.optJSONObject("user") == null ? "" : auth.getJSONObject("user").optString("id");
        if (userId.isEmpty()) return;

        // Refresh tokens are single use: whoever refreshes saves the new pair here, and the app reads it back.
        if (auth.optLong("expiresAt") - System.currentTimeMillis() < 5 * 60 * 1000L) {
            String refresh = auth.optString("refresh");
            if (refresh.isEmpty()) return;
            Map<String, String> form = new HashMap<>();
            form.put("Content-Type", "application/x-www-form-urlencoded");
            Store.Response r = Store.http("POST", "https://id.twitch.tv/oauth2/token", form,
                    "client_id=" + Store.CLIENT_ID + "&grant_type=refresh_token&refresh_token=" + URLEncoder.encode(refresh, "UTF-8"));
            if (r.status != 200) return; // offline, or refused: the app sorts that out when it is next opened
            JSONObject t = new JSONObject(r.text);
            auth.put("access", t.getString("access_token"));
            if (!t.optString("refresh_token").isEmpty()) auth.put("refresh", t.getString("refresh_token"));
            auth.put("expiresAt", System.currentTimeMillis() + t.optLong("expires_in", 3600) * 1000L);
            Store.set(c, "auth", auth.toString());
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("Client-Id", Store.CLIENT_ID);
        headers.put("Authorization", "Bearer " + auth.getString("access"));
        Set<String> wanted = logins(prefs, "favourites");
        wanted.addAll(logins(prefs, "hearts"));
        // The first look after alerts are switched on only notes who is live, so it does not announce everyone.
        boolean baseline = Store.get(c, "baseline").isEmpty();
        String after = "";
        for (int page = 0; page < 5; page++) {
            Store.Response r = Store.http("GET", "https://api.twitch.tv/helix/streams/followed?first=100&user_id=" + userId
                    + (after.isEmpty() ? "" : "&after=" + URLEncoder.encode(after, "UTF-8")), headers, null);
            if (r.status != 200) return;
            JSONObject j = new JSONObject(r.text);
            JSONArray data = j.optJSONArray("data");
            for (int i = 0; data != null && i < data.length(); i++) {
                JSONObject s = data.getJSONObject(i);
                String login = s.optString("user_login").toLowerCase();
                String startedAt = s.optString("started_at");
                if (baseline || !wanted.contains(login)) Alerts.markSeen(c, login, startedAt);
                else Alerts.live(c, login, s.optString("user_name", login), s.optString("title"), startedAt);
            }
            JSONObject pg = j.optJSONObject("pagination");
            after = pg == null ? "" : pg.optString("cursor");
            if (after.isEmpty()) break;
        }
        // Channels added from search are not followed on Twitch, so they are asked about by name.
        StringBuilder q = new StringBuilder();
        int asked = 0;
        for (String login : logins(prefs, "extra")) {
            if (!wanted.contains(login) || asked >= 100) continue;
            q.append("&user_login=").append(URLEncoder.encode(login, "UTF-8"));
            asked++;
        }
        if (asked > 0) {
            Store.Response r = Store.http("GET", "https://api.twitch.tv/helix/streams?first=100" + q, headers, null);
            if (r.status != 200) return;
            JSONArray data = new JSONObject(r.text).optJSONArray("data");
            for (int i = 0; data != null && i < data.length(); i++) {
                JSONObject s = data.getJSONObject(i);
                String login = s.optString("user_login").toLowerCase();
                if (baseline) Alerts.markSeen(c, login, s.optString("started_at"));
                else Alerts.live(c, login, s.optString("user_name", login), s.optString("title"), s.optString("started_at"));
            }
        }
        if (baseline) Store.set(c, "baseline", "1");
    }
}
