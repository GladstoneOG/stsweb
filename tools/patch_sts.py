#!/usr/bin/env python3
"""
Slay the Spire Web (stsweb) — Deterministic Core Source Patcher
================================================================
Applies browser-port patches cleanly on top of pristine Vineflower outputs
(backing up unmodified originals to `tools/.cache/orig_java/` on first run
so re-running `patch_sts.py` is 100% idempotent).
"""

from __future__ import annotations

import os
import re
import shutil
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
CORE_JAVA = os.path.join(PROJECT_DIR, "java", "core", "src", "main", "java")
ORIG_BACKUP = os.path.join(SCRIPT_DIR, ".cache", "orig_java")


def read_pristine(rel_path: str) -> str:
    live = os.path.join(CORE_JAVA, rel_path)
    bak = os.path.join(ORIG_BACKUP, rel_path)
    if not os.path.isfile(bak):
        if not os.path.isfile(live):
            raise FileNotFoundError(f"Missing decompiled file: {live}")
        os.makedirs(os.path.dirname(bak), exist_ok=True)
        shutil.copy2(live, bak)
    with open(bak, "r", encoding="utf-8") as f:
        return f.read()


def write_patched(rel_path: str, content: str) -> None:
    live = os.path.join(CORE_JAVA, rel_path)
    os.makedirs(os.path.dirname(live), exist_ok=True)
    with open(live, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def replace_once(src: str, target: str, repl: str, label: str) -> str:
    if target not in src:
        raise RuntimeError(f"[patch] Target not found for {label}: {target[:120]!r}")
    return src.replace(target, repl, 1)


def patch_display_config() -> None:
    rel = "com/megacrit/cardcrawl/core/DisplayConfig.java"
    read_pristine(rel)
    code = """package com.megacrit.cardcrawl.core;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.files.FileHandle;
import java.util.ArrayList;
import java.util.HashMap;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

public class DisplayConfig {
   private static final Logger logger = LogManager.getLogger(DisplayConfig.class.getName());
   private static final String DISPLAY_CONFIG_LOC = "info.displayconfig";
   private int width;
   private int height;
   private int fps_limit;
   private boolean isFullscreen;
   private boolean wfs;
   private boolean vsync;

   private DisplayConfig(int width, int height, int fps_limit, boolean isFullscreen, boolean wfs, boolean vsync) {
      this.width = width;
      this.height = height;
      this.fps_limit = fps_limit;
      this.isFullscreen = isFullscreen;
      this.wfs = wfs;
      this.vsync = vsync;
   }

   @Override
   public String toString() {
      HashMap<String, Object> hm = new HashMap<>();
      hm.put("width", this.width);
      hm.put("height", this.height);
      hm.put("fps_limit", this.fps_limit);
      hm.put("isFullscreen", this.isFullscreen);
      hm.put("wfs", this.wfs);
      hm.put("vsync", this.vsync);
      return hm.toString();
   }

   public static DisplayConfig readConfig() {
      ArrayList<String> configLines = readDisplayConfFile();
      if (configLines.size() < 6) {
         return new DisplayConfig(1920, 1080, 60, false, true, true);
      }
      try {
         return new DisplayConfig(
            Integer.parseInt(configLines.get(0).trim()),
            Integer.parseInt(configLines.get(1).trim()),
            Integer.parseInt(configLines.get(2).trim()),
            Boolean.parseBoolean(configLines.get(3).trim()),
            Boolean.parseBoolean(configLines.get(4).trim()),
            Boolean.parseBoolean(configLines.get(5).trim())
         );
      } catch (Exception e) {
         return new DisplayConfig(1920, 1080, 60, false, true, true);
      }
   }

   private static ArrayList<String> readDisplayConfFile() {
      ArrayList<String> lines = new ArrayList<>();
      try {
         FileHandle fh = Gdx.files.local(DISPLAY_CONFIG_LOC);
         if (!fh.exists()) {
            createNewConfig();
         }
         String txt = fh.readString("UTF-8");
         for (String line : txt.split("\\r?\\n")) {
            if (!line.trim().isEmpty()) {
               lines.add(line);
            }
         }
      } catch (Exception e) {
         logger.info("Using default web DisplayConfig");
      }
      return lines;
   }

   public static void writeDisplayConfigFile(int w, int h, int fps, boolean fs, boolean wfs, boolean vs) {
      try {
         StringBuilder sb = new StringBuilder();
         sb.append(w).append('\\n');
         sb.append(h).append('\\n');
         sb.append(fps).append('\\n');
         sb.append(fs).append('\\n');
         sb.append(wfs).append('\\n');
         sb.append(vs).append('\\n');
         Gdx.files.local(DISPLAY_CONFIG_LOC).writeString(sb.toString(), false, "UTF-8");
      } catch (Exception e) {
         logger.warn("Failed writing DisplayConfig", e);
      }
   }

   private static void createNewConfig() {
      writeDisplayConfigFile(1920, 1080, 60, false, true, true);
   }

   public int getWidth() { return this.width; }
   public int getHeight() { return this.height; }
   public int getMaxFPS() { return this.fps_limit; }
   public boolean getIsFullscreen() { return this.isFullscreen; }
   public boolean getWFS() { return this.wfs; }
   public boolean getIsVsync() { return this.vsync; }
}
"""
    write_patched(rel, code)


def patch_settings() -> None:
    rel = "com/megacrit/cardcrawl/core/Settings.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      DisplayConfig displayConf = DisplayConfig.readConfig();\n"
        "      M_W = Gdx.graphics.getWidth();\n"
        "      M_H = Gdx.graphics.getHeight();\n"
        "      WIDTH = displayConf.getWidth();\n"
        "      HEIGHT = displayConf.getHeight();\n"
        "      MAX_FPS = displayConf.getMaxFPS();\n"
        "      SAVED_WIDTH = WIDTH;\n"
        "      SAVED_HEIGHT = HEIGHT;\n"
        "      IS_FULLSCREEN = displayConf.getIsFullscreen();\n"
        "      IS_W_FULLSCREEN = displayConf.getWFS();\n"
        "      IS_V_SYNC = displayConf.getIsVsync();",
        "      DisplayConfig displayConf = DisplayConfig.readConfig();\n"
        "      if (com.megacrit.cardcrawl.web.StsPlatform.isWeb()) {\n"
        "         M_W = 1920;\n"
        "         M_H = 1080;\n"
        "         WIDTH = 1920;\n"
        "         HEIGHT = 1080;\n"
        "         MAX_FPS = 60;\n"
        "         SAVED_WIDTH = 1920;\n"
        "         SAVED_HEIGHT = 1080;\n"
        "         IS_FULLSCREEN = false;\n"
        "         IS_W_FULLSCREEN = true;\n"
        "         IS_V_SYNC = true;\n"
        "      } else {\n"
        "         M_W = Gdx.graphics.getWidth();\n"
        "         M_H = Gdx.graphics.getHeight();\n"
        "         WIDTH = displayConf.getWidth();\n"
        "         HEIGHT = displayConf.getHeight();\n"
        "         MAX_FPS = displayConf.getMaxFPS();\n"
        "         SAVED_WIDTH = WIDTH;\n"
        "         SAVED_HEIGHT = HEIGHT;\n"
        "         IS_FULLSCREEN = displayConf.getIsFullscreen();\n"
        "         IS_W_FULLSCREEN = displayConf.getWFS();\n"
        "         IS_V_SYNC = displayConf.getIsVsync();\n"
        "      }",
        rel,
    )
    write_patched(rel, src)


