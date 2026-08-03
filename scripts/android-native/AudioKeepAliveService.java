package com.livepatch.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps LivePatch's audio alive when the screen goes off.
 *
 * The screen wake lock in `src/engine/worklet.ts` keeps the screen ON while
 * audio runs, which is the most a web page can do. It is not the same thing:
 * with the screen actually dark, Android puts the app into app-standby, freezes
 * its process, and the WebView's `AudioContext` stops — silently, with no error
 * anywhere. A foreground service is Android's only supported answer, and this
 * is the whole of it.
 *
 * `mediaPlayback` is the honest service type: this app is playing audio the
 * user asked for. Declaring a type that does not match what the app does is
 * what gets an app pulled, and on Android 14+ a mismatched type throws at
 * `startForeground()`.
 *
 * Copied in from scripts/android-native/ on every build — `android/` is
 * generated and disposable. See scripts/android-apk.mjs.
 */
public class AudioKeepAliveService extends android.app.Service {

    private static final String CHANNEL = "livepatch-audio";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public IBinder onBind(Intent intent) {
        return null; // started, not bound
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // LOW, not DEFAULT: this notification exists because Android
            // requires one, not because there is anything to tell the user. At
            // DEFAULT it makes a sound every time audio starts.
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Audio engine", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }

        // Tapping it returns to the app rather than doing nothing, which is the
        // difference between a notification and litter.
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this);
        Notification n = b
            .setContentTitle("LivePatch")
            .setContentText("Audio engine running")
            .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
            .setOngoing(true)
            .setContentIntent(pi)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        // START_STICKY would have Android restart this after a kill, with a null
        // intent and no audio actually running — a permanent notification for a
        // silent app. The engine starts it; the engine ends it.
        return START_NOT_STICKY;
    }
}
