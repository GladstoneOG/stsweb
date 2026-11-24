package com.codedisaster.steamworks;

public class SteamUtils {
    public enum FloatingGamepadTextInputMode {
        ModeSingleLine,
        ModeMultipleLines,
        ModeEmail,
        ModeNumeric
    }

    public SteamUtils(SteamUtilsCallback callback) {
    }

    public boolean isSteamRunningOnSteamDeck() {
        return false;
    }

    public void showFloatingGamepadTextInput(FloatingGamepadTextInputMode mode, int x, int y, int w, int h) {
    }

    public void dispose() {
    }
}