def patch_card_crawl_game() -> None:
    rel = "com/megacrit/cardcrawl/core/CardCrawlGame.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   @Override\n   public void create() {\n",
        "   @Override\n   public void create() {\n"
        "      com.badlogic.gdx.graphics.glutils.ShaderProgram.prependFragmentCode = \"#ifdef GL_ES\\nprecision mediump float;\\n#endif\\n\";\n",
        f"{rel}:prependFragmentCode",
    )
    src = replace_once(
        src,
        "      try {\n         TwitchConfig.createConfig();",
        "      try {\n         if (com.megacrit.cardcrawl.web.StsPlatform.isWeb()) { this.camera = null; }\n         TwitchConfig.createConfig();",
        f"{rel}:createStart",
    )
    src = replace_once(
        src,
        '         Gdx.graphics.setCursor(Gdx.graphics.newCursor(new Pixmap(Gdx.files.internal("images/blank.png")), 0, 0));',
        '         try { Gdx.graphics.setCursor(Gdx.graphics.newCursor(new Pixmap(Gdx.files.internal("images/blank.png")), 0, 0)); } catch (Throwable ignored) {}',
        f"{rel}:setCursor",
    )
    src = replace_once(
        src,
        "         splashScreen = new SplashScreen();\n"
        "         mode = CardCrawlGame.GameMode.SPLASH;\n"
        "      } catch (Exception e) {\n"
        '         logger.info("Exception occurred in CardCrawlGame create method!");\n'
        "         ExceptionHandler.handleException(e, logger);\n"
        "         Gdx.app.exit();\n"
        "      }",
        "         splashScreen = new SplashScreen();\n"
        "         mode = CardCrawlGame.GameMode.SPLASH;\n"
        "         this.resize(Gdx.graphics.getWidth(), Gdx.graphics.getHeight());\n"
        "         if (playerName != null && !playerName.isEmpty()) {\n"
        "            com.megacrit.cardcrawl.web.StsPlatform.bridge.onPlayerNameChanged(playerName);\n"
        "         }\n"
        "         System.out.println(\"[stsweb] CardCrawlGame.create() finished cleanly!\");\n"
        "      } catch (Exception e) {\n"
        '         logger.info("Exception occurred in CardCrawlGame create method!");\n'
        "         ExceptionHandler.handleException(e, logger);\n"
        "         e.printStackTrace();\n"
        "      }",
        f"{rel}:createEnd",
    )
    src = replace_once(
        src,
        "   public static void reloadPrefs() {\n"
        "      playerPref = SaveHelper.getPrefs(\"STSPlayer\");",
        "   public static void reloadPrefs() {\n"
        "      saveSlotPref = SaveHelper.getPrefs(\"STSSaveSlots\");\n"
        "      saveSlot = saveSlotPref.getInteger(\"DEFAULT_SLOT\", 0);\n"
        "      playerPref = SaveHelper.getPrefs(\"STSPlayer\");\n"
        "      String slotProf = saveSlot >= 0 ? saveSlotPref.getString(SaveHelper.slotName(\"PROFILE_NAME\", saveSlot), \"\") : \"\";\n"
        "      if (slotProf.isEmpty()) slotProf = playerPref.getString(\"name\", \"\");\n"
        "      if (!slotProf.isEmpty()) {\n"
        "         playerName = slotProf;\n"
        "         com.megacrit.cardcrawl.web.StsPlatform.bridge.onPlayerNameChanged(playerName);\n"
        "      }",
        f"{rel}:reloadSlotName",
    )
    src = replace_once(
        src,
        "      music.fadeOutBGM();\n"
        "      mainMenuScreen.fadeOutMusic();",
        "      if (music != null) {\n"
        "         music.fadeOutBGM();\n"
        "      }\n"
        "      if (mainMenuScreen != null) {\n"
        "         mainMenuScreen.fadeOutMusic();\n"
        "      }",
        f"{rel}:reloadPrefsGuard",
    )
    src = replace_once(
        src,
        "         TimeHelper.update();\n"
        "         if (Gdx.graphics.getRawDeltaTime() > 0.1F) {\n"
        "            return;\n"
        "         }\n\n"
        "         if (!SteamInputHelper.alive) {\n"
        "            CInputHelper.initializeIfAble();\n"
        "         }\n\n"
        "         this.update();\n"
        "         this.sb.setProjectionMatrix(this.camera.combined);\n"
        "         psb.setProjectionMatrix(this.camera.combined);\n"
        "         Gdx.gl.glClear(16384);",
        "         TimeHelper.update();\n"
        "         if (!com.megacrit.cardcrawl.web.StsPlatform.isWeb() && Gdx.graphics.getRawDeltaTime() > 0.1F) {\n"
        "            return;\n"
        "         }\n\n"
        "         if (!SteamInputHelper.alive) {\n"
        "            CInputHelper.initializeIfAble();\n"
        "         }\n\n"
        "         if (!com.megacrit.cardcrawl.web.StsPlatform.isWeb() || Gdx.graphics.getRawDeltaTime() <= 0.1F || viewport == null || this.camera == null) {\n"
        "            this.update();\n"
        "         }\n"
        "         if (viewport != null) {\n"
        "            viewport.apply();\n"
        "         }\n"
        "         this.sb.setProjectionMatrix(this.camera.combined);\n"
        "         psb.setProjectionMatrix(this.camera.combined);\n"
        "         Gdx.gl.glClearColor(0.0F, 0.0F, 0.0F, 1.0F);\n"
        "         Gdx.gl.glClear(16384);",
        f"{rel}:renderViewportAndGuard",
    )
    src = replace_once(
        src,
        '         logger.info("Exception occurred in CardCrawlGame render method!");\n'
        "         ExceptionHandler.handleException(e, logger);\n"
        "         Gdx.app.exit();",
        '         logger.info("Exception occurred in CardCrawlGame render method!");\n'
        "         ExceptionHandler.handleException(e, logger);\n"
        "         e.printStackTrace();",
        f"{rel}:renderCatch",
    )
    src = replace_once(
        src,
        "   public void update() {\n",
        "   public void update() {\n"
        "      com.megacrit.cardcrawl.web.StsPlatform.bridge.pumpBackgroundAssets();\n"
        "      com.megacrit.cardcrawl.coop.CoopManager.update();\n",
        f"{rel}:pumpAssets",
    )
    src = replace_once(
        src,
        "   @Override\n   public void resize(int width, int height) {\n   }",
        "   @Override\n   public void resize(int width, int height) {\n"
        "      if (viewport != null && width > 0 && height > 0) {\n"
        "         viewport.update(width, height, true);\n"
        "      }\n"
        "   }",
        f"{rel}:resize",
    )
    write_patched(rel, src)


def patch_screen_shake() -> None:
    rel = "com/megacrit/cardcrawl/helpers/ScreenShake.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   public void update(FitViewport viewport) {\n"
        "      if (Settings.HORIZ_LETTERBOX_AMT == 0 && Settings.VERT_LETTERBOX_AMT == 0) {\n"
        "         if (this.duration != 0.0F) {\n"
        "            this.duration = this.duration - Gdx.graphics.getDeltaTime();\n"
        "            if (this.duration < 0.0F) {\n"
        "               this.duration = 0.0F;\n"
        "               viewport.update(Settings.M_W, Settings.M_H);\n"
        "               return;\n"
        "            }\n\n"
        "            float tmp = Interpolation.fade.apply(0.1F, this.intensityValue, this.duration / this.startDuration);\n"
        "            this.x = MathUtils.cosDeg((float)(System.currentTimeMillis() % 360L) / this.intervalSpeed) * tmp;\n"
        "            if (Settings.SCREEN_SHAKE) {\n"
        "               if (this.vertical) {\n"
        "                  viewport.update(Settings.M_W, (int)(Settings.M_H + Math.abs(this.x)));\n"
        "               } else {\n"
        "                  viewport.update((int)(Settings.M_W + this.x), Settings.M_H);\n"
        "               }\n"
        "            }\n"
        "         }\n"
        "      }\n"
        "   }",
        "   public void update(FitViewport viewport) {\n"
        "      if (com.megacrit.cardcrawl.web.StsPlatform.isWeb()) {\n"
        "         if (viewport != null && viewport.getCamera() != null && this.duration != 0.0F) {\n"
        "            this.duration = this.duration - Gdx.graphics.getDeltaTime();\n"
        "            if (this.duration < 0.0F) {\n"
        "               this.duration = 0.0F;\n"
        "               this.x = 0.0F;\n"
        "               viewport.getCamera().position.set(Settings.WIDTH * 0.5F, Settings.HEIGHT * 0.5F, 0.0F);\n"
        "               viewport.getCamera().update();\n"
        "               if (Gdx.graphics.getWidth() > 0 && Gdx.graphics.getHeight() > 0) {\n"
        "                  viewport.update(Gdx.graphics.getWidth(), Gdx.graphics.getHeight(), true);\n"
        "               }\n"
        "               return;\n"
        "            }\n\n"
        "            float tmp = Interpolation.fade.apply(0.1F, this.intensityValue, this.duration / this.startDuration);\n"
        "            this.x = MathUtils.cosDeg((float)(System.currentTimeMillis() % 360L) / this.intervalSpeed) * tmp;\n"
        "            if (Settings.SCREEN_SHAKE) {\n"
        "               if (this.vertical) {\n"
        "                  viewport.getCamera().position.set(Settings.WIDTH * 0.5F, Settings.HEIGHT * 0.5F + this.x * 0.35F, 0.0F);\n"
        "               } else {\n"
        "                  viewport.getCamera().position.set(Settings.WIDTH * 0.5F + this.x * 0.35F, Settings.HEIGHT * 0.5F, 0.0F);\n"
        "               }\n"
        "               viewport.getCamera().update();\n"
        "            }\n"
        "         }\n"
        "         return;\n"
        "      }\n"
        "      if (Settings.HORIZ_LETTERBOX_AMT == 0 && Settings.VERT_LETTERBOX_AMT == 0) {\n"
        "         if (this.duration != 0.0F) {\n"
        "            this.duration = this.duration - Gdx.graphics.getDeltaTime();\n"
        "            if (this.duration < 0.0F) {\n"
        "               this.duration = 0.0F;\n"
        "               viewport.update(Settings.M_W, Settings.M_H);\n"
        "               return;\n"
        "            }\n\n"
        "            float tmp = Interpolation.fade.apply(0.1F, this.intensityValue, this.duration / this.startDuration);\n"
        "            this.x = MathUtils.cosDeg((float)(System.currentTimeMillis() % 360L) / this.intervalSpeed) * tmp;\n"
        "            if (Settings.SCREEN_SHAKE) {\n"
        "               if (this.vertical) {\n"
        "                  viewport.update(Settings.M_W, (int)(Settings.M_H + Math.abs(this.x)));\n"
        "               } else {\n"
        "                  viewport.update((int)(Settings.M_W + this.x), Settings.M_H);\n"
        "               }\n"
        "            }\n"
        "         }\n"
        "      }\n"
        "   }",
        rel,
    )
    write_patched(rel, src)


