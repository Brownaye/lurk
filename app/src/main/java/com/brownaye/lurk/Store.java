package com.brownaye.lurk;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

// What has to be readable with the app's pages closed: the Twitch sign-in and the few preferences the background
// check needs (kept in the app's private preferences), and plain HTTPS requests.
final class Store {
    static final String CLIENT_ID = "2w915iqawzht7yok0cbsu6ecjlqaqk"; // public: device code sign-in, no secret

    private Store() { }

    static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("tp", Context.MODE_PRIVATE);
    }

    static String get(Context c, String key) {
        return prefs(c).getString(key, "");
    }

    static void set(Context c, String key, String value) {
        prefs(c).edit().putString(key, value == null ? "" : value).apply();
    }

    static final class Response {
        final int status; // 0: never reached the server
        final String text;

        Response(int status, String text) {
            this.status = status;
            this.text = text;
        }
    }

    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static Response http(String method, String url, Map<String, String> headers, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            if (headers != null) for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            if (body != null && !body.isEmpty()) {
                c.setDoOutput(true);
                try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            return new Response(status, in == null ? "" : read(in));
        } catch (Exception e) {
            return new Response(0, String.valueOf(e.getMessage()));
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
