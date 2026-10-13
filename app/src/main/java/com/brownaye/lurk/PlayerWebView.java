package com.brownaye.lurk;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

// The web view the Twitch player runs in. Normally a web view that goes out of sight (the screen turning off, the
// app in the background) tells its page so, and the video stops. With keepVisible set it does not pass that on, so
// the stream carries on with the screen off; the activity pauses it itself when it should stop.
public class PlayerWebView extends WebView {
    volatile boolean keepVisible;

    public PlayerWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(keepVisible ? View.VISIBLE : visibility);
    }
}