def patch_input_helper() -> None:
    rel = "com/megacrit/cardcrawl/helpers/input/InputHelper.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   public static final int[] SHORTCUT_MODIFIER_KEYS = new int[]{129, 130, 63};",
        "   public static final int[] SHORTCUT_MODIFIER_KEYS = new int[]{129, 130, 63};\n"
        "   private static final com.badlogic.gdx.math.Vector2 webMouseTmp = new com.badlogic.gdx.math.Vector2();",
        f"{rel}:field",
    )
    src = replace_once(
        src,
        "         if (!Settings.isTouchScreen) {\n"
        "            mX = Gdx.input.getX();\n"
        "            if (mX > Settings.WIDTH) {\n"
        "               mX = Settings.WIDTH;\n"
        "            } else if (mX < 0) {\n"
        "               mX = 0;\n"
        "            }\n\n"
        "            mY = Settings.HEIGHT - Gdx.input.getY();\n"
        "            if (mY > Settings.HEIGHT) {\n"
        "               mY = Settings.HEIGHT;\n"
        "            } else if (mY < 1) {\n"
        "               mY = 1;\n"
        "            }\n"
        "         } else {\n"
        "            mX = Gdx.input.getX() + Settings.VERT_LETTERBOX_AMT;\n"
        "            mY = Settings.HEIGHT - Gdx.input.getY() + Settings.HORIZ_LETTERBOX_AMT;\n"
        "            if (mY < 1) {\n"
        "               mY = 1;\n"
        "            }\n"
        "         }",
        "         if (com.megacrit.cardcrawl.web.StsPlatform.isWeb() && CardCrawlGame.viewport != null) {\n"
        "            webMouseTmp.set(Gdx.input.getX(), Gdx.input.getY());\n"
        "            CardCrawlGame.viewport.unproject(webMouseTmp);\n"
        "            mX = Math.max(0, Math.min(Settings.WIDTH, (int) webMouseTmp.x));\n"
        "            mY = Math.max(1, Math.min(Settings.HEIGHT, (int) webMouseTmp.y));\n"
        "         } else if (!Settings.isTouchScreen) {\n"
        "            mX = Gdx.input.getX();\n"
        "            if (mX > Settings.WIDTH) {\n"
        "               mX = Settings.WIDTH;\n"
        "            } else if (mX < 0) {\n"
        "               mX = 0;\n"
        "            }\n\n"
        "            mY = Settings.HEIGHT - Gdx.input.getY();\n"
        "            if (mY > Settings.HEIGHT) {\n"
        "               mY = Settings.HEIGHT;\n"
        "            } else if (mY < 1) {\n"
        "               mY = 1;\n"
        "            }\n"
        "         } else {\n"
        "            mX = Gdx.input.getX() + Settings.VERT_LETTERBOX_AMT;\n"
        "            mY = Settings.HEIGHT - Gdx.input.getY() + Settings.HORIZ_LETTERBOX_AMT;\n"
        "            if (mY < 1) {\n"
        "               mY = 1;\n"
        "            }\n"
        "         }",
        f"{rel}:unproject",
    )
    write_patched(rel, src)


def patch_localized_strings() -> None:
    rel = "com/megacrit/cardcrawl/localization/LocalizedStrings.java"
    src = read_pristine(rel)
    src = src.replace("File.separator", '"/"')
    src = re.sub(
        r"\(new TypeToken<Map<String,\s*([A-Za-z0-9_]+)>>\(\) \{\}\)\.getType\(\)",
        r"TypeToken.mapOf(\1.class)",
        src,
    )
    src = replace_once(
        src,
        "   private static String loadJson(String jsonPath) {\n"
        "      return Gdx.files.internal(jsonPath).readString(String.valueOf(StandardCharsets.UTF_8));\n"
        "   }",
        "   private static String loadJson(String jsonPath) {\n"
        "      String clean = jsonPath.replace('\\\\', '/');\n"
        "      if (!Gdx.files.internal(clean).exists()) {\n"
        "         clean = clean.replaceFirst(\"^localization/[^/]+/\", \"localization/eng/\");\n"
        "      }\n"
        "      return Gdx.files.internal(clean).readString(\"UTF-8\");\n"
        "   }",
        rel,
    )
    src = src.replace("String.valueOf(StandardCharsets.UTF_8)", '"UTF-8"')
    write_patched(rel, src)


