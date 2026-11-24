package com.google.gson;

import com.badlogic.gdx.utils.JsonReader;
import com.badlogic.gdx.utils.JsonValue;
import com.google.gson.reflect.TypeToken;
import com.megacrit.cardcrawl.cards.CardSave;
import com.megacrit.cardcrawl.localization.*;
import com.megacrit.cardcrawl.rewards.RewardSave;
import com.megacrit.cardcrawl.saveAndContinue.SaveFile;
import com.megacrit.cardcrawl.screens.stats.*;
import java.lang.reflect.Type;
import java.util.*;

/**
 * Zero-reflection Gson replacement backed by LibGDX JsonReader for TeaVM AOT compatibility.
 */
public class Gson {
    private final boolean prettyPrinting;
    private static final JsonReader READER = new JsonReader();

    public Gson() {
        this(false);
    }

    public Gson(boolean prettyPrinting) {
        this.prettyPrinting = prettyPrinting;
    }

    public <T> T fromJson(String json, Class<T> classOfT) throws JsonSyntaxException {
        if (json == null || json.trim().isEmpty()) {
            return null;
        }
        try {
            JsonValue root = READER.parse(json);
            if (root == null || root.isNull()) {
                return null;
            }
            if (classOfT == SaveFile.class) {
                @SuppressWarnings("unchecked")
                T res = (T) parseSaveFile(root);
                return res;
            }
            if (classOfT == RunData.class) {
                @SuppressWarnings("unchecked")
                T res = (T) parseRunData(root);
                return res;
            }
            if (classOfT == Map.class || classOfT == HashMap.class) {
                @SuppressWarnings("unchecked")
                T res = (T) toJavaMap(root);
                return res;
            }
            throw new JsonSyntaxException("Unsupported Gson class: " + classOfT.getName());
        } catch (JsonSyntaxException e) {
            throw e;
        } catch (Exception e) {
            throw new JsonSyntaxException(e);
        }
    }

    @SuppressWarnings("unchecked")
    public <T> T fromJson(String json, Type typeOfT) throws JsonSyntaxException {
        if (json == null || json.trim().isEmpty()) {
            return null;
        }
        try {
            JsonValue root = READER.parse(json);
            if (root == null || root.isNull()) {
                return null;
            }
            if (typeOfT instanceof TypeToken.MapType) {
                Class<?> valType = ((TypeToken.MapType) typeOfT).valueType;
                return (T) parseTypedMap(root, valType);
            }
            if (typeOfT instanceof Class<?>) {
                return (T) fromJson(json, (Class<?>) typeOfT);
            }
            return (T) parseStringMap(root);
        } catch (JsonSyntaxException e) {
            throw e;
        } catch (Exception e) {
            throw new JsonSyntaxException(e);
        }
    }

    public String toJson(Object src) {
        StringBuilder sb = new StringBuilder(256);
        writeJsonValue(sb, src, 0);
        return sb.toString();
    }

    // -------------------------------------------------------------------------
    // JSON Serialization (Reflection-Free)
    // -------------------------------------------------------------------------

    private void writeIndent(StringBuilder sb, int depth) {
        if (!prettyPrinting) return;
        sb.append('\n');
        for (int i = 0; i < depth; i++) {
            sb.append("  ");
        }
    }

