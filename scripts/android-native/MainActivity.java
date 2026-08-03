package com.livepatch.player;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Copied in from scripts/android-native/ on every build — `android/` is
 * generated and disposable, so none of this can live only there.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be before super.onCreate: the bridge is built there, and a
        // plugin registered afterwards is not in it.
        registerPlugin(UpdatePlugin.class);
        registerPlugin(SystemAudioPlugin.class);
        super.onCreate(savedInstanceState);

        // ---- fill the screen ------------------------------------------------
        //
        // Done here, at runtime, and not in styles.xml. `windowFullscreen` and
        // friends are theme attributes that Capacitor's own system-bars handling
        // can undo after the theme is applied; this runs after the bridge is up,
        // so it is the last word.
        //
        // Two separate things, and only doing one of them leaves a border:
        //
        //   setDecorFitsSystemWindows(false) — stop the system reserving space
        //     for the bars by insetting the content view. Without this the
        //     WebView is laid out smaller than the window and the window
        //     background shows through around it.
        //   hide(systemBars())               — actually take the status and
        //     navigation bars off screen. Without this they are still drawn,
        //     over the top now, and the clock/battery row is still lost.
        //
        // This is a control surface held in front of you: every row of pixels
        // the system keeps is a row of faders it costs.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.hide(WindowInsetsCompat.Type.systemBars());
        // Swipe from an edge brings them back briefly and they auto-hide again.
        // The sticky variant matters for a touch instrument: the non-transient
        // behaviour makes the first swipe near an edge restore the bars
        // permanently, which is easy to do by accident while playing.
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
