package com.raadfxrd.tvlauncher

import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Pages here are drawn at 1920×1080. The app knows the WebView's exact size,
 * so it tells the page (window.__fit) after every load and every layout change
 * instead of trusting the WebView's own idea of the viewport.
 */
object PageFit {
    fun apply(view: WebView) {
        val density = view.resources.displayMetrics.density
        val w = view.width / density
        val h = view.height / density
        if (w <= 0f || h <= 0f) return
        view.evaluateJavascript("window.__fit && window.__fit($w, $h)", null)
    }

    fun install(view: WebView) {
        view.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ -> apply(v as WebView) }
    }

    fun client(): WebViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            apply(view)
        }
    }
}
