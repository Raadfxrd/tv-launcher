package com.raadfxrd.tvlauncher

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.media.tv.TvContract
import android.media.tv.TvInputInfo
import android.media.tv.TvInputManager
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * window.TVBridge for the launcher page: the installed TV apps (with their
 * banners), opening an app, switching to an HDMI input, opening Settings, and
 * "now playing" (shared with the screensaver).
 */
class LauncherBridge(private val activity: Activity) {

    private val pm: PackageManager = activity.packageManager
    private val nowPlaying = NowPlaying(activity.applicationContext)
    private val worker = Executors.newSingleThreadExecutor()

    // Banners are turned into images once, off the main thread; the page asks
    // again until they're ready.
    @Volatile private var appsJson: String? = null

    init { refreshApps() }

    fun refreshApps() {
        worker.execute { appsJson = buildApps() }
    }

    private fun buildApps(): String {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
        val list = JSONArray()
        pm.queryIntentActivities(intent, 0)
            .filter { it.activityInfo.packageName != activity.packageName }
            .distinctBy { it.activityInfo.packageName }
            .sortedBy { it.loadLabel(pm).toString().lowercase() }
            .forEach { info ->
                val pkg = info.activityInfo.packageName
                val banner = info.activityInfo.loadBanner(pm)
                    ?: runCatching { pm.getApplicationBanner(pkg) }.getOrNull()
                list.put(
                    JSONObject()
                        .put("pkg", pkg)
                        .put("label", info.loadLabel(pm).toString())
                        .put("banner", banner?.let { encode(it) } ?: JSONObject.NULL)
                )
            }
        return list.toString()
    }

    private fun encode(drawable: Drawable): String {
        val bitmap = Bitmap.createBitmap(320, 180, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, 320, 180)
        drawable.draw(Canvas(bitmap))
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun apps(): String = appsJson ?: ""

    @JavascriptInterface
    fun launch(pkg: String): Boolean {
        val intent = pm.getLeanbackLaunchIntentForPackage(pkg) ?: pm.getLaunchIntentForPackage(pkg) ?: return false
        activity.runOnUiThread { activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        return true
    }

    /** Switches to "HDMI n" by its label as the TV shows it ("HDMI 3"). */
    @JavascriptInterface
    fun hdmi(number: Int): Boolean {
        val tv = activity.getSystemService(TvInputManager::class.java) ?: return false
        val inputs = tv.tvInputList.filter { it.type == TvInputInfo.TYPE_HDMI }
        val input = inputs.firstOrNull { Regex("\\b$number\\b").containsMatchIn(it.loadLabel(activity).toString()) }
            ?: inputs.sortedBy { it.id }.getOrNull(number - 1)
            ?: return false
        val intent = Intent(Intent.ACTION_VIEW, TvContract.buildChannelUriForPassthroughInput(input.id))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.runOnUiThread { activity.startActivity(intent) }
        return true
    }

    @JavascriptInterface
    fun openSettings() {
        activity.runOnUiThread { activity.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    @JavascriptInterface
    fun nowPlaying(): String = nowPlaying.nowPlaying()
}
