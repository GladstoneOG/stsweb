package com.megacrit.cardcrawl.web;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.audio.Music;
import com.badlogic.gdx.files.FileHandle;
import com.github.xpenatan.gdx.teavm.backends.web.dom.typedarray.TypedArrays;
import com.google.gson.Gson;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;
import org.teavm.jso.core.JSArrayReader;
import org.teavm.jso.core.JSString;
import org.teavm.jso.typedarrays.Int8Array;

public class TeaWebBridge implements StsPlatform.Bridge {
    private static boolean hooksInstalled = false;

    public static void installJsHooks() {
        if (hooksInstalled) return;
        hooksInstalled = true;
        registerSaveHooks(
            () -> listLocalFilesJson(),
            path -> readLocalFileText(path),
            (path, content) -> writeLocalFileText(path, content),
            path -> deleteLocalFile(path),
            () -> reloadAllFromLocalStorage(),
            (slot, amount) -> sendTradeGold(slot, amount),
            () -> getJavaPlayerName(),
            name -> setJavaPlayerName(name)
        );
    }

    private static String getJavaPlayerName() {
        String n = com.megacrit.cardcrawl.core.CardCrawlGame.playerName;
        return n != null ? n : "";
    }

    private static void setJavaPlayerName(String rawName) {
        if (rawName == null) return;
        final String clean = rawName.trim().length() > 16 ? rawName.trim().substring(0, 16) : rawName.trim();
        if (clean.isEmpty()) return;
        Gdx.app.postRunnable(() -> {
            try {
                com.megacrit.cardcrawl.core.CardCrawlGame.playerName = clean;
                int slot = com.megacrit.cardcrawl.core.CardCrawlGame.saveSlot;
                if (slot < 0 || slot > 2) {
                    slot = 0;
                    com.megacrit.cardcrawl.core.CardCrawlGame.saveSlot = 0;
                }
                if (com.megacrit.cardcrawl.core.CardCrawlGame.saveSlotPref != null) {
                    com.megacrit.cardcrawl.core.CardCrawlGame.saveSlotPref.putInteger("DEFAULT_SLOT", slot);
                    com.megacrit.cardcrawl.core.CardCrawlGame.saveSlotPref.putString(
                        com.megacrit.cardcrawl.helpers.SaveHelper.slotName("PROFILE_NAME", slot),
                        clean
                    );
                    com.megacrit.cardcrawl.core.CardCrawlGame.saveSlotPref.flush();
                }
                if (com.megacrit.cardcrawl.core.CardCrawlGame.playerPref != null) {
                    if (com.megacrit.cardcrawl.core.CardCrawlGame.playerPref.getString("alias", "").isEmpty()) {
                        String alias = com.megacrit.cardcrawl.core.CardCrawlGame.generateRandomAlias();
                        com.megacrit.cardcrawl.core.CardCrawlGame.playerPref.putString("alias", alias);
                        com.megacrit.cardcrawl.core.CardCrawlGame.alias = alias;
                    }
                    com.megacrit.cardcrawl.core.CardCrawlGame.playerPref.putString("name", clean);
                    com.megacrit.cardcrawl.core.CardCrawlGame.playerPref.flush();
                }
                if (com.megacrit.cardcrawl.dungeons.AbstractDungeon.player != null) {
                    com.megacrit.cardcrawl.dungeons.AbstractDungeon.player.name = clean;
                }
                com.megacrit.cardcrawl.screens.mainMenu.MainMenuScreen mm = com.megacrit.cardcrawl.core.CardCrawlGame.mainMenuScreen;
                if (mm != null && mm.saveSlotScreen != null) {
                    if (mm.saveSlotScreen.slots != null && slot < mm.saveSlotScreen.slots.size()) {
                        com.megacrit.cardcrawl.screens.mainMenu.SaveSlot s = mm.saveSlotScreen.slots.get(slot);
                        if (s != null) {
                            s.setName(clean);
                            s.emptySlot = false;
                        }
                    }
                    if (mm.saveSlotScreen.shown) {
                        mm.saveSlotScreen.shown = false;
                        mm.saveSlotScreen.cancelButton.hide();
                        mm.screen = com.megacrit.cardcrawl.screens.mainMenu.MainMenuScreen.CurScreen.MAIN_MENU;
                    }
                }
            } catch (Exception e) {
                System.err.println("[stsweb] setJavaPlayerName failed: " + e.getMessage());
            }
        });
    }