def patch_save_and_files() -> None:
    # SaveHelper
    rel = "com/megacrit/cardcrawl/helpers/SaveHelper.java"
    src = read_pristine(rel)
    src = src.replace("java.io.File.separator", '"/"')
    src = src.replace("String.valueOf(StandardCharsets.UTF_8)", '"UTF-8"')
    src = src.replace("(new TypeToken<Map<String, String>>() {}).getType()", "TypeToken.mapOf(String.class)")
    src = replace_once(
        src,
        "   private static void deleteFile(String fileName) {\n"
        "      logger.info(\"Deleting \" + fileName);\n"
        "      if (Gdx.files.local(fileName).delete()) {\n"
        "         logger.info(fileName + \" deleted.\");\n"
        "      }",
        "   private static void deleteFile(String fileName) {\n"
        "      logger.info(\"Deleting \" + fileName);\n"
        "      if (Gdx.files.local(fileName).delete()) {\n"
        "         logger.info(fileName + \" deleted.\");\n"
        "         com.megacrit.cardcrawl.web.StsPlatform.bridge.onLocalFileDeleted(fileName);\n"
        "      }",
        f"{rel}:deleteNotify",
    )
    write_patched(rel, src)

    # SaveAndContinue
    rel = "com/megacrit/cardcrawl/saveAndContinue/SaveAndContinue.java"
    src = read_pristine(rel)
    src = src.replace("File.separator", '"/"')
    src = src.replace("         Gdx.app.exit();\n", "         e.printStackTrace();\n")
    src = replace_once(
        src,
        "      Gdx.files.local(savePath).delete();\n"
        "      Gdx.files.local(savePath + \".backUp\").delete();",
        "      Gdx.files.local(savePath).delete();\n"
        "      com.megacrit.cardcrawl.web.StsPlatform.bridge.onLocalFileDeleted(savePath);\n"
        "      Gdx.files.local(savePath + \".backUp\").delete();\n"
        "      com.megacrit.cardcrawl.web.StsPlatform.bridge.onLocalFileDeleted(savePath + \".backUp\");",
        f"{rel}:deleteSaveNotify",
    )
    write_patched(rel, src)

    # SaveFileObfuscator
    rel = "com/megacrit/cardcrawl/saveAndContinue/SaveFileObfuscator.java"
    read_pristine(rel)
    write_patched(
        rel,
        """package com.megacrit.cardcrawl.saveAndContinue;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

public class SaveFileObfuscator {
   public static final String key = "key";

   public static String encode(String s, String key) {
      return base64Encode(xorWithKey(s.getBytes(StandardCharsets.UTF_8), key.getBytes(StandardCharsets.UTF_8)));
   }

   public static String decode(String s, String key) {
      return new String(xorWithKey(base64Decode(s), key.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8);
   }

   private static byte[] xorWithKey(byte[] a, byte[] key) {
      byte[] out = new byte[a.length];
      for (int i = 0; i < a.length; i++) {
         out[i] = (byte)(a[i] ^ key[i % key.length]);
      }
      return out;
   }

   private static byte[] base64Decode(String s) {
      return Base64.getDecoder().decode(s.replaceAll("\\\\s+", ""));
   }

   private static String base64Encode(byte[] bytes) {
      return Base64.getEncoder().encodeToString(bytes);
   }

   public static boolean isObfuscated(String data) {
      return !data.contains("{");
   }
}
""",
    )

    # AsyncSaver
    rel = "com/megacrit/cardcrawl/helpers/AsyncSaver.java"
    read_pristine(rel)
    write_patched(
        rel,
        """package com.megacrit.cardcrawl.helpers;

import com.megacrit.cardcrawl.web.StsPlatform;

public class AsyncSaver {
   public static void save(String filepath, String data) {
      String clean = filepath.replace('\\\\', '/');
      File saveFile = new File(clean, data);
      saveFile.save();
      StsPlatform.bridge.onLocalFileSaved(clean, data);
   }

   public static void shutdownSaveThread() {
   }
}
""",
    )

    # File.java
    rel = "com/megacrit/cardcrawl/helpers/File.java"
    read_pristine(rel)
    write_patched(
        rel,
        """package com.megacrit.cardcrawl.helpers;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.files.FileHandle;
import java.nio.charset.StandardCharsets;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

public class File {
   private static final Logger logger = LogManager.getLogger(File.class.getName());
   private String filepath;
   private byte[] data;

   public File(String filepath, String data) {
      this.filepath = filepath.replace('\\\\', '/');
      this.data = data.getBytes(StandardCharsets.UTF_8);
   }

   public String getFilepath() {
      return this.filepath;
   }

   public void save() {
      try {
         FileHandle dest = Gdx.files.local(this.filepath);
         if (dest.exists()) {
            FileHandle backup = Gdx.files.local(this.filepath + ".backUp");
            dest.copyTo(backup);
         }
         dest.writeBytes(this.data, false);
      } catch (Exception e) {
         logger.warn("Failed saving local file: " + this.filepath, e);
      }
   }
}
""",
    )

    # FileSaver.java
    rel = "com/megacrit/cardcrawl/helpers/FileSaver.java"
    read_pristine(rel)
    write_patched(
        rel,
        """package com.megacrit.cardcrawl.helpers;

import java.util.concurrent.BlockingQueue;

public class FileSaver implements Runnable {
   public FileSaver(BlockingQueue<File> q) {
   }

   @Override
   public void run() {
   }
}
""",
    )

    # CharStat, RunHistoryScreen, Metrics, PatchNotesScreen
    for rel in (
        "com/megacrit/cardcrawl/screens/stats/CharStat.java",
        "com/megacrit/cardcrawl/screens/runHistory/RunHistoryScreen.java",
    ):
        s = read_pristine(rel).replace("File.separator", '"/"')
        write_patched(rel, s)

    rel = "com/megacrit/cardcrawl/metrics/Metrics.java"
    src = read_pristine(rel).replace("File.separator", '"/"')
    src = replace_once(
        src,
        "   private void sendPost(String url, final String fileToDelete) {\n",
        "   private void sendPost(String url, final String fileToDelete) {\n"
        "      if (com.megacrit.cardcrawl.web.StsPlatform.isWeb()) {\n"
        "         return;\n"
        "      }\n",
        rel,
    )
    write_patched(rel, src)

    rel = "com/megacrit/cardcrawl/screens/mainMenu/PatchNotesScreen.java"
    src = read_pristine(rel).replace("File.separator", '"/"')
    src = replace_once(
        src,
        "   private void openLog() {\n",
        "   private void openLog() {\n"
        "      if (!this.log.exists()) {\n"
        '         text = "Slay the Spire Web";\n'
        "         return;\n"
        "      }\n",
        rel,
    )
    write_patched(rel, src)


def patch_misc_stubs() -> None:
    # SystemStats
    rel = "com/megacrit/cardcrawl/core/SystemStats.java"
    src = read_pristine(rel)
    src = src.replace("import java.io.File;\n", "")
    src = src.replace('return new File("/").getTotalSpace();', "return 0L;")
    src = src.replace('return new File("/").getFreeSpace();', "return 0L;")
    src = src.replace('return new File("/").getUsableSpace();', "return 0L;")
    write_patched(rel, src)

    # TimeLookup
    rel = "com/megacrit/cardcrawl/daily/TimeLookup.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   public static void fetchDailyTimeAsync() {\n",
        "   public static void fetchDailyTimeAsync() {\n"
        "      if (com.megacrit.cardcrawl.web.StsPlatform.isWeb()) {\n"
        "         isDone = true;\n"
        "         TimeHelper.setTime(com.megacrit.cardcrawl.web.StsPlatform.bridge.getEpochSeconds(), false);\n"
        "         return;\n"
        "      }\n",
        rel,
    )
    write_patched(rel, src)

    # BotDataUploader
    rel = "com/megacrit/cardcrawl/metrics/BotDataUploader.java"
    read_pristine(rel)
    write_patched(
        rel,
        """package com.megacrit.cardcrawl.metrics;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;

public class BotDataUploader implements Runnable {
   public void setValues(BotDataUploader.GameDataType type, String header, ArrayList<String> data) {
   }

   public void sendPost(HashMap<String, Serializable> eventData) {
   }

   public static void uploadDataAsync(BotDataUploader.GameDataType type, String header, ArrayList<String> data) {
   }

   @Override
   public void run() {
   }

   public static void uploadKeywordData() {
   }

   public enum GameDataType {
      BANDITS,
      CRASH_DATA,
      DAILY_DATA,
      DEMO_EMBARK,
      VICTORY_DATA,
      CARD_DATA,
      ENEMY_DATA,
      RELIC_DATA,
      POTION_DATA,
      DAILY_MOD_DATA,
      BLIGHT_DATA,
      KEYWORD_DATA;
   }
}
""",
    )


def patch_input_and_controllers() -> None:
    for rel in (
        "com/megacrit/cardcrawl/helpers/input/ScrollInputProcessor.java",
        "com/megacrit/cardcrawl/helpers/TypeHelper.java",
        "com/megacrit/cardcrawl/screens/options/RemapInputElement.java",
    ):
        src = read_pristine(rel)
        src = src.replace("   @Override\n   public boolean scrolled(int amount) {", "   public boolean scrolled(int amount) {")
        src = replace_once(
            src,
            "   public boolean scrolled(int amount) {",
            "   @Override\n"
            "   public boolean touchCancelled(int screenX, int screenY, int pointer, int button) {\n"
            "      return false;\n"
            "   }\n\n"
            "   @Override\n"
            "   public boolean scrolled(float amountX, float amountY) {\n"
            "      return this.scrolled(amountY > 0.0F ? 1 : (amountY < 0.0F ? -1 : 0));\n"
            "   }\n\n"
            "   public boolean scrolled(int amount) {",
            rel,
        )
        if rel.endswith("TypeHelper.java"):
            src = replace_once(
                src,
                "   @Override\n"
                "   public boolean keyDown(int keycode) {\n"
                "      return false;\n"
                "   }",
                "   @Override\n"
                "   public boolean keyDown(int keycode) {\n"
                "      if (keycode == 67 || keycode == 112) {\n"
                "         if (this.seed) {\n"
                "            if (SeedPanel.textField != null && !SeedPanel.textField.isEmpty()) {\n"
                "               SeedPanel.textField = SeedPanel.textField.substring(0, SeedPanel.textField.length() - 1);\n"
                "            }\n"
                "         } else {\n"
                "            if (RenamePopup.textField != null && !RenamePopup.textField.isEmpty()) {\n"
                "               RenamePopup.textField = RenamePopup.textField.substring(0, RenamePopup.textField.length() - 1);\n"
                "            }\n"
                "         }\n"
                "         return true;\n"
                "      }\n"
                "      return false;\n"
                "   }",
                f"{rel}:backspace",
            )
        write_patched(rel, src)

    # CInputHelper
    rel = "com/megacrit/cardcrawl/helpers/controller/CInputHelper.java"
    src = read_pristine(rel)
    src = src.replace("import org.lwjgl.opengl.Display;\n", "")
    src = src.replace("Display.isActive()", "true")
    src = src.replace("Gdx.input.setCursorPosition((int)hb.cX, y);", "try { Gdx.input.setCursorPosition((int)hb.cX, y); } catch (Throwable ignored) {}")
    write_patched(rel, src)

    # CInputListener
    rel = "com/megacrit/cardcrawl/helpers/controller/CInputListener.java"
    src = read_pristine(rel)
    src = src.replace("import com.badlogic.gdx.controllers.PovDirection;\n", "")
    src = src.replace("import com.badlogic.gdx.math.Vector3;\n", "")
    idx = src.find("   @Override\n   public boolean povMoved(")
    if idx == -1:
        raise RuntimeError(f"Could not find povMoved in {rel}")
    src = src[:idx] + "}\n"
    write_patched(rel, src)


