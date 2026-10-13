package com.brownaye.twitchpocket;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Rational;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// One screen, two web views. "ui" is the app itself (assets/www: who is live, sign-in, chat). "player" shows
// player.twitch.tv above it while a stream is on, and doubles as the browser for Twitch's sign-in page so that
// logging in there also logs the player in (same cookies).
// Portrait: player on top at 16:9, chat below. Landscape while watching: the player fills the screen. Leaving the
// app while watching shrinks it to a picture-in-picture window. The Hearts card (a channel with a heart went live)
// and the sleep timer live here rather than in the pages, so they work over the video whichever way it is shown.
public class MainActivity extends Activity {
    private static final int BG = Color.rgb(14, 14, 16);
    // Hides Twitch's own title bar and content warning card over the video, as the desktop app does.
    private static final String CLEAN_CSS = ".top-bar, .top-bar *, .disclosure-card, "
            + "[data-test-selector=\"content-classification-warning-disclosure-overlay\"] "
            + "{ visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }";

    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final Handler main = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private LinearLayout column;
    private LinearLayout authBar;
    private TextView authCode;
    private FrameLayout playerBox;
    private WebView ui;
    private WebView player;

    private View customView; // the video, when Twitch's own full screen button is used
    private WebChromeClient.CustomViewCallback customCallback;
    private boolean watching;
    private boolean authMode;
    private String authUrl = "";
    private volatile boolean cleanPlayer = true;
    private volatile boolean pipEnabled = true;
    private volatile boolean resumed;
    private volatile boolean inPip;

