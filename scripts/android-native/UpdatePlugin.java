package com.livepatch.player;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hand a release APK's URL to the system browser.
 *
 * This is the Android tail of the shared update flow (src/ui/updates.ts):
 * everything up to here — checking GitHub, comparing versions, showing the
 * release notes — is web-side and identical on both platforms. Only the last
 * step differs, and this is all of it.
 *
 * WHY NOT DOWNLOAD AND INSTALL IT OURSELVES
 *
 * It did, once. Installing an APK from inside the app needs
 * `REQUEST_INSTALL_PACKAGES`, and Play Protect blocked the resulting build with
 * a "harmful app" warning — a sideloaded app from an unrecognised developer
 * asking for the power to install other apps is close to the textbook malware
 * profile, and a release signing key does not change that (Play Protect weighs
 * developer reputation, not whether a signature exists).
 *
 * The permission bought exactly one tap and cost a malware warning on every
 * install. So the browser does the download and the install instead: it already
 * holds that trust, and LivePatch asks for no install powers at all. The user
 * taps the download notification when it lands.
 *
 * Copied in from scripts/android-native/ on every build — `android/` is
 * generated and disposable. See scripts/android-apk.mjs.
 */
@CapacitorPlugin(name = "LivePatchUpdate")
public class UpdatePlugin extends Plugin {

    /**
     * Start/stop the foreground service that keeps audio alive with the screen
     * off. Called from `worklet.ts` beside the wake lock, so the service exists
     * for exactly as long as the engine is producing sound — a persistent
     * notification for an app making no noise is the thing users uninstall over.
     */
    /**
     * Can we attach a platform audio effect to the GLOBAL output mix?
     *
     * This is the question behind "can LivePatch be a system EQ like Poweramp
     * Equalizer or Wavelet". Those apps do not capture audio and do not ask for
     * a runtime permission: they attach a platform AudioEffect to session 0,
     * which needs only MODIFY_AUDIO_SETTINGS (install-time, no dialog).
     *
     * The hard limit, which no amount of effort moves: an AudioEffect lets you
     * CONFIGURE a platform-provided effect. It never hands over the PCM. So
     * this path could carry an EQ curve and could never run LivePatch own
     * kernels — no convolution, no spatial engine — on another app audio.
     *
     * Whether session 0 works at all is device- and ROM-dependent and has been
     * progressively restricted, so it is measured here rather than assumed.
     * Purely diagnostic: everything is released immediately and nothing is
     * left attached.
     */
    @PluginMethod
    public void probeAudioEffects(PluginCall call) {
        com.getcapacitor.JSObject res = new com.getcapacitor.JSObject();
        res.put("sdk", android.os.Build.VERSION.SDK_INT);
        res.put("device", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);

        // Session 0 is the global output mix. Priority 0 = no special claim.
        res.put("equalizer", tryEffect("equalizer"));
        res.put("dynamicsProcessing", tryEffect("dynamics"));
        res.put("loudnessEnhancer", tryEffect("loudness"));

        // What the ROM says it has at all, regardless of session.
        StringBuilder names = new StringBuilder();
        try {
            android.media.audiofx.AudioEffect.Descriptor[] all =
                android.media.audiofx.AudioEffect.queryEffects();
            if (all != null) {
                for (android.media.audiofx.AudioEffect.Descriptor d : all) {
                    if (names.length() > 0) names.append(", ");
                    names.append(d.name);
                }
            }
        } catch (Throwable t) {
            names.append("queryEffects failed: ").append(t.getClass().getSimpleName());
        }
        res.put("available", names.toString());
        call.resolve(res);
    }

    /** Construct one effect on session 0, report, and release it again. */
    private String tryEffect(String which) {
        android.media.audiofx.AudioEffect fx = null;
        try {
            if ("equalizer".equals(which)) {
                android.media.audiofx.Equalizer eq = new android.media.audiofx.Equalizer(0, 0);
                fx = eq;
                eq.setEnabled(true);
                boolean on = eq.getEnabled();
                short bands = eq.getNumberOfBands();
                return "ok: " + bands + " bands, enabled=" + on;
            }
            if ("dynamics".equals(which)) {
                if (android.os.Build.VERSION.SDK_INT < 28) return "unavailable: needs API 28";
                android.media.audiofx.DynamicsProcessing dp =
                    new android.media.audiofx.DynamicsProcessing(0, 0, null);
                fx = dp;
                dp.setEnabled(true);
                return "ok: enabled=" + dp.getEnabled();
            }
            android.media.audiofx.LoudnessEnhancer le = new android.media.audiofx.LoudnessEnhancer(0);
            fx = le;
            le.setEnabled(true);
            return "ok: enabled=" + le.getEnabled();
        } catch (Throwable t) {
            // UnsupportedOperationException / IllegalStateException / SecurityException
            // are all normal answers here — they mean this ROM refuses it.
            String m = t.getMessage();
            return "no: " + t.getClass().getSimpleName() + (m != null ? " (" + m + ")" : "");
        } finally {
            // Diagnostic only — never leave an effect attached to the global mix.
            if (fx != null) { try { fx.setEnabled(false); } catch (Throwable ignored) {} try { fx.release(); } catch (Throwable ignored) {} }
        }
    }

    @PluginMethod
    public void setAudioActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        Intent svc = new Intent(getContext(), AudioKeepAliveService.class);
        try {
            if (active) {
                // startForegroundService, not startService: from Android 8 the
                // latter throws for a background caller, and the engine can
                // start from a page that is not on screen.
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    getContext().startForegroundService(svc);
                } else {
                    getContext().startService(svc);
                }
            } else {
                getContext().stopService(svc);
            }
            call.resolve();
        } catch (Exception e) {
            // Never fatal. Audio works without the service; it just stops when
            // the screen goes off, and that is not worth failing engineStart over.
            call.reject("keep-alive service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openDownload(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("no url");
            return;
        }
        // https only. This fires a system intent with whatever it is handed, so
        // an unchecked scheme would let anything that could reach this method
        // launch arbitrary intents — and the caller is a WebView.
        Uri uri;
        try {
            uri = Uri.parse(url);
        } catch (Exception e) {
            call.reject("unparseable url");
            return;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            call.reject("refusing a non-https url");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open the browser: " + e.getMessage());
        }
    }
}