def patch_cards_and_music() -> None:
    rel = "com/megacrit/cardcrawl/cards/AbstractCard.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        '      oldCardAtlas = new TextureAtlas(Gdx.files.internal("oldCards/cards.atlas"));',
        '      oldCardAtlas = Gdx.files.internal("oldCards/cards.atlas").exists() ? new TextureAtlas(Gdx.files.internal("oldCards/cards.atlas")) : cardAtlas;',
        rel,
    )
    write_patched(rel, src)

    rel = "com/megacrit/cardcrawl/screens/SingleCardViewPopup.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        '      } else {\n'
        '         this.portraitImg = ImageMaster.loadImage("images/1024PortraitsBeta/" + this.card.assetUrl + ".png");\n'
        '      }',
        '      } else {\n'
        '         this.portraitImg = ImageMaster.loadImage("images/1024PortraitsBeta/" + this.card.assetUrl + ".png");\n'
        '         if (this.portraitImg == null) {\n'
        '            this.portraitImg = ImageMaster.loadImage("images/1024Portraits/" + this.card.assetUrl + ".png");\n'
        '         }\n'
        '      }',
        rel,
    )
    write_patched(rel, src)

    rel = "com/megacrit/cardcrawl/audio/MainMusic.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   public static Music newMusic(String path) {\n",
        "   public static Music newMusic(String path) {\n"
        "      if (com.megacrit.cardcrawl.web.StsPlatform.isWeb()) {\n"
        "         return com.megacrit.cardcrawl.web.StsPlatform.bridge.newMusic(path);\n"
        "      }\n",
        rel,
    )
    write_patched(rel, src)


def patch_decompiler_quirks() -> None:
    # 1. AbstractRoom: separate Iterator<AbstractRelic> variable
    rel = "com/megacrit/cardcrawl/rooms/AbstractRoom.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      i = this.relics.iterator();\n\n"
        "      while (i.hasNext()) {\n"
        "         AbstractRelic relic = (AbstractRelic)i.next();\n"
        "         relic.update();\n"
        "         if (relic.isDone) {\n"
        "            i.remove();\n"
        "         }\n"
        "      }",
        "      Iterator<AbstractRelic> rIter = this.relics.iterator();\n\n"
        "      while (rIter.hasNext()) {\n"
        "         AbstractRelic relic = rIter.next();\n"
        "         relic.update();\n"
        "         if (relic.isDone) {\n"
        "            rIter.remove();\n"
        "         }\n"
        "      }",
        f"{rel}:rIter",
    )
    write_patched(rel, src)

    # 2. Vineflower int/boolean decompile quirks
    for rel, old, new in (
        ("com/megacrit/cardcrawl/screens/runHistory/RunHistoryScreen.java", "int var25 = false;", "boolean var25 = false;"),
        ("com/megacrit/cardcrawl/screens/options/InputSettingsScreen.java", "int var6 = true;", "boolean var6 = true;"),
        ("com/megacrit/cardcrawl/shop/ShopScreen.java", "int var10 = false;", "boolean var10 = false;"),
    ):
        s = read_pristine(rel)
        if old in s:
            s = s.replace(old, new)
        write_patched(rel, s)

    # 3. Spine SkeletonJson: scope attachment switch cases
    rel = "com/esotericsoftware/spine/SkeletonJson.java"
    src = read_pristine(rel)
    src = replace_once(src, "         case region:\n", "         case region: {\n", f"{rel}:region")
    src = replace_once(src, "            return region;\n         case boundingbox:\n", "            return region;\n         }\n         case boundingbox: {\n", f"{rel}:bbox")
    src = replace_once(src, "            return box;\n         case mesh:\n         case linkedmesh:\n", "            return box;\n         }\n         case mesh:\n         case linkedmesh: {\n", f"{rel}:mesh")
    src = replace_once(src, "               return mesh;\n            }\n         case path:\n", "               return mesh;\n            }\n         }\n         case path: {\n", f"{rel}:path")
    src = replace_once(src, "            return path;\n         default:\n", "            return path;\n         }\n         default:\n", f"{rel}:default")
    write_patched(rel, src)

    # 4. Spine SkeletonBinary: scope attachment & timeline switch cases
    rel = "com/esotericsoftware/spine/SkeletonBinary.java"
    src = read_pristine(rel)
    src = replace_once(src, "         case region:\n", "         case region: {\n", f"{rel}:region")
    src = replace_once(src, "            return region;\n         case boundingbox:\n", "            return region;\n         }\n         case boundingbox: {\n", f"{rel}:bbox")
    src = replace_once(src, "            return box;\n         case mesh:\n", "            return box;\n         }\n         case mesh: {\n", f"{rel}:mesh")
    src = replace_once(src, "            return mesh;\n         case linkedmesh:\n", "            return mesh;\n         }\n         case linkedmesh: {\n", f"{rel}:linkedmesh")
    src = replace_once(src, "            return mesh;\n         case path:\n", "            return mesh;\n         }\n         case path: {\n", f"{rel}:path")
    src = replace_once(src, "               return path;\n            }\n         default:\n", "               return path;\n            }\n         }\n         default:\n", f"{rel}:default")

    # Timeline switch 1 (slot)
    src = replace_once(
        src,
        "               switch (timelineType) {\n                  case 0:\n                     Animation.AttachmentTimeline",
        "               switch (timelineType) {\n                  case 0: {\n                     Animation.AttachmentTimeline",
        f"{rel}:slot0",
    )
    src = replace_once(
        src,
        "                     break;\n                  case 1:\n                     Animation.ColorTimeline",
        "                     break;\n                  }\n                  case 1: {\n                     Animation.ColorTimeline",
        f"{rel}:slot1",
    )
    src = replace_once(
        src,
        "                     duration = Math.max(duration, timeline.getFrames()[(frameCount - 1) * 5]);\n               }",
        "                     duration = Math.max(duration, timeline.getFrames()[(frameCount - 1) * 5]);\n                  }\n               }",
        f"{rel}:slotEnd",
    )

    # Timeline switch 2 (bone)
    src = replace_once(
        src,
        "               switch (timelineType) {\n                  case 0:\n                     Animation.RotateTimeline",
        "               switch (timelineType) {\n                  case 0: {\n                     Animation.RotateTimeline",
        f"{rel}:bone0",
    )
    src = replace_once(
        src,
        "                     break;\n                  case 1:\n                  case 2:\n                  case 3:\n",
        "                     break;\n                  }\n                  case 1:\n                  case 2:\n                  case 3: {\n",
        f"{rel}:bone1",
    )
    src = replace_once(
        src,
        "                     duration = Math.max(duration, timeline.getFrames()[(frameCount - 1) * 3]);\n               }",
        "                     duration = Math.max(duration, timeline.getFrames()[(frameCount - 1) * 3]);\n                  }\n               }",
        f"{rel}:boneEnd",
    )

    # Timeline switch 3 (path)
    src = replace_once(
        src,
        "               switch (timelineType) {\n                  case 0:\n                  case 1:\n",
        "               switch (timelineType) {\n                  case 0:\n                  case 1: {\n",
        f"{rel}:path0",
    )
    src = replace_once(
        src,
        "                     break;\n                  case 2:\n                     Animation.PathConstraintMixTimeline",
        "                     break;\n                  }\n                  case 2: {\n                     Animation.PathConstraintMixTimeline",
        f"{rel}:path2",
    )
    src = replace_once(
        src,
        "                     timelines.add(timeline);\n                     duration = Math.max(duration, timeline.getFrames()[(frameCount - 1) * 3]);\n               }",
        "                     timelines.add(timeline);\n                     duration = Math.max(duration, timeline.getFrames()[(frameCount - 1) * 3]);\n                  }\n               }",
        f"{rel}:pathEnd",
    )
    write_patched(rel, src)

    # 5. Spine PathConstraint: TeaVM Float64 vs Float32Array precision clamp
    rel = "com/esotericsoftware/spine/PathConstraint.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "               while (true) {\n"
        "                  float length = lengths[curve];\n"
        "                  if (!(p > length)) {",
        "               while (true) {\n"
        "                  float length = lengths[curve];\n"
        "                  if (!(p > length) || curve >= curveCount || curve >= lengths.length - 1) {\n"
        "                     if (p > length) {\n"
        "                        p = length;\n"
        "                     }",
        f"{rel}:lengthsGuard",
    )
    src = replace_once(
        src,
        "            curves[i] = pathLength;\n"
        "            x1 = x2;\n"
        "            y1 = y2;\n"
        "            i++;\n"
        "         }",
        "            curves[i] = pathLength;\n"
        "            x1 = x2;\n"
        "            y1 = y2;\n"
        "            i++;\n"
        "         }\n\n"
        "         if (curveCount > 0) {\n"
        "            pathLength = curves[curveCount - 1];\n"
        "         }",
        f"{rel}:pathLengthFloat32",
    )
    src = replace_once(
        src,
        "               while (true) {\n"
        "                  float length = curves[curve];\n"
        "                  if (!(p > length)) {",
        "               while (true) {\n"
        "                  float length = curves[curve];\n"
        "                  if (!(p > length) || curve >= curveCount - 1) {\n"
        "                     if (p > length) {\n"
        "                        p = length;\n"
        "                     }",
        f"{rel}:curvesGuard",
    )
    src = replace_once(
        src,
        "                        segments[9] = curveLength;\n"
        "                        segment = 0;",
        "                        segments[9] = curveLength;\n"
        "                        curveLength = segments[9];\n"
        "                        segment = 0;",
        f"{rel}:curveLengthFloat32",
    )
    src = replace_once(
        src,
        "                     while (true) {\n"
        "                        length = segments[segment];\n"
        "                        if (!(p > length)) {",
        "                     while (true) {\n"
        "                        length = segments[segment];\n"
        "                        if (!(p > length) || segment >= 9) {\n"
        "                           if (p > length) {\n"
        "                              p = length;\n"
        "                           }",
        f"{rel}:segmentsGuard",
    )
    write_patched(rel, src)


