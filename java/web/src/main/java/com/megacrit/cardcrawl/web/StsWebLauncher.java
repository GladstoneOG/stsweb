package com.megacrit.cardcrawl.web;

import com.github.xpenatan.gdx.teavm.backends.web.WebApplication;
import com.github.xpenatan.gdx.teavm.backends.web.WebApplicationConfiguration;
import com.megacrit.cardcrawl.core.CardCrawlGame;

public class StsWebLauncher {
    public static void main(String[] args) {
        StsPlatform.bridge = new TeaWebBridge();

        WebApplicationConfiguration config = new WebApplicationConfiguration("canvas");
        config.width = 0;
        config.height = 0;
        config.useGL30 = true;
        config.usePhysicalPixels = true;
        config.alpha = false;
        config.stencil = false;
        config.antialiasing = false;
        config.storagePrefix = "stsweb_";
        config.localStoragePrefix = "stsweb_local_v1";
        config.showDownloadLogs = false;
        config.preloadListener = assetLoader -> assetLoader.loadScript("freetype.js");

        new WebApplication(new CardCrawlGame("preferences/"), new StsPreloadListener(), config);
    }
}
