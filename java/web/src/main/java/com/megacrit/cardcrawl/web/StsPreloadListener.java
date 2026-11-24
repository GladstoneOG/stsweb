package com.megacrit.cardcrawl.web;

import com.badlogic.gdx.ApplicationAdapter;
import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.graphics.GL20;
import com.github.xpenatan.gdx.teavm.backends.web.WebApplication;
import org.teavm.jso.JSBody;

/**
 * Waits for FreeType WASM + STSPK01 boot pack download, mounts all unpacked
 * files into LibGDX InternalStorage in smooth frame batches, and starts STS.
 */
public class StsPreloadListener extends ApplicationAdapter {
    private boolean launched = false;
    private int mountedCount = 0;

    @Override
    public void create() {
        TeaWebBridge.installJsHooks();
    }

    @Override
    public void render() {
        Gdx.gl.glClearColor(0.043f, 0.055f, 0.078f, 1.0f);
        Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT);

        if (launched) return;

        int batch = TeaWebBridge.mountQueueBatch(false, 250);
        if (batch > 0) {
            mountedCount += batch;
            reportMountProgress(mountedCount);
        }

        if (isFreeTypeReady() && isBootPackMounted()) {
            launched = true;
            notifyEngineReady();
            WebApplication.get().setPreloadReady();
        }
    }

    @JSBody(script =
        "return typeof Module !== 'undefined' && typeof Module._c_FreeType_initFreeTypeJni === 'function' && typeof window.Gdx !== 'undefined';")
    private static native boolean isFreeTypeReady();

    @JSBody(script =
        "return !!(window.__STS_BOOT_IS_DONE && window.__STS_BOOT_IS_DONE());")
    private static native boolean isBootPackMounted();

    @JSBody(params = { "mounted" }, script =
        "if (window.__STS_ON_MOUNT_PROGRESS) window.__STS_ON_MOUNT_PROGRESS(mounted);")
    private static native void reportMountProgress(int mounted);

    @JSBody(script =
        "if (window.__STS_ON_ENGINE_READY) window.__STS_ON_ENGINE_READY();")
    private static native void notifyEngineReady();
}