def patch_web_scanner() -> None:
    scanner_files = (
        "com/megacrit/cardcrawl/core/CardCrawlGame.java",
        "com/megacrit/cardcrawl/relics/AbstractRelic.java",
        "com/megacrit/cardcrawl/blights/AbstractBlight.java",
        "com/megacrit/cardcrawl/cutscenes/NeowNarrationScreen.java",
        "com/megacrit/cardcrawl/events/GenericEventDialog.java",
        "com/megacrit/cardcrawl/events/RoomEventDialog.java",
        "com/megacrit/cardcrawl/vfx/MegaDialogTextEffect.java",
        "com/megacrit/cardcrawl/vfx/SpeechTextEffect.java",
    )
    for rel in scanner_files:
        live = os.path.join(CORE_JAVA, rel)
        # CardCrawlGame already patched earlier; preserve earlier patches if present
        if rel == "com/megacrit/cardcrawl/core/CardCrawlGame.java":
            with open(live, "r", encoding="utf-8") as f:
                src = f.read()
        else:
            src = read_pristine(rel)
        src = src.replace("import java.util.Scanner;", "import com.megacrit.cardcrawl.web.WebScanner;")
        src = re.sub(r"\bScanner\b", "WebScanner", src)
        write_patched(rel, src)


def patch_coop_hooks() -> None:
    # 1. MenuButton.java
    rel = "com/megacrit/cardcrawl/screens/mainMenu/MenuButton.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "         case PATCH_NOTES:\n"
        "            this.label = TEXT[9];\n"
        "            break;",
        "         case COOP:\n"
        "            this.label = \"Multiplayer Co-op\";\n"
        "            break;\n"
        "         case PATCH_NOTES:\n"
        "            this.label = TEXT[9];\n"
        "            break;",
        f"{rel}:setLabel",
    )
    src = replace_once(
        src,
        "      if (this.hb.clicked) {\n"
        "         this.hb.clicked = false;\n"
        "         this.buttonEffect();\n"
        "         CardCrawlGame.mainMenuScreen.hideMenuButtons();\n"
        "      }",
        "      if (this.hb.clicked) {\n"
        "         this.hb.clicked = false;\n"
        "         this.buttonEffect();\n"
        "         if (this.result != MenuButton.ClickResult.COOP) {\n"
        "            CardCrawlGame.mainMenuScreen.hideMenuButtons();\n"
        "         }\n"
        "      }",
        f"{rel}:keepButtonsForCoop",
    )
    src = replace_once(
        src,
        "         case PATCH_NOTES:\n"
        "            CardCrawlGame.mainMenuScreen.patchNotesScreen.open();",
        "         case COOP:\n"
        "            com.megacrit.cardcrawl.web.StsPlatform.bridge.openLobbyOverlay();\n"
        "            break;\n"
        "         case PATCH_NOTES:\n"
        "            CardCrawlGame.mainMenuScreen.patchNotesScreen.open();",
        f"{rel}:buttonEffect",
    )
    src = replace_once(
        src,
        "   public enum ClickResult {\n"
        "      PLAY,",
        "   public enum ClickResult {\n"
        "      COOP,\n"
        "      PLAY,",
        f"{rel}:enum",
    )
    write_patched(rel, src)

    # 2. MainMenuScreen.java
    rel = "com/megacrit/cardcrawl/screens/mainMenu/MainMenuScreen.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      if (!Settings.isMobile && !Settings.isConsoleBuild) {\n"
        "         this.buttons.add(new MenuButton(MenuButton.ClickResult.QUIT, index++));\n"
        "         this.buttons.add(new MenuButton(MenuButton.ClickResult.PATCH_NOTES, index++));\n"
        "      }",
        "      if (!Settings.isMobile && !Settings.isConsoleBuild) {\n"
        "         if (!com.megacrit.cardcrawl.web.StsPlatform.isWeb()) {\n"
        "            this.buttons.add(new MenuButton(MenuButton.ClickResult.QUIT, index++));\n"
        "         }\n"
        "         this.buttons.add(new MenuButton(MenuButton.ClickResult.PATCH_NOTES, index++));\n"
        "      }",
        f"{rel}:hideQuitOnWeb",
    )
    src = replace_once(
        src,
        "      if (CardCrawlGame.characterManager.anySaveFileExists()) {",
        "      this.buttons.add(new MenuButton(MenuButton.ClickResult.COOP, index++));\n"
        "      if (CardCrawlGame.characterManager.anySaveFileExists()) {",
        f"{rel}:addCoopButton",
    )
    write_patched(rel, src)

    # 3. MapRoomNode.java
    rel = "com/megacrit/cardcrawl/map/MapRoomNode.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "               if (AbstractDungeon.screen == AbstractDungeon.CurrentScreen.MAP && AbstractDungeon.dungeonMapScreen.clicked && this.animWaitTimer <= 0.0F) {\n",
        "               if (AbstractDungeon.screen == AbstractDungeon.CurrentScreen.MAP && AbstractDungeon.dungeonMapScreen.clicked && this.animWaitTimer <= 0.0F) {\n"
        "                  if (com.megacrit.cardcrawl.coop.CoopCombatSync.interceptMapNodeClick(this)) {\n"
        "                     return;\n"
        "                  }\n",
        f"{rel}:interceptNext",
    )
    src = replace_once(
        src,
        "            if (AbstractDungeon.screen == AbstractDungeon.CurrentScreen.MAP\n"
        "               && (CInputActionSet.select.isJustPressed() || AbstractDungeon.dungeonMapScreen.clicked)) {\n",
        "            if (AbstractDungeon.screen == AbstractDungeon.CurrentScreen.MAP\n"
        "               && (CInputActionSet.select.isJustPressed() || AbstractDungeon.dungeonMapScreen.clicked)) {\n"
        "               if (com.megacrit.cardcrawl.coop.CoopCombatSync.interceptMapNodeClick(this)) {\n"
        "                  return;\n"
        "               }\n",
        f"{rel}:interceptFirst",
    )
    src = replace_once(
        src,
        "      if (this.hb != null) {\n"
        "         this.hb.render(sb);\n"
        "      }\n"
        "   }",
        "      if (this.hb != null) {\n"
        "         this.hb.render(sb);\n"
        "      }\n"
        "      com.megacrit.cardcrawl.coop.CoopRenderer.renderMapVotes(sb, this);\n"
        "   }\n\n"
        "   public void coopSelectNode() {\n"
        "      boolean normalConnection = AbstractDungeon.getCurrMapNode().isConnectedTo(this);\n"
        "      boolean wingedConnection = AbstractDungeon.getCurrMapNode().wingedIsConnectedTo(this);\n"
        "      this.playNodeSelectedSound();\n"
        "      if (AbstractDungeon.dungeonMapScreen != null) {\n"
        "         AbstractDungeon.dungeonMapScreen.clicked = false;\n"
        "         AbstractDungeon.dungeonMapScreen.clickTimer = 0.0F;\n"
        "         AbstractDungeon.dungeonMapScreen.dismissable = true;\n"
        "      }\n"
        "      if (!AbstractDungeon.firstRoomChosen && this.y == 0) {\n"
        "         AbstractDungeon.firstRoomChosen = true;\n"
        "      } else if (!normalConnection && wingedConnection && AbstractDungeon.player.hasRelic(\"WingedGreaves\")) {\n"
        "         AbstractDungeon.player.getRelic(\"WingedGreaves\").counter--;\n"
        "         if (AbstractDungeon.player.getRelic(\"WingedGreaves\").counter <= 0) {\n"
        "            AbstractDungeon.player.getRelic(\"WingedGreaves\").setCounter(-2);\n"
        "         }\n"
        "      }\n"
        "      AbstractDungeon.topLevelEffects.add(new MapCircleEffect(this.x * SPACING_X + OFFSET_X + this.offsetX, this.y * Settings.MAP_DST_Y + OFFSET_Y + DungeonMapScreen.offsetY + this.offsetY, this.angle));\n"
        "      if (!Settings.FAST_MODE) {\n"
        "         AbstractDungeon.topLevelEffects.add(new FadeWipeParticle());\n"
        "      }\n"
        "      this.animWaitTimer = 0.1F;\n"
        "      if (this.room instanceof EventRoom) {\n"
        "         CardCrawlGame.mysteryMachine++;\n"
        "      }\n"
        "   }",
        f"{rel}:renderVotesAndCoopSelect",
    )
    write_patched(rel, src)

    # 4. DungeonMap.java
    rel = "com/megacrit/cardcrawl/map/DungeonMap.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "         && this.bossHb.hovered\n"
        "         && (InputHelper.justClickedLeft || CInputActionSet.select.isJustPressed())) {\n",
        "         && this.bossHb.hovered\n"
        "         && (InputHelper.justClickedLeft || CInputActionSet.select.isJustPressed())) {\n"
        "         if (com.megacrit.cardcrawl.coop.CoopCombatSync.interceptBossNodeClick()) {\n"
        "            return;\n"
        "         }\n",
        f"{rel}:bossVote",
    )
    src = replace_once(
        src,
        "         this.bossHb.render(sb);\n",
        "         this.bossHb.render(sb);\n"
        "         com.megacrit.cardcrawl.coop.CoopRenderer.renderBossMapVotes(sb, this.bossHb);\n",
        f"{rel}:bossVoteRender",
    )
    write_patched(rel, src)

    # 5. AbstractRoom.java (already reset from pristine + patched inside patch_decompiler_quirks)
    rel = "com/megacrit/cardcrawl/rooms/AbstractRoom.java"
    live_room = os.path.join(CORE_JAVA, rel)
    with open(live_room, "r", encoding="utf-8") as f:
        src = f.read()
    src = replace_once(
        src,
        "                  if (!this.monsters.areMonstersBasicallyDead() && AbstractDungeon.player.currentHealth > 0) {\n"
        "                     AbstractDungeon.player.updateInput();\n"
        "                  }",
        "                  if (!this.monsters.areMonstersBasicallyDead() && AbstractDungeon.player.currentHealth > 0) {\n"
        "                     if (com.megacrit.cardcrawl.coop.CoopManager.localEndTurnWaiting) {\n"
        "                        if (AbstractDungeon.player.isDraggingCard || AbstractDungeon.player.inSingleTargetMode || AbstractDungeon.player.hoveredCard != null) {\n"
        "                           AbstractDungeon.player.releaseCard();\n"
        "                        }\n"
        "                     } else {\n"
        "                        AbstractDungeon.player.updateInput();\n"
        "                     }\n"
        "                  }",
        f"{rel}:lockInputWhenWaitingTurn",
    )
    src = replace_once(
        src,
        "                  AbstractDungeon.overlayMenu.showCombatPanels();\n",
        "                  AbstractDungeon.overlayMenu.showCombatPanels();\n"
        "                  com.megacrit.cardcrawl.coop.CoopCombatSync.onBattleStart(this);\n",
        f"{rel}:battleStart",
    )
    src = replace_once(
        src,
        "   public void endBattle() {\n"
        "      this.isBattleOver = true;\n",
        "   public void endBattle() {\n"
        "      this.isBattleOver = true;\n"
        "      com.megacrit.cardcrawl.coop.CoopCombatSync.onBattleVictory();\n",
        f"{rel}:endBattle",
    )
    src = replace_once(
        src,
        "         if (AbstractDungeon.screen != AbstractDungeon.CurrentScreen.BOSS_REWARD) {\n"
        "            AbstractDungeon.player.render(sb);\n"
        "         }",
        "         if (AbstractDungeon.screen != AbstractDungeon.CurrentScreen.BOSS_REWARD) {\n"
        "            AbstractDungeon.player.render(sb);\n"
        "            com.megacrit.cardcrawl.coop.CoopRenderer.renderTeammates(sb);\n"
        "         }",
        f"{rel}:renderTeammates",
    )
    src = replace_once(
        src,
        "         if (AbstractDungeon.screen != AbstractDungeon.CurrentScreen.VICTORY) {\n"
        "            AbstractDungeon.player.render(sb);\n"
        "         }",
        "         if (AbstractDungeon.screen != AbstractDungeon.CurrentScreen.VICTORY) {\n"
        "            AbstractDungeon.player.render(sb);\n"
        "            com.megacrit.cardcrawl.coop.CoopRenderer.renderTeammates(sb);\n"
        "         }",
        f"{rel}:renderEventTeammates",
    )
    write_patched(rel, src)

    # 6. SpawnMonsterAction.java
    rel = "com/megacrit/cardcrawl/actions/common/SpawnMonsterAction.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "         this.m.init();\n",
        "         this.m.init();\n"
        "         com.megacrit.cardcrawl.coop.CoopCombatSync.onMonsterSpawned(this.m);\n",
        f"{rel}:scaleSpawn",
    )
    write_patched(rel, src)

    # 7. TimeWarpPower.java & InvinciblePower.java
    rel = "com/megacrit/cardcrawl/powers/TimeWarpPower.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      this.description = DESC[0] + 12 + DESC[1] + 2 + DESC[2];",
        "      this.description = DESC[0] + com.megacrit.cardcrawl.coop.CoopCombatSync.getTimeWarpLimit() + DESC[1] + 2 + DESC[2];",
        f"{rel}:desc",
    )
    src = replace_once(
        src,
        "      if (this.amount == 12) {",
        "      if (this.amount >= com.megacrit.cardcrawl.coop.CoopCombatSync.getTimeWarpLimit()) {",
        f"{rel}:trigger",
    )
    write_patched(rel, src)

    rel = "com/megacrit/cardcrawl/powers/InvinciblePower.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   public InvinciblePower(AbstractCreature owner, int amount) {\n",
        "   public InvinciblePower(AbstractCreature owner, int amount) {\n"
        "      amount = com.megacrit.cardcrawl.coop.CoopCombatSync.scaleInvincibleAmount(amount);\n",
        f"{rel}:scale",
    )
    write_patched(rel, src)

    # 8. AbstractMonster.java
    rel = "com/megacrit/cardcrawl/monsters/AbstractMonster.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "         boolean weakenedToZero = damageAmount == 0;\n"
        "         damageAmount = this.decrementBlock(info, damageAmount);",
        "         boolean weakenedToZero = damageAmount == 0;\n"
        "         int prevBlockForCoop = this.currentBlock;\n"
        "         damageAmount = this.decrementBlock(info, damageAmount);",
        f"{rel}:prevBlock",
    )
    src = replace_once(
        src,
        "         this.lastDamageTaken = Math.min(damageAmount, this.currentHealth);\n",
        "         this.lastDamageTaken = Math.min(damageAmount, this.currentHealth);\n"
        "         com.megacrit.cardcrawl.coop.CoopCombatSync.onLocalMonsterDamaged(this, this.lastDamageTaken, Math.max(0, prevBlockForCoop - this.currentBlock));\n",
        f"{rel}:damageSync",
    )
    src = replace_once(
        src,
        "            this.renderDamageRange(sb);\n",
        "            this.renderDamageRange(sb);\n"
        "            com.megacrit.cardcrawl.coop.CoopRenderer.renderMonsterTargetBadge(sb, this);\n",
        f"{rel}:intentBadge",
    )
    write_patched(rel, src)

    # 9. ApplyPowerAction.java
    rel = "com/megacrit/cardcrawl/actions/common/ApplyPowerAction.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "            AbstractDungeon.effectList.add(new FlashAtkImgEffect(this.target.hb.cX, this.target.hb.cY, this.attackEffect));",
        "            if (this.target instanceof AbstractMonster) {\n"
        "               com.megacrit.cardcrawl.coop.CoopCombatSync.onLocalMonsterPowerApplied(this, (AbstractMonster)this.target, this.source, this.powerToApply, this.amount);\n"
        "            }\n"
        "            AbstractDungeon.effectList.add(new FlashAtkImgEffect(this.target.hb.cX, this.target.hb.cY, this.attackEffect));",
        f"{rel}:powerSync",
    )
    write_patched(rel, src)

    # 10. EndTurnButton.java
    rel = "com/megacrit/cardcrawl/ui/buttons/EndTurnButton.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   public void disable(boolean isEnemyTurn) {\n",
        "   public void disable(boolean isEnemyTurn) {\n"
        "      if (isEnemyTurn && com.megacrit.cardcrawl.coop.CoopCombatSync.interceptEndTurn(this)) {\n"
        "         return;\n"
        "      }\n",
        f"{rel}:endTurnBarrier",
    )
    write_patched(rel, src)

    # 11. AbstractPlayer.java
    rel = "com/megacrit/cardcrawl/characters/AbstractPlayer.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      if (!this.hand.canUseAnyCard() && !this.endTurnQueued) {\n"
        "         AbstractDungeon.overlayMenu.endTurnButton.isGlowing = true;\n"
        "      }\n"
        "   }",
        "      if (!this.hand.canUseAnyCard() && !this.endTurnQueued) {\n"
        "         AbstractDungeon.overlayMenu.endTurnButton.isGlowing = true;\n"
        "      }\n"
        "      com.megacrit.cardcrawl.coop.CoopManager.onLocalCardPlayed(c);\n"
        "   }",
        f"{rel}:useCard",
    )
    src = replace_once(
        src,
        "   @Override\n"
        "   public void damage(DamageInfo info) {\n",
        "   @Override\n"
        "   public void damage(DamageInfo info) {\n"
        "      if (com.megacrit.cardcrawl.coop.CoopCombatSync.shouldRedirectMonsterAttackToTeammate(info)) {\n"
        "         return;\n"
        "      }\n",
        f"{rel}:filterDamage",
    )
    src = replace_once(
        src,
        "            this.isDead = true;\n"
        "            AbstractDungeon.deathScreen = new DeathScreen(AbstractDungeon.getMonsters());",
        "            if (com.megacrit.cardcrawl.coop.CoopCombatSync.interceptPlayerLethalDamage(this)) {\n"
        "               return;\n"
        "            }\n"
        "            this.isDead = true;\n"
        "            AbstractDungeon.deathScreen = new DeathScreen(AbstractDungeon.getMonsters());",
        f"{rel}:downedIntercept",
    )
    write_patched(rel, src)

    # 12. RestOption.java
    rel = "com/megacrit/cardcrawl/ui/campfire/RestOption.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      CardCrawlGame.metricData.addCampfireChoiceData(\"REST\");\n   }",
        "      CardCrawlGame.metricData.addCampfireChoiceData(\"REST\");\n"
        "      com.megacrit.cardcrawl.coop.CoopCombatSync.onCampfireRest();\n   }",
        f"{rel}:campfireRevive",
    )
    write_patched(rel, src)

    # 13. TopPanel.java (keep clean vanilla TopPanel; no overlay strip below TopPanel)
    rel = "com/megacrit/cardcrawl/ui/panels/TopPanel.java"
    src = read_pristine(rel)
    write_patched(rel, src)

    # 15. RenamePopup.java & SaveSlotScreen.java (sync in-game savefile name -> Spire Net)
    rel = "com/megacrit/cardcrawl/ui/panels/RenamePopup.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "            CardCrawlGame.playerPref.flush();\n"
        "            CardCrawlGame.playerName = textField;",
        "            CardCrawlGame.playerPref.flush();\n"
        "            CardCrawlGame.playerName = textField;\n"
        "            com.megacrit.cardcrawl.web.StsPlatform.bridge.onPlayerNameChanged(CardCrawlGame.playerName);",
        f"{rel}:newSaveSync",
    )
    src = replace_once(
        src,
        "            CardCrawlGame.mainMenuScreen.saveSlotScreen.rename(this.slot, textField);\n"
        "            CardCrawlGame.playerName = textField;",
        "            CardCrawlGame.mainMenuScreen.saveSlotScreen.rename(this.slot, textField);\n"
        "            CardCrawlGame.playerName = textField;\n"
        "            com.megacrit.cardcrawl.web.StsPlatform.bridge.onPlayerNameChanged(CardCrawlGame.playerName);",
        f"{rel}:renameSync",
    )
    write_patched(rel, src)

    rel = "com/megacrit/cardcrawl/screens/mainMenu/SaveSlotScreen.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      CardCrawlGame.playerName = this.slots.get(slot).getName();",
        "      CardCrawlGame.playerName = this.slots.get(slot).getName();\n"
        "      com.megacrit.cardcrawl.web.StsPlatform.bridge.onPlayerNameChanged(CardCrawlGame.playerName);",
        f"{rel}:slotConfirmSync",
    )
    write_patched(rel, src)

    # 16. FontHelper.java (fallback for stripped CJK/KOR fonts, especially leaderboardFont)
    rel = "com/megacrit/cardcrawl/helpers/FontHelper.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "      fontFile = Gdx.files.internal(\"font/zhs/NotoSansMonoCJKsc-Regular.otf\");\n"
        "      leaderboardFont = prepFont(30.0F, false);",
        "      fontFile = Gdx.files.internal(\"font/Kreon-Regular.ttf\");\n"
        "      leaderboardFont = prepFont(30.0F, false);",
        f"{rel}:leaderboardFont",
    )
    src = replace_once(
        src,
        "   public static BitmapFont prepFont(float size, boolean isLinearFiltering) {\n"
        "      FreeTypeFontGenerator g;\n",
        "   public static BitmapFont prepFont(float size, boolean isLinearFiltering) {\n"
        "      if (fontFile == null || !fontFile.exists()) {\n"
        "         fontFile = Gdx.files.internal(\"font/Kreon-Regular.ttf\");\n"
        "      }\n"
        "      FreeTypeFontGenerator g;\n",
        f"{rel}:prepFontFallback",
    )
    write_patched(rel, src)

    # 17. PotionPopUp.java (block potion usage while waiting on Co-op End Turn barrier)
    rel = "com/megacrit/cardcrawl/ui/panels/PotionPopUp.java"
    src = read_pristine(rel)
    src = replace_once(
        src,
        "   private void updateTargetMode() {\n",
        "   private void updateTargetMode() {\n"
        "      if (com.megacrit.cardcrawl.coop.CoopManager.localEndTurnWaiting && AbstractDungeon.getCurrRoom() != null && AbstractDungeon.getCurrRoom().phase == AbstractRoom.RoomPhase.COMBAT) {\n"
        "         this.targetMode = false;\n"
        "         GameCursor.hidden = false;\n"
        "         this.close();\n"
        "         return;\n"
        "      }\n",
        f"{rel}:lockTargetMode",
    )
    src = replace_once(
        src,
        "   private void updateInput() {\n",
        "   private void updateInput() {\n"
        "      if (com.megacrit.cardcrawl.coop.CoopManager.localEndTurnWaiting && AbstractDungeon.getCurrRoom() != null && AbstractDungeon.getCurrRoom().phase == AbstractRoom.RoomPhase.COMBAT) {\n"
        "         this.targetMode = false;\n"
        "         GameCursor.hidden = false;\n"
        "         this.close();\n"
        "         return;\n"
        "      }\n",
        f"{rel}:lockPotionInput",
    )
    write_patched(rel, src)


