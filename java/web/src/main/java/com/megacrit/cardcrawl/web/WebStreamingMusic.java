package com.megacrit.cardcrawl.web;

import com.badlogic.gdx.audio.Music;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSObject;

/**
 * Streams Slay the Spire OGG music tracks lazily via HTML5 Audio elements.
 */
public class WebStreamingMusic implements Music {
    private final JSObject audio;
    private boolean looping = false;
    private float volume = 1.0f;
    private OnCompletionListener completionListener;

    public WebStreamingMusic(String assetPath) {
        String clean = assetPath.replace('\\', '/');
        if (!clean.startsWith("/")) {
            clean = "/" + clean;
        }
        this.audio = createAudio(clean);
    }

    @JSBody(params = { "url" }, script =
        "var a = new Audio(url);" +
        "a.preload = 'auto';" +
        "a.__stsPendingPlay = false;" +
        "a.__stsDisposed = false;" +
        "if (!window.__stsAudioUnlockInstalled) {" +
        "  window.__stsAudioUnlockInstalled = true;" +
        "  window.__stsPendingAudio = [];" +
        "  var unlock = function() {" +
        "    var list = window.__stsPendingAudio.splice(0);" +
        "    for (var i = 0; i < list.length; i++) {" +
        "      var item = list[i];" +
        "      if (item && !item.__stsDisposed && item.__stsPendingPlay) {" +
        "        try { item.play().catch(function(){}); } catch (e) {}" +
        "      }" +
        "    }" +
        "  };" +
        "  window.addEventListener('pointerdown', unlock, { passive: true });" +
        "  window.addEventListener('keydown', unlock, { passive: true });" +
        "}" +
        "return a;")
    private static native JSObject createAudio(String url);

    @JSBody(params = { "a" }, script =
        "if (!a || a.__stsDisposed) return;" +
        "a.__stsPendingPlay = true;" +
        "try {" +
        "  var p = a.play();" +
        "  if (p && p.catch) {" +
        "    p.catch(function() {" +
        "      if (!a.__stsDisposed && window.__stsPendingAudio && window.__stsPendingAudio.indexOf(a) === -1) {" +
        "        window.__stsPendingAudio.push(a);" +
        "      }" +
        "    });" +
        "  }" +
        "} catch (e) {}")
    private static native void playAudio(JSObject a);

    @JSBody(params = { "a" }, script =
        "if (!a) return; a.__stsPendingPlay = false; try { a.pause(); } catch (e) {}")
    private static native void pauseAudio(JSObject a);

    @JSBody(params = { "a" }, script =
        "if (!a) return; a.__stsPendingPlay = false; try { a.pause(); a.currentTime = 0; } catch (e) {}")
    private static native void stopAudio(JSObject a);

    @JSBody(params = { "a" }, script = "return !!(a && !a.paused && !a.ended);")
    private static native boolean isAudioPlaying(JSObject a);

    @JSBody(params = { "a", "loop" }, script = "if (a) a.loop = !!loop;")
    private static native void setAudioLoop(JSObject a, boolean loop);

    @JSBody(params = { "a", "vol" }, script = "if (a) a.volume = Math.max(0, Math.min(1, vol));")
    private static native void setAudioVolume(JSObject a, float vol);

    @JSBody(params = { "a" }, script = "return a ? a.currentTime : 0;")
    private static native float getAudioPos(JSObject a);

    @JSBody(params = { "a", "pos" }, script = "if (a) try { a.currentTime = pos; } catch (e) {}")
    private static native void setAudioPos(JSObject a, float pos);

    @JSBody(params = { "a" }, script =
        "if (!a) return; a.__stsDisposed = true; a.__stsPendingPlay = false; try { a.pause(); a.src = ''; } catch (e) {}")
    private static native void disposeAudio(JSObject a);

    @JSBody(params = { "a", "cb" }, script =
        "if (!a) return;" +
        "a.onended = function() { if (cb) cb(); };")
    private static native void bindOnEnded(JSObject a, JsRunnable cb);

    @org.teavm.jso.JSFunctor
    private interface JsRunnable extends org.teavm.jso.JSObject {
        void run();
    }

    @Override
    public void play() {
        playAudio(audio);
    }

    @Override
    public void pause() {
        pauseAudio(audio);
    }

    @Override
    public void stop() {
        stopAudio(audio);
    }

    @Override
    public boolean isPlaying() {
        return isAudioPlaying(audio);
    }

    @Override
    public void setLooping(boolean isLooping) {
        this.looping = isLooping;
        setAudioLoop(audio, isLooping);
    }

    @Override
    public boolean isLooping() {
        return looping;
    }

    @Override
    public void setVolume(float volume) {
        this.volume = volume;
        setAudioVolume(audio, volume);
    }

    @Override
    public float getVolume() {
        return volume;
    }

    @Override
    public void setPan(float pan, float volume) {
        setVolume(volume);
    }

    @Override
    public void setPosition(float position) {
        setAudioPos(audio, position);
    }

    @Override
    public float getPosition() {
        return getAudioPos(audio);
    }

    @Override
    public void dispose() {
        disposeAudio(audio);
    }

    @Override
    public void setOnCompletionListener(OnCompletionListener listener) {
        this.completionListener = listener;
        bindOnEnded(audio, () -> {
            if (this.completionListener != null) {
                this.completionListener.onCompletion(WebStreamingMusic.this);
            }
        });
    }
}
