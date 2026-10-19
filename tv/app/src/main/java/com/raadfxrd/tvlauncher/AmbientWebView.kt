package com.raadfxrd.tvlauncher

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * The screensaver is a web page served from the same Vercel project as the
 * feed, so the design can change without reinstalling the app. This sets up
 * the WebView that shows it and hands the page "now playing" through
 * window.TVBridge.
 */
object AmbientWebView {

    fun pageUrl(): String = Uri.parse("${BuildConfig.FEED_BASE}/screensaver/")
        .buildUpon()
        .appendQueryParameter("token", BuildConfig.FEED_TOKEN)
        .build()
        .toString()

    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context): WebView = WebView(context).apply {
        setBackgroundColor(Color.BLACK)
        isFocusable = false
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        // The page is laid out at 1920×1080; scale it to whatever the TV's
        // WebView reports (often 960×540 at 2× density).
        settings.useWideViewPort = false
        settings.loadWithOverviewMode = false   // the page fits itself (see its fit script)
        settings.setSupportZoom(false)
        webViewClient = WebViewClient()
        addJavascriptInterface(NowPlaying(context.applicationContext), "TVBridge")
        loadUrl(pageUrl())
    }
}