def patch_vfx_power_lifecycle() -> None:
    for rel in (
        "com/megacrit/cardcrawl/vfx/combat/GainPowerEffect.java",
        "com/megacrit/cardcrawl/vfx/combat/SilentGainPowerEffect.java",
    ):
        src = read_pristine(rel)
        src = replace_once(
            src,
            "      } else {\n"
            "         this.color.a = Interpolation.fade.apply(0.5F, 0.0F, 1.0F - this.duration);\n"
            "      }",
            "      } else {\n"
            "         this.color.a = Interpolation.fade.apply(0.5F, 0.0F, 1.0F - this.duration);\n"
            "      }\n"
            "      if (this.duration < 0.0F) {\n"
            "         this.isDone = true;\n"
            "         this.color.a = 0.0F;\n"
            "      }",
            f"{rel}:isDoneGuard",
        )
        write_patched(rel, src)


def main() -> int:
    if not os.path.isdir(os.path.join(CORE_JAVA, "com", "megacrit", "cardcrawl", "core")):
        print("Decompiled source missing. Run tools/decompile_sts.py first.", file=sys.stderr)
        return 1

    patch_display_config()
    patch_settings()
    patch_card_crawl_game()
    patch_screen_shake()
    patch_input_helper()
    patch_localized_strings()
    patch_save_and_files()
    patch_misc_stubs()
    patch_input_and_controllers()
    patch_cards_and_music()
    patch_decompiler_quirks()
    patch_web_scanner()
    patch_coop_hooks()
    patch_vfx_power_lifecycle()

    print("[patch] Successfully patched core STS sources (single-player + Co-op) for LibGDX 1.14.2 + TeaVM web.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
