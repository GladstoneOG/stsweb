// Default relay URL override: normalizes localhost -> 127.0.0.1 so Chrome/Edge never hit an orphaned IPv6 ::1 listener
(function () {
  var params = new URLSearchParams(window.location.search || "");
  var override = params.get("relay");
  if (override) {
    window.STS_DEFAULT_RELAY = override.replace(/\/+$/, "");
  } else if (window.location.hostname === "localhost" && window.location.port) {
    window.STS_DEFAULT_RELAY = window.location.protocol + "//127.0.0.1:" + window.location.port;
  } else {
    window.STS_DEFAULT_RELAY = window.location.origin;
  }
})();