    private static void sendTradeGold(int targetSlot, int amount) {
        Gdx.app.postRunnable(() -> {
            try {
                com.megacrit.cardcrawl.coop.CoopManager.sendGoldTradeFromUi(targetSlot, amount);
            } catch (Exception e) {
                System.err.println("[stsweb] sendTradeGold failed: " + e.getMessage());
            }
        });
    }

    public static int mountQueueBatch(boolean isStreamPack, int maxEntries) {
        int count = isStreamPack ? takeStreamBatch(maxEntries) : takeBootBatch(maxEntries);
        for (int i = 0; i < count; i++) {
            String path = getBatchPath(i);
            Int8Array arr = getBatchBytes(i);
            if (path == null || path.isEmpty() || arr == null) continue;
            byte[] bytes = TypedArrays.toByteArray(arr);
            String clean = path.replace('\\', '/');
            if (clean.startsWith("/")) clean = clean.substring(1);
            try {
                FileHandle fh = Gdx.files.internal(clean);
                try (OutputStream out = fh.write(false, Math.max(4096, bytes.length))) {
                    out.write(bytes);
                }
            } catch (Exception e) {
                System.err.println("[stsweb] Failed mounting asset: " + clean + " -> " + e.getMessage());
            }
        }
        clearBatch();
        return count;
    }

    private static void collectLocalFiles(FileHandle dir, List<String> out) {
        if (dir == null || !dir.exists()) return;
        if (!dir.isDirectory()) {
            out.add(dir.path().replace('\\', '/'));
            return;
        }
        FileHandle[] children = dir.list();
        if (children == null) return;
        for (FileHandle child : children) {
            if (child.isDirectory()) {
                collectLocalFiles(child, out);
            } else {
                out.add(child.path().replace('\\', '/'));
            }
        }
    }

