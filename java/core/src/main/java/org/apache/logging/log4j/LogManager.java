package org.apache.logging.log4j;

public final class LogManager {
    private LogManager() {
    }

    public static Logger getLogger(Class<?> clazz) {
        return new Logger(clazz != null ? clazz.getSimpleName() : "STS");
    }

    public static Logger getLogger(String name) {
        return new Logger(name != null ? name : "STS");
    }

    public static Logger getLogger() {
        return new Logger("STS");
    }

    public static void shutdown() {
    }
}
