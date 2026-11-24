package org.apache.logging.log4j;

public class Logger {
    private final String name;

    public Logger(String name) {
        this.name = name;
    }

    private String format(String msg, Object... params) {
        if (msg == null) return "null";
        if (params == null || params.length == 0) return msg;
        StringBuilder sb = new StringBuilder(msg.length() + 32);
        int argIdx = 0;
        int i = 0;
        while (i < msg.length()) {
            if (i + 1 < msg.length() && msg.charAt(i) == '{' && msg.charAt(i + 1) == '}' && argIdx < params.length) {
                sb.append(params[argIdx++]);
                i += 2;
            } else {
                sb.append(msg.charAt(i));
                i++;
            }
        }
        return sb.toString();
    }

    public void info(String msg) {
        System.out.println("[" + name + "] " + msg);
    }

    public void info(Object msg) {
        System.out.println("[" + name + "] " + msg);
    }

    public void info(String msg, Object... params) {
        System.out.println("[" + name + "] " + format(msg, params));
    }

    public void debug(String msg) {
    }

    public void debug(Object msg) {
    }

    public void debug(String msg, Object... params) {
    }

    public void trace(String msg) {
    }

    public void trace(Object msg) {
    }

    public void trace(String msg, Object... params) {
    }

    public void warn(String msg) {
        System.out.println("[WARN][" + name + "] " + msg);
    }

    public void warn(Object msg) {
        System.out.println("[WARN][" + name + "] " + msg);
    }

    public void warn(String msg, Object... params) {
        System.out.println("[WARN][" + name + "] " + format(msg, params));
    }

    public void warn(String msg, Throwable t) {
        System.out.println("[WARN][" + name + "] " + msg + formatThrowable(t));
    }

    public void error(String msg) {
        System.err.println("[ERR][" + name + "] " + msg);
    }

    public void error(Object msg) {
        System.err.println("[ERR][" + name + "] " + msg);
    }

    public void error(String msg, Object... params) {
        System.err.println("[ERR][" + name + "] " + format(msg, params));
    }

    public void error(String msg, Throwable t) {
        System.err.println("[ERR][" + name + "] " + msg + formatThrowable(t));
        if (t != null) t.printStackTrace();
    }

    private static String formatThrowable(Throwable t) {
        if (t == null) return "";
        StringBuilder sb = new StringBuilder();
        Throwable cur = t;
        int depth = 0;
        while (cur != null && depth < 6) {
            sb.append(depth == 0 ? " -> " : " | caused by: ")
              .append(cur.getClass().getName())
              .append(": ")
              .append(cur.getMessage());
            cur = cur.getCause();
            depth++;
        }
        return sb.toString();
    }

    public void fatal(String msg) {
        error(msg);
    }

    public void fatal(String msg, Throwable t) {
        error(msg, t);
    }

    public void catching(Throwable t) {
        if (t != null) t.printStackTrace();
    }

    public boolean isDebugEnabled() {
        return false;
    }

    public boolean isInfoEnabled() {
        return true;
    }
}
