package com.raadfxrd.tvlauncher

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.SystemClock
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * window.TVBridge.nowPlaying() for the screensaver page: what's playing on
 * the TV right now (any app that publishes a media session: Tidal, Jellyfin,
 * Spotify…), as JSON, or "" when nothing plays or access isn't granted.
 */
class NowPlaying(private val context: Context) {

    private val sessions = context.getSystemService(MediaSessionManager::class.java)
    private val listener = ComponentName(context, MediaListener::class.java)

    // Album art is encoded once per track, not on every poll.
    private var artKey: String? = null
    private var artData: String? = null

    @JavascriptInterface
    fun nowPlaying(): String {
        val controller = try {
            sessions.getActiveSessions(listener).firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
        } catch (e: SecurityException) {
            null // notification access not granted yet
        } ?: return ""
        return describe(controller).toString()
    }

    private fun describe(controller: MediaController): JSONObject {
        val meta = controller.metadata
        val state = controller.playbackState
        val title = meta?.getString(MediaMetadata.METADATA_KEY_TITLE).orEmpty()
        val artist = meta?.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: meta?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST).orEmpty()
        val duration = meta?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L
        var position = state?.position ?: 0L
        if (state != null && state.lastPositionUpdateTime > 0) {
            position += ((SystemClock.elapsedRealtime() - state.lastPositionUpdateTime) * state.playbackSpeed).toLong()
        }
        val key = "${controller.packageName}|$title|$artist"
        if (key != artKey) {
            artKey = key
            artData = meta?.let { encodeArt(it) }
        }
        return JSONObject()
            .put("playing", true)
            .put("title", title)
            .put("artist", artist)
            .put("app", appLabel(controller.packageName))
            .put("positionMs", if (duration > 0) position.coerceIn(0, duration) else position)
            .put("durationMs", duration)
            .put("art", artData ?: JSONObject.NULL)
    }

    private fun encodeArt(meta: MediaMetadata): String? {
        val bitmap = meta.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: meta.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: meta.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
            ?: return null
        val side = 256
        val scaled = Bitmap.createScaledBitmap(bitmap, side, side * bitmap.height / bitmap.width.coerceAtLeast(1), true)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 85, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun appLabel(pkg: String): String = try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) {
        pkg
    }
}
