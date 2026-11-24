package com.google.gson.reflect;

import java.lang.reflect.Type;

public class TypeToken<T> {
    protected TypeToken() {
    }

    public Type getType() {
        return Object.class;
    }

    public static Type mapOf(Class<?> valueType) {
        return new MapType(valueType);
    }

    public static final class MapType implements Type {
        public final Class<?> valueType;

        public MapType(Class<?> valueType) {
            this.valueType = valueType;
        }
    }
}
