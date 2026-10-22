/* Publishes the current public tunnel URL to the MQTT pointer topic (retained).
 * The launcher calls this whenever the tunnel (re)connects with a new domain. */
"use strict";
const mini = require("../mqtt_mini.js");
const url = process.argv[2];
if (!url) { console.error("usage: node publish_url.js <url>"); process.exit(1); }
const c = mini.connect("wss://broker-cn.emqx.io:8084/mqtt", {
  clientId: "urlpub-" + Math.random().toString(36).slice(2, 10),
});
c.on("connect", function () {
  c.publish("overscced/v1/url", JSON.stringify({ url: url, ts: Date.now() }), { qos: 1, retain: true });
  console.log("URL published:", url);
  setTimeout(function () { process.exit(0); }, 1500);
});
c.on("error", function () { console.error("publish failed (broker unreachable?)"); process.exit(1); });
