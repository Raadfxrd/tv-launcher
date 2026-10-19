package com.raadfxrd.tvlauncher

import android.service.dreams.DreamService
import android.webkit.WebView

/** The screensaver: the ambient page, full screen, not interactive. */
class ScreensaverService : DreamService() {

    private var web: WebView? = null

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        isInteractive = false
        isFullscreen = true
        isScreenBright = true
        web = AmbientWebView.create(this).also { setContentView(it) }
    }

    override fun onDreamingStarted() {
        super.onDreamingStarted()
        web?.onResume()
    }

    override fun onDreamingStopped() {
        web?.onPause()
        super.onDreamingStopped()
    }

    override fun onDetachedFromWindow() {
        web?.destroy()
        web = null
        super.onDetachedFromWindow()
    }
}