    private static String listLocalFilesJson() {
        List<String> files = new ArrayList<>();
        String[] roots = new String[] { "preferences", "saves", "betaPreferences", "runs", "info.displayconfig" };
        for (String root : roots) {
            try {
                FileHandle fh = Gdx.files.local(root);
                if (fh.exists()) {
                    collectLocalFiles(fh, files);
                }
            } catch (Exception ignored) {
            }
        }
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < files.size(); i++) {
            if (i > 0) sb.append(',');
            Gson.writeQuotedString(sb, files.get(i));
        }
        sb.append(']');
        return sb.toString();
    }

    private static String readLocalFileText(String path) {
        if (path == null || path.isEmpty()) return "";
        try {
            FileHandle fh = Gdx.files.local(path.replace('\\', '/'));
            if (!fh.exists() || fh.isDirectory()) return "";
            byte[] bytes = fh.readBytes();
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean writeLocalFileText(String path, String content) {
        if (path == null || path.isEmpty()) return false;
        try {
            String clean = path.replace('\\', '/');
            FileHandle fh = Gdx.files.local(clean);
            byte[] bytes = (content != null ? content : "").getBytes(StandardCharsets.UTF_8);
            fh.writeBytes(bytes, false);
            return true;
        } catch (Exception e) {
            System.err.println("[stsweb] writeLocalFileText error: " + e.getMessage());
            return false;
        }
    }

    private static boolean deleteLocalFile(String path) {
        if (path == null || path.isEmpty()) return false;
        try {
            FileHandle fh = Gdx.files.local(path.replace('\\', '/'));
            return fh.exists() && fh.delete();
        } catch (Exception e) {
            return false;
        }
    }

    private static void reloadAllFromLocalStorage() {
        Gdx.app.postRunnable(() -> {
            try {
                com.megacrit.cardcrawl.core.CardCrawlGame.reloadPrefs();
            } catch (Exception e) {
                System.err.println("[stsweb] reloadPrefs failed: " + e.getClass().getName() + ": " + e.getMessage());
            }
        });
    }

    @Override
    public void log(String level, String msg) {
        System.out.println("[" + level + "] " + msg);
    }

    @Override
    public long getEpochSeconds() {
        return getJsEpochSeconds();
    }

    @Override
    public void onLocalFileSaved(String path, String content) {
        notifySaveBridge(path, content);
    }

    @Override
    public void onLocalFileDeleted(String path) {
        notifyDeleteBridge(path);
    }

    @Override
    public Music newMusic(String path) {
        return new WebStreamingMusic(path);
    }

    @Override
    public void openLobbyOverlay() {
        jsOpenLobbyOverlay();
    }

    @Override
    public void sendNetMessage(String json) {
        jsSendNetMessage(json);
    }

    @Override
    public String[] pollNetMessages() {
        JSArrayReader<JSString> arr = jsPollNetMessages();
        if (arr == null || arr.getLength() == 0) return new String[0];
        String[] out = new String[arr.getLength()];
        for (int i = 0; i < out.length; i++) {
            out[i] = arr.get(i).stringValue();
        }
        return out;
    }

    @Override
    public void sendWebRtcPreview(String json) {
        jsSendWebRtcPreview(json);
    }

    @Override
    public String[] pollWebRtcPreviews() {
        JSArrayReader<JSString> arr = jsPollWebRtcPreviews();
        if (arr == null || arr.getLength() == 0) return new String[0];
        String[] out = new String[arr.getLength()];
        for (int i = 0; i < out.length; i++) {
            out[i] = arr.get(i).stringValue();
        }
        return out;
    }

    @Override
    public void pumpBackgroundAssets() {
        if (hasStreamEntries()) {
            mountQueueBatch(true, 32);
        }
    }

    @Override
    public void openExternalUrl(String url) {
        jsOpenExternalUrl(url);
    }

    @Override
    public void onPlayerNameChanged(String name) {
        notifyPlayerNameBridge(name != null ? name : "");
    }

    // -------------------------------------------------------------------------
    // JS Interop Bindings
    // -------------------------------------------------------------------------

    @JSFunctor
    private interface FnString extends JSObject {
        String call();
    }

    @JSFunctor
    private interface FnRead extends JSObject {
        String call(String path);
    }

    @JSFunctor
    private interface FnWrite extends JSObject {
        boolean call(String path, String content);
    }

    @JSFunctor
    private interface FnDelete extends JSObject {
        boolean call(String path);
    }

    @JSFunctor
    private interface FnVoid extends JSObject {
        void call();
    }

    @JSFunctor
    private interface FnSetName extends JSObject {
        void call(String name);
    }

    @JSFunctor
    private interface FnTradeGold extends JSObject {
        void call(int targetSlot, int amount);
    }

    @JSBody(params = { "listFn", "readFn", "writeFn", "delFn", "reloadFn", "tradeFn", "getNameFn", "setNameFn" }, script =
        "window.__STS_JAVA_SAVE_HOOKS = {" +
        "  listFiles: function() { return JSON.parse(listFn()); }," +
        "  readFile: function(p) { return readFn(p); }," +
        "  writeFile: function(p, c) { return writeFn(p, c); }," +
        "  deleteFile: function(p) { return delFn(p); }," +
        "  reloadPrefs: function() { reloadFn(); }," +
        "  getPlayerName: function() { return getNameFn(); }," +
        "  setPlayerName: function(n) { setNameFn(n); }" +
        "};" +
        "window.__STS_JAVA_COOP_HOOKS = {" +
        "  sendTradeGold: function(slot, amt) { tradeFn(slot, amt); }" +
        "};" +
        "if (window.StsSaveBridge && window.StsSaveBridge.onJavaHooksReady) {" +
        "  try { window.StsSaveBridge.onJavaHooksReady(); } catch (e) {}" +
        "}")
    private static native void registerSaveHooks(
        FnString listFn, FnRead readFn, FnWrite writeFn, FnDelete delFn, FnVoid reloadFn,
        FnTradeGold tradeFn, FnString getNameFn, FnSetName setNameFn);

    @JSBody(params = { "maxEntries" }, script =
        "return window.__STS_BOOT_TAKE_BATCH ? window.__STS_BOOT_TAKE_BATCH(maxEntries) : 0;")
    private static native int takeBootBatch(int maxEntries);

    @JSBody(params = { "maxEntries" }, script =
        "return window.__STS_STREAM_TAKE_BATCH ? window.__STS_STREAM_TAKE_BATCH(maxEntries) : 0;")
    private static native int takeStreamBatch(int maxEntries);

    @JSBody(script = "return !!(window.__STS_HAS_STREAM_ENTRIES && window.__STS_HAS_STREAM_ENTRIES());")
    private static native boolean hasStreamEntries();

    @JSBody(params = { "i" }, script = "return window.__STS_BATCH_PATH ? window.__STS_BATCH_PATH(i) : '';")
    private static native String getBatchPath(int i);

    @JSBody(params = { "i" }, script = "return window.__STS_BATCH_BYTES ? window.__STS_BATCH_BYTES(i) : null;")
    private static native Int8Array getBatchBytes(int i);

    @JSBody(script = "if (window.__STS_CLEAR_BATCH) window.__STS_CLEAR_BATCH();")
    private static native void clearBatch();

    @JSBody(script = "return window.__STS_EPOCH_SECONDS ? Number(window.__STS_EPOCH_SECONDS) : Math.floor(Date.now() / 1000);")
    private static native long getJsEpochSeconds();

    @JSBody(params = { "path", "content" }, script =
        "if (window.StsSaveBridge && window.StsSaveBridge.onLocalSaved) window.StsSaveBridge.onLocalSaved(path, content);")
    private static native void notifySaveBridge(String path, String content);

    @JSBody(params = { "path" }, script =
        "if (window.StsSaveBridge && window.StsSaveBridge.onLocalDeleted) window.StsSaveBridge.onLocalDeleted(path);")
    private static native void notifyDeleteBridge(String path);

    @JSBody(script =
        "if (window.StsUI && window.StsUI.openOverlay) window.StsUI.openOverlay('lobby');")
    private static native void jsOpenLobbyOverlay();

    @JSBody(params = { "json" }, script =
        "if (window.StsNetBridge && window.StsNetBridge.send) window.StsNetBridge.send(json);")
    private static native void jsSendNetMessage(String json);

    @JSBody(script =
        "return (window.StsNetBridge && window.StsNetBridge.poll) ? window.StsNetBridge.poll() : [];")
    private static native JSArrayReader<JSString> jsPollNetMessages();

    @JSBody(params = { "json" }, script =
        "if (window.StsNetBridge && window.StsNetBridge.sendPreview) window.StsNetBridge.sendPreview(json);")
    private static native void jsSendWebRtcPreview(String json);

    @JSBody(script =
        "return (window.StsNetBridge && window.StsNetBridge.pollPreviews) ? window.StsNetBridge.pollPreviews() : [];")
    private static native JSArrayReader<JSString> jsPollWebRtcPreviews();

    @JSBody(params = { "url" }, script = "window.open(url, '_blank', 'noopener');")
    private static native void jsOpenExternalUrl(String url);

    @JSBody(params = { "name" }, script =
        "if (window.StsSaveBridge && window.StsSaveBridge.onJavaPlayerNameChanged) window.StsSaveBridge.onJavaPlayerNameChanged(name);")
    private static native void notifyPlayerNameBridge(String name);
}
