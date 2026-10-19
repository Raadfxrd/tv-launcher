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
    @Volatile private var builtAt = 0L

    init { refreshApps() }

    /* Installs don't always announce themselves (the Play Store on the A1
       doesn't reliably), so the list is also rebuilt on every return home and
       whenever the page asks and the list is older than 15 seconds. */
    fun refreshApps() {
        builtAt = System.currentTimeMillis()
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
    fun apps(): String {
        if (System.currentTimeMillis() - builtAt > 15_000) refreshApps()
        return appsJson ?: ""
    }

    @JavascriptInterface
    fun launch(pkg: String): Boolean {
        val intent = pm.getLeanbackLaunchIntentForPackage(pkg) ?: pm.getLaunchIntentForPackage(pkg) ?: return false
        activity.runOnUiThread { activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        return true
    }

    /**
     * Switches to HDMI port [number]. The TV may call that input "HDMI 3", a
     * name you gave it, or the device it sees on it over HDMI-CEC ("Apple TV").
     * In that order: the port labelled with its number, then an input with
     * [name], then the port by position.
     */
    @JavascriptInterface
    fun hdmi(number: Int, name: String): Boolean {
        val tv = activity.getSystemService(TvInputManager::class.java) ?: return false
        val inputs = tv.tvInputList.filter { it.type == TvInputInfo.TYPE_HDMI }
        val label = { info: TvInputInfo -> info.loadLabel(activity).toString() }
        val portPattern = Regex("hdmi\\s*$number\\b", RegexOption.IGNORE_CASE)
        val ports = inputs.filter { it.parentId == null }
        val input = ports.firstOrNull { portPattern.containsMatchIn(label(it)) }
            ?: inputs.firstOrNull { name.isNotBlank() && label(it).contains(name, ignoreCase = true) }
            ?: ports.sortedBy { it.id }.getOrNull(number - 1)
            ?: return false
        val intent = Intent(Intent.ACTION_VIEW, TvContract.buildChannelUriForPassthroughInput(input.id))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.runOnUiThread { activity.startActivity(intent) }
        return true
    }

    /**
     * The HDMI inputs with something connected, as JSON: one entry per port,
     * named after the device on it when the TV knows it over HDMI-CEC
     * ("PlayStation 5"), otherwise the port's own label. Ports that are
     * disconnected are left out, so the home screen never shows dead inputs.
     */
    @JavascriptInterface
    fun inputs(): String {
        val tv = activity.getSystemService(TvInputManager::class.java) ?: return "[]"
        val all = tv.tvInputList.filter { it.type == TvInputInfo.TYPE_HDMI }
        val label = { info: TvInputInfo -> info.loadLabel(activity).toString() }
        val ports = all.filter { it.parentId == null }.sortedBy { it.id }
        val out = JSONArray()
        // Only ports with a device behind them that says who it is (HDMI-CEC) and
        // is switched on. The A1 reports every port as connected whether or not
        // there's a cable in it, so the port's own state can't be trusted.
        ports.forEachIndexed { index, port ->
            val device = all.firstOrNull { it.parentId == port.id } ?: return@forEachIndexed
            val state = runCatching { tv.getInputState(device.id) }.getOrDefault(TvInputManager.INPUT_STATE_CONNECTED)
            if (state != TvInputManager.INPUT_STATE_CONNECTED) return@forEachIndexed
            val number = Regex("(\\d+)").find(label(port))?.value?.toIntOrNull() ?: (index + 1)
            out.put(
                JSONObject()
                    .put("id", device.id)
                    .put("number", number)
                    .put("name", label(device))
            )
        }
        return out.toString()
    }

    @JavascriptInterface
    fun openInput(id: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, TvContract.buildChannelUriForPassthroughInput(id))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.runOnUiThread { runCatching { activity.startActivity(intent) } }
        return true
    }

    @JavascriptInterface
    fun openSettings() {
        activity.runOnUiThread { activity.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    @JavascriptInterface
    fun nowPlaying(): String = nowPlaying.nowPlaying()
}
