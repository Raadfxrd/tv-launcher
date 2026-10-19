package com.raadfxrd.tvlauncher

import android.service.notification.NotificationListenerService

/**
 * Android only lets an app read other apps' media sessions (what Tidal is
 * playing) if it has notification access. This service exists for that
 * permission alone and does nothing with notifications. Grant it once:
 *
 *   adb shell cmd notification allow_listener \
 *     com.raadfxrd.tvlauncher/com.raadfxrd.tvlauncher.MediaListener
 */
class MediaListener : NotificationListenerService()