    private LinearLayout heartCard;
    private ImageView heartAvatar;
    private TextView heartName;
    private TextView heartSub;
    private TextView heartLeft;
    private String heartLogin = "";
    private int heartSecs;
    private final Runnable heartTick = this::heartCountdown;
    private final Runnable sleepNow = this::sleep;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Inspecting the pages over USB is for debug builds only: it would expose the sign-in to anyone with a cable.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        root.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        authBar = buildAuthBar();
        column.addView(authBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        playerBox = new FrameLayout(this);
        playerBox.setBackgroundColor(Color.BLACK);
        player = buildPlayer();
        playerBox.addView(player, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        column.addView(playerBox, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));

        ui = buildUi();
        column.addView(ui, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        heartCard = buildHeartCard();
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        hp.setMargins(dp(10), dp(10), dp(10), 0);
        root.addView(heartCard, hp);

        setContentView(root);
        applyLayout();
        ui.loadUrl("file:///android_asset/www/index.html");
    }

    // ---------- views ----------
    private LinearLayout buildAuthBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.rgb(24, 24, 27));
        int pad = dp(10);
        bar.setPadding(pad, dp(4), dp(4), dp(4));
        authCode = new TextView(this);
        authCode.setTextColor(Color.rgb(239, 239, 241));
        authCode.setTextSize(14);
        bar.addView(authCode, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button browser = new Button(this, null, android.R.attr.borderlessButtonStyle);
        browser.setText("Use browser");
        browser.setTextColor(Color.rgb(191, 148, 255));
        browser.setAllCaps(false);
        browser.setOnClickListener(v -> { openExternal(authUrl); closeSignInPage(); });
        bar.addView(browser);
        Button close = new Button(this, null, android.R.attr.borderlessButtonStyle);
        close.setText("Cancel");
        close.setTextColor(Color.rgb(173, 173, 184));
        close.setAllCaps(false);
        close.setOnClickListener(v -> { closeSignInPage(); js("window.__signInClosed && window.__signInClosed()"); });
        bar.addView(close);
        return bar;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView buildUi() {
        WebView w = new WebView(this);
        w.setBackgroundColor(BG);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        w.addJavascriptInterface(new Bridge(), "Native");
        w.setWebChromeClient(new WebChromeClient());
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme())) return false;
                openExternal(u.toString());
                return true;
            }
        });
        return w;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView buildPlayer() {
        WebView w = new WebView(this);
        w.setBackgroundColor(Color.BLACK);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        // Twitch's pages are friendlier to plain mobile Chrome than to something announcing itself as a web view.
        s.setUserAgentString(WebSettings.getDefaultUserAgent(this).replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (authMode || !request.isForMainFrame()) return false;
                String host = String.valueOf(request.getUrl().getHost());
                if (host.equals("player.twitch.tv")) return false;
                openExternal(request.getUrl().toString()); // a link out of the player (the channel page, an ad)
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (cleanPlayer && url != null && url.startsWith("https://player.twitch.tv/")) {
                    view.evaluateJavascript("(() => { if (document.getElementById('tp-clean')) return; const s = document.createElement('style');"
                            + " s.id = 'tp-clean'; s.textContent = " + JSONObject.quote(CLEAN_CSS) + "; document.head.appendChild(s); })()", null);
                }
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view;
                customCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                column.setVisibility(View.GONE);
                heartCard.bringToFront();
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                immersive(true);
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }
        });
        return w;
    }

    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        if (customCallback != null) customCallback.onCustomViewHidden();
        customCallback = null;
        column.setVisibility(View.VISIBLE);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        applyLayout();
    }

    // ---------- hearts ----------
    // "X is live" with a Switch now button and a countdown, top right over the video for 10 seconds.
    private LinearLayout buildHeartCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(10), dp(8), dp(6), dp(8));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(245, 21, 24, 33));
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), Color.argb(150, 255, 92, 138));
        card.setBackground(bg);
        card.setElevation(dp(8));
        card.setVisibility(View.GONE);

        heartAvatar = new ImageView(this);
        heartAvatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        heartAvatar.setBackgroundColor(Color.rgb(38, 38, 44));
        heartAvatar.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setOval(0, 0, view.getWidth(), view.getHeight());
            }
        });
        heartAvatar.setClipToOutline(true);
        card.addView(heartAvatar, new LinearLayout.LayoutParams(dp(36), dp(36)));

        LinearLayout text = new LinearLayout(this);
        text.setOrientation(LinearLayout.VERTICAL);
        heartName = new TextView(this);
        heartName.setTextColor(Color.rgb(255, 194, 211));
        heartName.setTextSize(14);
        heartName.setTypeface(Typeface.DEFAULT_BOLD);
        heartName.setSingleLine(true);
        heartName.setEllipsize(TextUtils.TruncateAt.END);
        heartName.setMaxWidth(dp(170));
        text.addView(heartName);
        heartSub = new TextView(this);
        heartSub.setTextColor(Color.rgb(173, 173, 184));
        heartSub.setTextSize(12);
        heartSub.setSingleLine(true);
        heartSub.setEllipsize(TextUtils.TruncateAt.END);
        heartSub.setMaxWidth(dp(170));
        text.addView(heartSub);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.setMargins(dp(9), 0, dp(9), 0);
        card.addView(text, tp);

        TextView go = new TextView(this);
        go.setText("Switch now");
        go.setTextColor(Color.WHITE);
        go.setTextSize(13);
        go.setTypeface(Typeface.DEFAULT_BOLD);
        go.setPadding(dp(12), dp(8), dp(12), dp(8));
        GradientDrawable gb = new GradientDrawable();
        gb.setColor(Color.rgb(255, 92, 138));
        gb.setCornerRadius(dp(9));
        go.setBackground(gb);
        go.setOnClickListener(v -> {
            String login = heartLogin;
            hideHeart(false);
            js("window.__heartSwitch && window.__heartSwitch(" + JSONObject.quote(login) + ")");
        });
        card.addView(go);

        heartLeft = new TextView(this);
        heartLeft.setTextColor(Color.rgb(173, 173, 184));
        heartLeft.setTextSize(13);
        heartLeft.setTypeface(Typeface.DEFAULT_BOLD);
        heartLeft.setGravity(Gravity.CENTER);
        heartLeft.setOnClickListener(v -> hideHeart(true));
        card.addView(heartLeft, new LinearLayout.LayoutParams(dp(38), dp(36)));
        return card;
    }

    private void showHeart(String login, String display, String title, String avatar) {
        if (!watching || authMode || inPip || !resumed) { js("window.__heartDone && window.__heartDone(false)"); return; }
        main.removeCallbacks(heartTick);
        heartLogin = login;
        heartName.setText("♥ " + display + " is live");
        heartSub.setText(title);
        heartSub.setVisibility(title.isEmpty() ? View.GONE : View.VISIBLE);
        heartAvatar.setImageDrawable(null);
        if (avatar.startsWith("https://")) {
            io.execute(() -> {
                try (InputStream in = new URL(avatar).openStream()) {
                    final Bitmap b = BitmapFactory.decodeStream(in);
                    main.post(() -> { if (login.equals(heartLogin)) heartAvatar.setImageBitmap(b); });
                } catch (Exception e) { /* no picture: the grey circle stays */ }
            });
        }
        heartSecs = 10;
        heartLeft.setText("10");
        heartCard.bringToFront();
        heartCard.animate().cancel();
        heartCard.setVisibility(View.VISIBLE);
        heartCard.setAlpha(0f);
        heartCard.setTranslationX(dp(48));
        heartCard.animate().alpha(1f).translationX(0f).setDuration(350).withEndAction(null).start();
        main.postDelayed(heartTick, 1000);
    }

    private void heartCountdown() {
        if (heartLogin.isEmpty()) return;
        heartSecs--;
        if (heartSecs <= 0) { hideHeart(true); return; }
        heartLeft.setText(String.valueOf(heartSecs));
        main.postDelayed(heartTick, 1000);
    }

    // tell: let the page know the card is gone, so the next one in the queue can show.
    private void hideHeart(boolean tell) {
        main.removeCallbacks(heartTick);
        if (heartLogin.isEmpty()) return;
        heartLogin = "";
        heartCard.animate().alpha(0f).translationX(dp(48)).setDuration(250).withEndAction(() -> heartCard.setVisibility(View.GONE)).start();
        if (tell) js("window.__heartDone && window.__heartDone(true)");
    }

    // ---------- sleep timer ----------
    // Fades the sound out over 15 seconds, then stops the video and lets the screen go off.
    private void sleep() {
        if (!watching || authMode) return;
        player.evaluateJavascript("(() => { const v = document.querySelector('video'); if (!v) return; const s = v.volume; let i = 0;"
                + " const t = setInterval(() => { i++; v.volume = Math.max(0, s * (1 - i / 30));"
                + " if (i >= 30) { clearInterval(t); v.pause(); v.volume = s; } }, 500); })()", null);
        main.postDelayed(() -> js("window.__slept && window.__slept()"), 16000);
    }

    // ---------- picture-in-picture ----------
    private PictureInPictureParams pipParams() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(16, 9));
        Rect r = new Rect();
        if (playerBox.getGlobalVisibleRect(r) && !r.isEmpty()) b.setSourceRectHint(r);
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(watching && pipEnabled && !authMode);
        return b.build();
    }

    private void updatePip() {
        try { setPictureInPictureParams(pipParams()); } catch (Exception e) { /* no picture-in-picture on this device */ }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT < 31 && watching && pipEnabled && !authMode) {
            try { enterPictureInPictureMode(pipParams()); } catch (Exception e) { /* not allowed right now */ }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean in, Configuration c) {
        super.onPictureInPictureModeChanged(in, c);
        inPip = in;
        if (in) hideHeart(true);
        applyLayout();
    }

    // ---------- layout ----------
    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void applyLayout() {
        boolean land = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        boolean full = watching && (land || inPip) && !authMode;
        authBar.setVisibility(authMode && !inPip ? View.VISIBLE : View.GONE);
        playerBox.setVisibility(watching || authMode ? View.VISIBLE : View.GONE);
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) playerBox.getLayoutParams();
        if (authMode || full) {
            lp.height = 0;
            lp.weight = 1f;
        } else {
            lp.weight = 0f;
            lp.height = Math.round(getResources().getDisplayMetrics().widthPixels * 9f / 16f);
        }
        playerBox.setLayoutParams(lp);
        ui.setVisibility(authMode || full ? View.GONE : View.VISIBLE);
        if (customView == null) immersive(full && !inPip);
        if (watching) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        js("window.__layout && window.__layout(" + (full ? "true" : "false") + ")");
        playerBox.post(this::updatePip);
    }

    private void immersive(boolean on) {
        getWindow().setDecorFitsSystemWindows(!on);
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        if (on) {
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsets.Type.systemBars());
        } else {
            c.show(WindowInsets.Type.systemBars());
        }
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        applyLayout();
    }

    // ---------- actions (main thread) ----------
    private void js(String code) {
        if (ui != null) ui.evaluateJavascript(code, null);
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { /* nothing can open it */ }
    }

    private void play(String url) {
        if (authMode) return;
        watching = true;
        player.onResume();
        player.loadUrl(url);
        applyLayout();
    }

    private void stop() {
        hideCustomView();
        hideHeart(true);
        watching = false;
        if (!authMode) player.loadUrl("about:blank");
        applyLayout();
    }

    private void openSignInPage(String url, String code) {
        hideCustomView();
        watching = false;
        authMode = true;
        authUrl = url;
        authCode.setText("Code: " + code);
        player.loadUrl(url);
        applyLayout();
    }

    private void closeSignInPage() {
        if (!authMode) return;
        authMode = false;
        player.loadUrl("about:blank");
        player.clearHistory();
        applyLayout();
    }

    @Override
    public void onBackPressed() {
        if (customView != null) { hideCustomView(); return; }
        if (authMode) {
            if (player.canGoBack()) player.goBack();
            else { closeSignInPage(); js("window.__signInClosed && window.__signInClosed()"); }
            return;
        }
        ui.evaluateJavascript("(window.__back && window.__back()) ? 1 : 0", v -> { if (!"1".equals(v)) moveTaskToBack(true); });
    }

    // Shrinking to picture-in-picture also pauses the activity: the video carries on. It stops when the app is
    // really out of sight (onStop: sent to the background, the small window closed, the screen off).
    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        if (!isInPictureInPictureMode()) player.onPause();
        js("window.__pause && window.__pause(" + (isInPictureInPictureMode() ? "true" : "false") + ")");
    }

    @Override
    protected void onStop() {
        super.onStop();
        player.onPause();
        js("window.__pause && window.__pause(false)");
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (isInPictureInPictureMode()) player.onResume();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        player.onResume();
        js("window.__resume && window.__resume()");
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        io.shutdownNow();
        player.destroy();
        ui.destroy();
        super.onDestroy();
    }

    // ---------- what the app's pages can ask for ----------
    private static boolean allowedHost(String host) {
        return host != null && (host.equals("id.twitch.tv") || host.equals("api.twitch.tv") || host.equals("7tv.io")
                || host.equals("api.betterttv.net") || host.equals("api.frankerfacez.com"));
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private class Bridge {
        // An HTTPS request made outside the page (no CORS). Answers through window.__native.httpDone(id, status, body);
        // status 0 means it never reached the server.
        @JavascriptInterface
        public void http(final String id, final String method, final String url, final String headersJson, final String body) {
            io.execute(() -> {
                int status = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    URL u = new URL(url);
                    if (!"https".equals(u.getProtocol()) || !allowedHost(u.getHost())) throw new IOException("host not allowed");
                    c = (HttpURLConnection) u.openConnection();
                    c.setRequestMethod(method);
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(15000);
                    JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                        String k = it.next();
                        c.setRequestProperty(k, h.getString(k));
                    }
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
                    }
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    text = in == null ? "" : read(in);
                } catch (Exception e) {
                    status = 0;
                    text = String.valueOf(e.getMessage());
                } finally {
                    if (c != null) c.disconnect();
                }
                final String code = "window.__native && window.__native.httpDone(" + JSONObject.quote(id) + "," + status + "," + JSONObject.quote(text) + ")";
                main.post(() -> js(code));
            });
        }

        @JavascriptInterface
        public void play(final String url) {
            if (url == null || !url.startsWith("https://player.twitch.tv/")) return;
            main.post(() -> MainActivity.this.play(url));
        }

        @JavascriptInterface
        public void stop() {
            main.post(MainActivity.this::stop);
        }

        @JavascriptInterface
        public void signInPage(final String url, final String code) {
            if (url == null || !url.startsWith("https://www.twitch.tv/")) return;
            main.post(() -> openSignInPage(url, code));
        }

        @JavascriptInterface
        public void closeSignIn() {
            main.post(MainActivity.this::closeSignInPage);
        }

        @JavascriptInterface
        public void openExternal(final String url) {
            if (url == null || !url.startsWith("https://")) return;
            main.post(() -> MainActivity.this.openExternal(url));
        }

        // Where the video is: answers through window.__native.sampled with the position, length, whether it is
        // paused and its ready state as a JSON string, or null when there is no video on the page.
        @JavascriptInterface
        public void sample() {
            main.post(() -> {
                if (!watching || authMode) return;
                player.evaluateJavascript("(() => { const v = document.querySelector('video'); return v ? JSON.stringify({ t: v.currentTime,"
                        + " d: v.duration, paused: v.paused, ready: v.readyState }) : null; })()",
                        value -> js("window.__native && window.__native.sampled && window.__native.sampled(" + (value == null ? "null" : value) + ")"));
            });
        }

        // Settings > Player: whether Twitch's title bar over the video is hidden. Applies from the next stream opened.
        @JavascriptInterface
        public void setClean(boolean on) {
            cleanPlayer = on;
        }

        // Settings > Player: keep playing in a small window when leaving the app.
        @JavascriptInterface
        public void setPip(boolean on) {
            pipEnabled = on;
            main.post(MainActivity.this::updatePip);
        }

        // Whether a card over the video would be seen right now: something is on, in front, at full size.
        @JavascriptInterface
        public boolean playerInSight() {
            return watching && !authMode && resumed && !inPip;
        }

        // The Hearts card: {login, display, title, avatar}. When it goes away the page gets __heartDone(shown),
        // or __heartSwitch(login) if Switch now was pressed.
        @JavascriptInterface
        public void heart(final String json) {
            main.post(() -> {
                try {
                    JSONObject o = new JSONObject(json);
                    showHeart(o.optString("login"), o.optString("display"), o.optString("title"), o.optString("avatar"));
                } catch (Exception e) {
                    js("window.__heartDone && window.__heartDone(false)");
                }
            });
        }

        // Sleep timer: stop in this many milliseconds (0 cancels). The page gets __slept() once it has.
        @JavascriptInterface
        public void sleepIn(final double ms) {
            main.post(() -> {
                main.removeCallbacks(sleepNow);
                if (ms > 0) main.postDelayed(sleepNow, (long) ms);
            });
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        // Signing out: the player forgets its Twitch login too.
        @JavascriptInterface
        public void clearCookies() {
            main.post(() -> { CookieManager.getInstance().removeAllCookies(null); CookieManager.getInstance().flush(); });
        }
    }
}