    private void writeJsonValue(StringBuilder sb, Object val, int depth) {
        if (val == null) {
            sb.append("null");
            return;
        }
        if (val instanceof String) {
            writeQuotedString(sb, (String) val);
            return;
        }
        if (val instanceof Boolean || val instanceof Integer || val instanceof Long || val instanceof Short || val instanceof Byte) {
            sb.append(val.toString());
            return;
        }
        if (val instanceof Float || val instanceof Double) {
            double d = ((Number) val).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) {
                sb.append("null");
            } else {
                sb.append(val.toString());
            }
            return;
        }
        if (val instanceof Enum<?>) {
            writeQuotedString(sb, ((Enum<?>) val).name());
            return;
        }
        if (val instanceof CardSave) {
            CardSave cs = (CardSave) val;
            Map<String, Object> m = new LinkedHashMap<>(3);
            m.put("upgrades", cs.upgrades);
            m.put("misc", cs.misc);
            m.put("id", cs.id);
            writeMap(sb, m, depth);
            return;
        }
        if (val instanceof RewardSave) {
            RewardSave rs = (RewardSave) val;
            Map<String, Object> m = new LinkedHashMap<>(4);
            m.put("type", rs.type);
            m.put("id", rs.id);
            m.put("amount", rs.amount);
            m.put("bonusGold", rs.bonusGold);
            writeMap(sb, m, depth);
            return;
        }
        if (val instanceof Map<?, ?>) {
            writeMap(sb, (Map<?, ?>) val, depth);
            return;
        }
        if (val instanceof Iterable<?>) {
            writeIterable(sb, (Iterable<?>) val, depth);
            return;
        }
        if (val instanceof Object[]) {
            writeIterable(sb, Arrays.asList((Object[]) val), depth);
            return;
        }
        if (val instanceof int[]) {
            int[] arr = (int[]) val;
            List<Integer> list = new ArrayList<>(arr.length);
            for (int v : arr) list.add(v);
            writeIterable(sb, list, depth);
            return;
        }
        writeQuotedString(sb, String.valueOf(val));
    }

    private void writeMap(StringBuilder sb, Map<?, ?> map, int depth) {
        if (map.isEmpty()) {
            sb.append("{}");
            return;
        }
        sb.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            writeIndent(sb, depth + 1);
            writeQuotedString(sb, String.valueOf(entry.getKey()));
            sb.append(prettyPrinting ? ": " : ":");
            writeJsonValue(sb, entry.getValue(), depth + 1);
        }
        writeIndent(sb, depth);
        sb.append('}');
    }

    private void writeIterable(StringBuilder sb, Iterable<?> it, int depth) {
        Iterator<?> iter = it.iterator();
        if (!iter.hasNext()) {
            sb.append("[]");
            return;
        }
        sb.append('[');
        boolean first = true;
        while (iter.hasNext()) {
            if (!first) sb.append(',');
            first = false;
            writeIndent(sb, depth + 1);
            writeJsonValue(sb, iter.next(), depth + 1);
        }
        writeIndent(sb, depth);
        sb.append(']');
    }

    public static void writeQuotedString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        String hex = Integer.toHexString(c);
                        sb.append("\\u");
                        for (int k = hex.length(); k < 4; k++) sb.append('0');
                        sb.append(hex);
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // -------------------------------------------------------------------------
    // Generic Helpers
    // -------------------------------------------------------------------------

    private static String asStr(JsonValue v) {
        if (v == null || v.isNull()) return null;
        if (v.isString()) return v.asString();
        if (v.isBoolean()) return Boolean.toString(v.asBoolean());
        if (v.isLong()) return Long.toString(v.asLong());
        if (v.isDouble()) return Double.toString(v.asDouble());
        return v.asString();
    }

    private static String getStr(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        return asStr(v);
    }

    private static int getInt(JsonValue obj, String key, int def) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull()) return def;
        return v.asInt();
    }

    private static long getLong(JsonValue obj, String key, long def) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull()) return def;
        return v.asLong();
    }

    private static Long getBoxedLong(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull()) return null;
        return v.asLong();
    }

    private static boolean getBool(JsonValue obj, String key, boolean def) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull()) return def;
        return v.asBoolean();
    }

    private static String[] getStrArr(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull() || !v.isArray()) return null;
        String[] out = new String[v.size];
        int idx = 0;
        for (JsonValue child = v.child; child != null; child = child.next) {
            out[idx++] = asStr(child);
        }
        return out;
    }

    private static ArrayList<String> getStrList(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull() || !v.isArray()) return null;
        ArrayList<String> list = new ArrayList<>(v.size);
        for (JsonValue child = v.child; child != null; child = child.next) {
            list.add(asStr(child));
        }
        return list;
    }

    private static ArrayList<Integer> getIntList(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull() || !v.isArray()) return null;
        ArrayList<Integer> list = new ArrayList<>(v.size);
        for (JsonValue child = v.child; child != null; child = child.next) {
            list.add(child.isNull() ? null : child.asInt());
        }
        return list;
    }

    private static ArrayList<Float> getFloatList(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull() || !v.isArray()) return null;
        ArrayList<Float> list = new ArrayList<>(v.size);
        for (JsonValue child = v.child; child != null; child = child.next) {
            list.add(child.isNull() ? null : child.asFloat());
        }
        return list;
    }

    private static Object toJavaObject(JsonValue v) {
        if (v == null || v.isNull()) return null;
        if (v.isObject()) return toJavaMap(v);
        if (v.isArray()) {
            ArrayList<Object> list = new ArrayList<>(v.size);
            for (JsonValue c = v.child; c != null; c = c.next) {
                list.add(toJavaObject(c));
            }
            return list;
        }
        if (v.isBoolean()) return v.asBoolean();
        if (v.isLong()) {
            long l = v.asLong();
            if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) {
                return (int) l;
            }
            return l;
        }
        if (v.isDouble()) return v.asDouble();
        return v.asString();
    }

    private static HashMap<Object, Object> toJavaMap(JsonValue obj) {
        HashMap<Object, Object> map = new HashMap<>();
        if (obj == null || !obj.isObject()) return map;
        for (JsonValue c = obj.child; c != null; c = c.next) {
            map.put(c.name, toJavaObject(c));
        }
        return map;
    }

    @SuppressWarnings("rawtypes")
    private static ArrayList<HashMap> getMapList(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull() || !v.isArray()) return null;
        ArrayList<HashMap> list = new ArrayList<>(v.size);
        for (JsonValue c = v.child; c != null; c = c.next) {
            list.add(toJavaMap(c));
        }
        return list;
    }

    private static Map<String, String> parseStringMap(JsonValue root) {
        Map<String, String> map = new HashMap<>();
        for (JsonValue c = root.child; c != null; c = c.next) {
            map.put(c.name, asStr(c));
        }
        return map;
    }

    private static HashMap<String, Integer> getStringIntMap(JsonValue obj, String key) {
        JsonValue v = obj.get(key);
        if (v == null || v.isNull() || !v.isObject()) return null;
        HashMap<String, Integer> map = new HashMap<>();
        for (JsonValue c = v.child; c != null; c = c.next) {
            map.put(c.name, c.asInt());
        }
        return map;
    }

    // -------------------------------------------------------------------------
    // Localization Maps
    // -------------------------------------------------------------------------

    private static Map<String, Object> parseTypedMap(JsonValue root, Class<?> valType) {
        if (valType == String.class) {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) (Map<?, ?>) parseStringMap(root);
            return m;
        }
        Map<String, Object> out = new HashMap<>();
        for (JsonValue entry = root.child; entry != null; entry = entry.next) {
            if (entry.isNull()) continue;
            out.put(entry.name, parseLocEntry(entry, valType));
        }
        return out;
    }

    private static Object parseLocEntry(JsonValue j, Class<?> valType) {
        if (valType == MonsterStrings.class) {
            MonsterStrings s = new MonsterStrings();
            s.NAME = getStr(j, "NAME");
            s.DIALOG = getStrArr(j, "DIALOG");
            s.MOVES = getStrArr(j, "MOVES");
            return s;
        }
        if (valType == PowerStrings.class) {
            PowerStrings s = new PowerStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTIONS = getStrArr(j, "DESCRIPTIONS");
            return s;
        }
        if (valType == CardStrings.class) {
            CardStrings s = new CardStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTION = getStr(j, "DESCRIPTION");
            s.UPGRADE_DESCRIPTION = getStr(j, "UPGRADE_DESCRIPTION");
            s.EXTENDED_DESCRIPTION = getStrArr(j, "EXTENDED_DESCRIPTION");
            return s;
        }
        if (valType == RelicStrings.class) {
            RelicStrings s = new RelicStrings();
            s.NAME = getStr(j, "NAME");
            s.FLAVOR = getStr(j, "FLAVOR");
            s.DESCRIPTIONS = getStrArr(j, "DESCRIPTIONS");
            return s;
        }
        if (valType == EventStrings.class) {
            EventStrings s = new EventStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTIONS = getStrArr(j, "DESCRIPTIONS");
            s.OPTIONS = getStrArr(j, "OPTIONS");
            return s;
        }
        if (valType == PotionStrings.class) {
            PotionStrings s = new PotionStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTIONS = getStrArr(j, "DESCRIPTIONS");
            return s;
        }
        if (valType == CreditStrings.class) {
            CreditStrings s = new CreditStrings();
            s.HEADER = getStr(j, "HEADER");
            s.NAMES = getStrArr(j, "NAMES");
            return s;
        }
        if (valType == TutorialStrings.class) {
            TutorialStrings s = new TutorialStrings();
            s.TEXT = getStrArr(j, "TEXT");
            s.LABEL = getStrArr(j, "LABEL");
            return s;
        }
        if (valType == ScoreBonusStrings.class) {
            ScoreBonusStrings s = new ScoreBonusStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTIONS = getStrArr(j, "DESCRIPTIONS");
            return s;
        }
        if (valType == CharacterStrings.class) {
            CharacterStrings s = new CharacterStrings();
            s.NAMES = getStrArr(j, "NAMES");
            s.TEXT = getStrArr(j, "TEXT");
            s.OPTIONS = getStrArr(j, "OPTIONS");
            s.UNIQUE_REWARDS = getStrArr(j, "UNIQUE_REWARDS");
            return s;
        }
        if (valType == UIStrings.class) {
            UIStrings s = new UIStrings();
            s.TEXT = getStrArr(j, "TEXT");
            s.EXTRA_TEXT = getStrArr(j, "EXTRA_TEXT");
            JsonValue dict = j.get("TEXT_DICT");
            if (dict != null && dict.isObject()) {
                s.TEXT_DICT = parseStringMap(dict);
            }
            return s;
        }
        if (valType == OrbStrings.class) {
            OrbStrings s = new OrbStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTION = getStrArr(j, "DESCRIPTION");
            return s;
        }
        if (valType == StanceStrings.class) {
            StanceStrings s = new StanceStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTION = getStrArr(j, "DESCRIPTION");
            return s;
        }
        if (valType == RunModStrings.class) {
            RunModStrings s = new RunModStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTION = getStr(j, "DESCRIPTION");
            return s;
        }
        if (valType == BlightStrings.class) {
            BlightStrings s = new BlightStrings();
            s.NAME = getStr(j, "NAME");
            s.DESCRIPTION = getStrArr(j, "DESCRIPTION");
            return s;
        }
        if (valType == AchievementStrings.class) {
            AchievementStrings s = new AchievementStrings();
            s.NAMES = getStrArr(j, "NAMES");
            s.TEXT = getStrArr(j, "TEXT");
            return s;
        }
        if (valType == KeywordStrings.class) {
            KeywordStrings s = new KeywordStrings();
            s.TEXT = getStrArr(j, "TEXT");
            s.ARTIFACT = parseKeyword(j.get("ARTIFACT"));
            s.BLOCK = parseKeyword(j.get("BLOCK"));
            s.BURN = parseKeyword(j.get("BURN"));
            s.CALM = parseKeyword(j.get("CALM"));
            s.CHANNEL = parseKeyword(j.get("CHANNEL"));
            s.CONFUSED = parseKeyword(j.get("CONFUSED"));
            s.CURSE = parseKeyword(j.get("CURSE"));
            s.DARK = parseKeyword(j.get("DARK"));
            s.DAZED = parseKeyword(j.get("DAZED"));
            s.DEXTERITY = parseKeyword(j.get("DEXTERITY"));
            s.DIVINITY = parseKeyword(j.get("DIVINITY"));
            s.ETHEREAL = parseKeyword(j.get("ETHEREAL"));
            s.EVOKE = parseKeyword(j.get("EVOKE"));
            s.EXHAUST = parseKeyword(j.get("EXHAUST"));
            s.FOCUS = parseKeyword(j.get("FOCUS"));
            s.FRAIL = parseKeyword(j.get("FRAIL"));
            s.FROST = parseKeyword(j.get("FROST"));
            s.INNATE = parseKeyword(j.get("INNATE"));
            s.INTANGIBLE = parseKeyword(j.get("INTANGIBLE"));
            s.LIGHTNING = parseKeyword(j.get("LIGHTNING"));
            s.LOCK_ON = parseKeyword(j.get("LOCK_ON"));
            s.LOCKED = parseKeyword(j.get("LOCKED"));
            s.OPENER = parseKeyword(j.get("OPENER"));
            s.PLASMA = parseKeyword(j.get("PLASMA"));
            s.POISON = parseKeyword(j.get("POISON"));
            s.PRAYER = parseKeyword(j.get("PRAYER"));
            s.REGEN = parseKeyword(j.get("REGEN"));
            s.RETAIN = parseKeyword(j.get("RETAIN"));
            s.SCRY = parseKeyword(j.get("SCRY"));
            s.SHIV = parseKeyword(j.get("SHIV"));
            s.STANCE = parseKeyword(j.get("STANCE"));
            s.STATUS = parseKeyword(j.get("STATUS"));
            s.STRENGTH = parseKeyword(j.get("STRENGTH"));
            s.STRIKE = parseKeyword(j.get("STRIKE"));
            s.THORNS = parseKeyword(j.get("THORNS"));
            s.TODO = parseKeyword(j.get("TODO"));
            s.TRANSFORM = parseKeyword(j.get("TRANSFORM"));
            s.UNKNOWN = parseKeyword(j.get("UNKNOWN"));
            s.UNPLAYABLE = parseKeyword(j.get("UNPLAYABLE"));
            s.UPGRADE = parseKeyword(j.get("UPGRADE"));
            s.VIGOR = parseKeyword(j.get("VIGOR"));
            s.VOID = parseKeyword(j.get("VOID"));
            s.VULNERABLE = parseKeyword(j.get("VULNERABLE"));
            s.WEAK = parseKeyword(j.get("WEAK"));
            s.WOUND = parseKeyword(j.get("WOUND"));
            s.WRATH = parseKeyword(j.get("WRATH"));
            s.RITUAL = parseKeyword(j.get("RITUAL"));
            s.FATAL = parseKeyword(j.get("FATAL"));
            return s;
        }
        throw new JsonSyntaxException("Unsupported map value type: " + valType.getName());
    }

    private static Keyword parseKeyword(JsonValue j) {
        if (j == null || j.isNull() || !j.isObject()) return null;
        Keyword kw = new Keyword();
        kw.DESCRIPTION = getStr(j, "DESCRIPTION");
        kw.NAMES = getStrArr(j, "NAMES");
        return kw;
    }

    // -------------------------------------------------------------------------
    // SaveFile Mapper
    // -------------------------------------------------------------------------

    private static SaveFile parseSaveFile(JsonValue j) {
        SaveFile s = new SaveFile();
        s.name = getStr(j, "name");
        s.loadout = getStr(j, "loadout");
        s.current_health = getInt(j, "current_health", 0);
        s.max_health = getInt(j, "max_health", 0);
        s.max_orbs = getInt(j, "max_orbs", 0);
        s.gold = getInt(j, "gold", 0);
        s.hand_size = getInt(j, "hand_size", 0);
        s.potion_slots = getInt(j, "potion_slots", 0);
        s.red = getInt(j, "red", 0);
        s.green = getInt(j, "green", 0);
        s.blue = getInt(j, "blue", 0);

        JsonValue cardsVal = j.get("cards");
        if (cardsVal != null && cardsVal.isArray()) {
            s.cards = new ArrayList<>(cardsVal.size);
            for (JsonValue c = cardsVal.child; c != null; c = c.next) {
                s.cards.add(new CardSave(getStr(c, "id"), getInt(c, "upgrades", 0), getInt(c, "misc", 0)));
            }
        }
        s.obtained_cards = getStringIntMap(j, "obtained_cards");
        s.relics = getStrList(j, "relics");
        s.relic_counters = getIntList(j, "relic_counters");
        s.blights = getStrList(j, "blights");
        s.blight_counters = getIntList(j, "blight_counters");
        s.potions = getStrList(j, "potions");
        s.is_ascension_mode = getBool(j, "is_ascension_mode", false);
        s.ascension_level = getInt(j, "ascension_level", 0);
        s.chose_neow_reward = getBool(j, "chose_neow_reward", false);
        s.level_name = getStr(j, "level_name");
        s.play_time = getLong(j, "play_time", 0L);
        s.save_date = getLong(j, "save_date", 0L);
        s.daily_date = getLong(j, "daily_date", 0L);
        s.floor_num = getInt(j, "floor_num", 0);
        s.act_num = getInt(j, "act_num", 0);
        s.seed = getLong(j, "seed", 0L);
        s.special_seed = getLong(j, "special_seed", 0L);
        s.seed_set = getBool(j, "seed_set", false);
        s.is_trial = getBool(j, "is_trial", false);
        s.is_daily = getBool(j, "is_daily", false);
        s.is_final_act_on = getBool(j, "is_final_act_on", false);
        s.has_ruby_key = getBool(j, "has_ruby_key", false);
        s.has_emerald_key = getBool(j, "has_emerald_key", false);
        s.has_sapphire_key = getBool(j, "has_sapphire_key", false);
        s.custom_mods = getStrList(j, "custom_mods");
        s.daily_mods = getStrList(j, "daily_mods");
        s.monster_seed_count = getInt(j, "monster_seed_count", 0);
        s.event_seed_count = getInt(j, "event_seed_count", 0);
        s.merchant_seed_count = getInt(j, "merchant_seed_count", 0);
        s.card_seed_count = getInt(j, "card_seed_count", 0);
        s.treasure_seed_count = getInt(j, "treasure_seed_count", 0);
        s.relic_seed_count = getInt(j, "relic_seed_count", 0);
        s.potion_seed_count = getInt(j, "potion_seed_count", 0);
        s.monster_hp_seed_count = getInt(j, "monster_hp_seed_count", 0);
        s.ai_seed_count = getInt(j, "ai_seed_count", 0);
        s.shuffle_seed_count = getInt(j, "shuffle_seed_count", 0);
        s.card_random_seed_count = getInt(j, "card_random_seed_count", 0);
        s.card_random_seed_randomizer = getInt(j, "card_random_seed_randomizer", 0);
        s.potion_chance = getInt(j, "potion_chance", 0);
        s.purgeCost = getInt(j, "purgeCost", 75);
        s.monster_list = getStrList(j, "monster_list");
        s.elite_monster_list = getStrList(j, "elite_monster_list");
        s.boss_list = getStrList(j, "boss_list");
        s.event_list = getStrList(j, "event_list");
        s.one_time_event_list = getStrList(j, "one_time_event_list");
        s.event_chances = getFloatList(j, "event_chances");
        s.path_x = getIntList(j, "path_x");
        s.path_y = getIntList(j, "path_y");
        s.room_x = getInt(j, "room_x", 0);
        s.room_y = getInt(j, "room_y", 0);
        s.spirit_count = getInt(j, "spirit_count", 0);
        s.boss = getStr(j, "boss");
        s.current_room = getStr(j, "current_room");
        s.common_relics = getStrList(j, "common_relics");
        s.uncommon_relics = getStrList(j, "uncommon_relics");
        s.rare_relics = getStrList(j, "rare_relics");
        s.shop_relics = getStrList(j, "shop_relics");
        s.boss_relics = getStrList(j, "boss_relics");
        s.bottled_flame = getStr(j, "bottled_flame");
        s.bottled_lightning = getStr(j, "bottled_lightning");
        s.bottled_tornado = getStr(j, "bottled_tornado");
        s.bottled_flame_upgrade = getInt(j, "bottled_flame_upgrade", 0);
        s.bottled_lightning_upgrade = getInt(j, "bottled_lightning_upgrade", 0);
        s.bottled_tornado_upgrade = getInt(j, "bottled_tornado_upgrade", 0);
        s.bottled_flame_misc = getInt(j, "bottled_flame_misc", 0);
        s.bottled_lightning_misc = getInt(j, "bottled_lightning_misc", 0);
        s.bottled_tornado_misc = getInt(j, "bottled_tornado_misc", 0);
        s.is_endless_mode = getBool(j, "is_endless_mode", false);
        s.endless_increments = getIntList(j, "endless_increments");
        s.post_combat = getBool(j, "post_combat", false);
        s.mugged = getBool(j, "mugged", false);
        s.smoked = getBool(j, "smoked", false);

        JsonValue crVal = j.get("combat_rewards");
        if (crVal != null && crVal.isArray()) {
            s.combat_rewards = new ArrayList<>(crVal.size);
            for (JsonValue c = crVal.child; c != null; c = c.next) {
                int bonus = getInt(c, "bonusGold", 0);
                RewardSave rs = new RewardSave(getStr(c, "type"), getStr(c, "id"), getInt(c, "amount", 0), bonus);
                rs.bonusGold = bonus;
                s.combat_rewards.add(rs);
            }
        }

        s.monsters_killed = getInt(j, "monsters_killed", 0);
        s.elites1_killed = getInt(j, "elites1_killed", 0);
        s.elites2_killed = getInt(j, "elites2_killed", 0);
        s.elites3_killed = getInt(j, "elites3_killed", 0);
        s.champions = getInt(j, "champions", 0);
        s.perfect = getInt(j, "perfect", 0);
        s.overkill = getBool(j, "overkill", false);
        s.combo = getBool(j, "combo", false);
        s.cheater = getBool(j, "cheater", false);
        s.gold_gained = getInt(j, "gold_gained", 0);
        s.mystery_machine = getInt(j, "mystery_machine", 0);
        s.metric_campfire_rested = getInt(j, "metric_campfire_rested", 0);
        s.metric_campfire_upgraded = getInt(j, "metric_campfire_upgraded", 0);
        s.metric_campfire_rituals = getInt(j, "metric_campfire_rituals", 0);
        s.metric_campfire_meditates = getInt(j, "metric_campfire_meditates", 0);
        s.metric_purchased_purges = getInt(j, "metric_purchased_purges", 0);
        s.metric_potions_floor_spawned = getIntList(j, "metric_potions_floor_spawned");
        s.metric_potions_floor_usage = getIntList(j, "metric_potions_floor_usage");
        s.metric_current_hp_per_floor = getIntList(j, "metric_current_hp_per_floor");
        s.metric_max_hp_per_floor = getIntList(j, "metric_max_hp_per_floor");
        s.metric_gold_per_floor = getIntList(j, "metric_gold_per_floor");
        s.metric_path_per_floor = getStrList(j, "metric_path_per_floor");
        s.metric_path_taken = getStrList(j, "metric_path_taken");
        s.metric_items_purchased = getStrList(j, "metric_items_purchased");
        s.metric_item_purchase_floors = getIntList(j, "metric_item_purchase_floors");
        s.metric_items_purged = getStrList(j, "metric_items_purged");
        s.metric_items_purged_floors = getIntList(j, "metric_items_purged_floors");
        s.metric_card_choices = getMapList(j, "metric_card_choices");
        s.metric_event_choices = getMapList(j, "metric_event_choices");
        s.metric_boss_relics = getMapList(j, "metric_boss_relics");
        s.metric_damage_taken = getMapList(j, "metric_damage_taken");
        s.metric_potions_obtained = getMapList(j, "metric_potions_obtained");
        s.metric_relics_obtained = getMapList(j, "metric_relics_obtained");
        s.metric_campfire_choices = getMapList(j, "metric_campfire_choices");
        s.metric_build_version = getStr(j, "metric_build_version");
        s.metric_seed_played = getStr(j, "metric_seed_played");
        s.metric_floor_reached = getInt(j, "metric_floor_reached", 0);
        s.metric_playtime = getLong(j, "metric_playtime", 0L);
        s.neow_bonus = getStr(j, "neow_bonus");
        s.neow_cost = getStr(j, "neow_cost");
        return s;
    }

    // -------------------------------------------------------------------------
    // RunData Mapper
    // -------------------------------------------------------------------------

    private static RunData parseRunData(JsonValue j) {
        RunData r = new RunData();
        r.character_chosen = getStr(j, "character_chosen");
        r.loadout = getStr(j, "loadout");
        r.build_version = getStr(j, "build_version");
        r.seed_played = getStr(j, "seed_played");
        r.chose_seed = getBool(j, "chose_seed", false);
        r.timestamp = getStr(j, "timestamp");
        r.local_time = getStr(j, "local_time");
        r.victory = getBool(j, "victory", false);
        r.is_daily = getBool(j, "is_daily", false);
        r.is_trial = getBool(j, "is_trial", false);
        r.is_endless = getBool(j, "is_endless", false);
        r.is_ascension_mode = getBool(j, "is_ascension_mode", false);
        r.is_special_run = getBool(j, "is_special_run", false);
        r.special_seed = getBoxedLong(j, "special_seed");
        r.isUploaded = getBool(j, "isUploaded", false);
        r.score = getInt(j, "score", 0);
        r.ascension_level = getInt(j, "ascension_level", 0);
        r.floor_reached = getInt(j, "floor_reached", 0);
        r.gold = getInt(j, "gold", 0);
        r.playtime = getInt(j, "playtime", 0);
        r.purchased_purges = getInt(j, "purchased_purges", 0);
        r.killed_by = getStr(j, "killed_by");
        r.neow_bonus = getStr(j, "neow_bonus");
        r.neow_cost = getStr(j, "neow_cost");
        r.rested = getInt(j, "rested", 0);
        r.rituals = getInt(j, "rituals", 0);
        r.upgraded = getInt(j, "upgraded", 0);
        r.meditates = getInt(j, "meditates", 0);
        r.master_deck = getStrList(j, "master_deck");
        r.relics = getStrList(j, "relics");
        r.circlet_count = getInt(j, "circlet_count", 0);
        r.path_taken = getStrList(j, "path_taken");
        r.path_per_floor = getStrList(j, "path_per_floor");
        r.current_hp_per_floor = getIntList(j, "current_hp_per_floor");
        r.max_hp_per_floor = getIntList(j, "max_hp_per_floor");
        r.items_purchased = getStrList(j, "items_purchased");
        r.item_purchase_floors = getIntList(j, "item_purchase_floors");
        r.items_purged = getStrList(j, "items_purged");
        r.items_purged_floors = getIntList(j, "items_purged_floors");
        r.gold_per_floor = getIntList(j, "gold_per_floor");
        r.daily_mods = getStrList(j, "daily_mods");

        JsonValue dmg = j.get("damage_taken");
        if (dmg != null && dmg.isArray()) {
            r.damage_taken = new ArrayList<>(dmg.size);
            for (JsonValue c = dmg.child; c != null; c = c.next) {
                BattleStats bs = new BattleStats();
                bs.floor = getInt(c, "floor", 0);
                bs.enemies = getStr(c, "enemies");
                bs.damage = getInt(c, "damage", 0);
                bs.turns = getInt(c, "turns", 0);
                r.damage_taken.add(bs);
            }
        }

        JsonValue evt = j.get("event_choices");
        if (evt != null && evt.isArray()) {
            r.event_choices = new ArrayList<>(evt.size);
            for (JsonValue c = evt.child; c != null; c = c.next) {
                EventStats es = new EventStats();
                es.event_name = getStr(c, "event_name");
                es.player_choice = getStr(c, "player_choice");
                es.floor = getInt(c, "floor", 0);
                es.cards_obtained = getStrList(c, "cards_obtained");
                es.cards_removed = getStrList(c, "cards_removed");
                es.cards_transformed = getStrList(c, "cards_transformed");
                es.cards_upgraded = getStrList(c, "cards_upgraded");
                es.relics_obtained = getStrList(c, "relics_obtained");
                es.relics_lost = getStrList(c, "relics_lost");
                es.potions_obtained = getStrList(c, "potions_obtained");
                es.damage_taken = getInt(c, "damage_taken", 0);
                es.damage_healed = getInt(c, "damage_healed", 0);
                es.max_hp_loss = getInt(c, "max_hp_loss", 0);
                es.max_hp_gain = getInt(c, "max_hp_gain", 0);
                es.gold_gain = getInt(c, "gold_gain", 0);
                es.gold_loss = getInt(c, "gold_loss", 0);
                r.event_choices.add(es);
            }
        }

        JsonValue cc = j.get("card_choices");
        if (cc != null && cc.isArray()) {
            r.card_choices = new ArrayList<>(cc.size);
            for (JsonValue c = cc.child; c != null; c = c.next) {
                CardChoiceStats cs = new CardChoiceStats();
                cs.not_picked = getStrList(c, "not_picked");
                cs.picked = getStr(c, "picked");
                cs.floor = getInt(c, "floor", 0);
                r.card_choices.add(cs);
            }
        }

        JsonValue ro = j.get("relics_obtained");
        if (ro != null && ro.isArray()) {
            r.relics_obtained = new ArrayList<>(ro.size);
            for (JsonValue c = ro.child; c != null; c = c.next) {
                ObtainStats os = new ObtainStats();
                os.key = getStr(c, "key");
                os.floor = getInt(c, "floor", 0);
                r.relics_obtained.add(os);
            }
        }

        JsonValue po = j.get("potions_obtained");
        if (po != null && po.isArray()) {
            r.potions_obtained = new ArrayList<>(po.size);
            for (JsonValue c = po.child; c != null; c = c.next) {
                ObtainStats os = new ObtainStats();
                os.key = getStr(c, "key");
                os.floor = getInt(c, "floor", 0);
                r.potions_obtained.add(os);
            }
        }

        JsonValue br = j.get("boss_relics");
        if (br != null && br.isArray()) {
            r.boss_relics = new ArrayList<>(br.size);
            for (JsonValue c = br.child; c != null; c = c.next) {
                BossRelicChoiceStats b = new BossRelicChoiceStats();
                b.not_picked = getStrList(c, "not_picked");
                b.picked = getStr(c, "picked");
                r.boss_relics.add(b);
            }
        }

        JsonValue cf = j.get("campfire_choices");
        if (cf != null && cf.isArray()) {
            r.campfire_choices = new ArrayList<>(cf.size);
            for (JsonValue c = cf.child; c != null; c = c.next) {
                CampfireChoice ch = new CampfireChoice();
                ch.floor = getInt(c, "floor", 0);
                ch.key = getStr(c, "key");
                ch.data = getStr(c, "data");
                r.campfire_choices.add(ch);
            }
        }

        return r;
    }
}
