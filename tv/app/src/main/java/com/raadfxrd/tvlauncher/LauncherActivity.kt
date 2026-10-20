package com.raadfxrd.tvlauncher

import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.WebView
import androidx.core.content.ContextCompat

/**
 * The home screen. The page ships inside the app (assets/launcher), so Home
 * opens instantly and works offline; only the cards' data comes from the feed.
 * The WebView lives as long as the activity, so returning home never reloads.
 */
class LauncherActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var bridge: LauncherBridge

    // Installing or removing an app refreshes the app rows.
    private val packagesChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            bridge.refreshApps()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bridge = LauncherBridge(this)
        // Lets Chrome on a computer connected over adb inspect the page (chrome://inspect).
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.useWideViewPort = false
            settings.loadWithOverviewMode = false   // the page fits itself (see its fit script)
            settings.setSupportZoom(false)
            settings.allowFileAccess = true
            webViewClient = PageFit.client()
            PageFit.install(this)
            addJavascriptInterface(bridge, "TVBridge")
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(web)
        val url = Uri.parse("file:///android_asset/launcher/index.html").buildUpon()
            .appendQueryParameter("api", BuildConfig.FEED_BASE)
            .appendQueryParameter("token", BuildConfig.FEED_TOKEN)
            .build()
        web.loadUrl(url.toString())
        web.requestFocus()

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_CHANGED)
            addDataScheme("package")
        }
        ContextCompat.registerReceiver(this, packagesChanged, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    // Pressing Home while already home: back to the first app.
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        web.evaluateJavascript("window.goHome && window.goHome()", null)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        bridge.refreshApps()
        web.requestFocus()
        web.evaluateJavascript("window.onLauncherResume && window.onLauncherResume()", null)
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    // Back does nothing on the home screen.
    @Deprecated("Deprecated in Java")
    // Back closes whatever the page has open (the routes panel); otherwise nothing.
    override fun onBackPressed() {
        web.evaluateJavascript("window.onBack && window.onBack()", null)
    }

    override fun onDestroy() {
        unregisterReceiver(packagesChanged)
        web.destroy()
        super.onDestroy()
    }
}
