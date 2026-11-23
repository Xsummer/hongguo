#!/usr/bin/env node
// 红果取流车道诊断：把「版本档位 × 端点车道 × 签名方案」的真值表打出来。
// 用法: node dev/lane-probe.cjs [videoId] [--all]
// 不传 videoId 时用内置样例；--all 会把 V5 组合也打一遍（慢一倍）。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const wantAll = args.includes("--all");
const videoId = args.find((arg) => /^[0-9]{6,}$/.test(arg)) || "7698309376561400856";

function curl(request) {
  const argv = ["-sS", "-m", "25", "-X", request.method || "GET"];
  for (const [key, value] of Object.entries(request.headers || {})) argv.push("-H", key + ": " + value);
  if (request.body) argv.push("--data-binary", request.body);
  argv.push("-w", "\n__STATUS__%{http_code}", request.url);
  const out = spawnSync("curl", argv, { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  const text = out.stdout || "";
  const at = text.lastIndexOf("\n__STATUS__");
  return { status: Number(text.slice(at + 11).trim()), body: text.slice(0, at) };
}

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const cache = new Map();
const host = {
  source: "hongguo",
  utf8Encode: (text) => Uint8Array.from(Buffer.from(text)),
  utf8Decode: (value) => Buffer.from(value).toString("utf8"),
  hexEncode: (value) => Buffer.from(value).toString("hex"),
  hexDecode: (value) => Uint8Array.from(Buffer.from(value, "hex")),
  base64Encode: (value) => Buffer.from(value).toString("base64"),
  base64Decode: (value) => Uint8Array.from(Buffer.from(value, "base64")),
  md5: (value) => Uint8Array.from(crypto.createHash("md5").update(Buffer.from(value)).digest()),
  sha512: (value) => Uint8Array.from(crypto.createHash("sha512").update(Buffer.from(value)).digest()),
  sha256: (value) => Uint8Array.from(crypto.createHash("sha256").update(Buffer.from(value)).digest()),
  randomBytes: (size) => Uint8Array.from(crypto.randomBytes(size)),
  aesCbcEncrypt: (key, iv, value) => {
    const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
    cipher.setAutoPadding(false);
    return Uint8Array.from(Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]));
  },
  aesCbcDecrypt: (key, iv, value) => {
    const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
    decipher.setAutoPadding(false);
    return Uint8Array.from(Buffer.concat([decipher.update(Buffer.from(value)), decipher.final()]));
  },
  parseUrl: (value) => {
    const url = new URL(value);
    return { scheme: url.protocol.slice(0, -1), hostname: url.hostname, userInfo: !!(url.username || url.password) };
  },
  preserveIntegers: (text) => text,
  cacheGet: (key) => (cache.has(key) ? cache.get(key) : null),
  cacheSet: (key, value) => cache.set(key, value),
  dramaId: (sourceId) => "hongguo:" + sourceId,
  chapterId: (dramaId, id) => dramaId + ":" + id,
  exclusive: (fn) => fn(),
  retries: () => 1,
  reserve: () => 1,
  sleep: () => {},
  isKnown: () => true,
  maxPages: () => 50,
  finishMedia: (media) => media,
  reportProgress: () => {},
  fetch: (request) => curl(request),
  fetchText: (options) => ({ body: curl({ url: options.url, method: "GET" }).body }),
};

const context = vm.createContext({ host, module: { exports: {} }, console, Buffer, URL });
vm.runInContext(source + "\nmodule.exports.test = { appRequest, appMedia, paths, playbackProfiles, playbackSigners, playbackLaneList, ensureDevice, currentState, deviceOf, orderedProfiles, laneKey, laneState, playbackQuery, signPlayer, signPlaybackHeaders };", context);
const T = context.module.exports.test;

T.ensureDevice(false, "");
const [deviceId, installId] = T.deviceOf(T.currentState(), false);
console.log("设备: device_id=" + deviceId + " iid=" + installId);
console.log("版本档位顺序: " + T.orderedProfiles().map((item) => item.name).join(" > "));
console.log("车道顺序: " + T.playbackLaneList().map((item) => item.name).join(" > "));
console.log("");

const body = JSON.stringify({
  biz_param: {
    detail_page_version: 0, device_level: 1, disable_digg_stat: false, disable_video_relate_book: false,
    need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024,
  },
  mixed_video_id_map: { "1004": [videoId] }, dr_scene: "player",
});

const signers = wantAll ? T.playbackSigners : ["gorgon"];
const rows = [];
for (const profile of T.playbackProfiles) {
  for (const lane of T.playbackLaneList()) {
    for (const signer of signers) {
      let verdict;
      try {
        const result = T.appRequest("POST", T.paths.videoModel, null, body, { playbackLane: lane, signer, profile });
        const entries = result && result.data ? (result.data["1004"] || result.data) : {};
        const hasEpisode = !!(entries && entries[videoId]);
        verdict = "OK code=" + (result && result.code) + " 有该集=" + (hasEpisode ? "是" : "否");
      } catch (error) {
        verdict = error.emptyBody ? "空响应(0 字节)" : "错误: " + error.message;
      }
      rows.push([profile.name, lane.name, signer, verdict]);
    }
  }
}
const width = [12, 13, 12];
for (const row of rows) {
  console.log(row[0].padEnd(width[0]) + row[1].padEnd(width[1]) + row[2].padEnd(width[2]) + row[3]);
}

console.log("");
const started = Date.now();
try {
  const media = T.appMedia(videoId);
  console.log("appMedia 成功: " + (Date.now() - started) + "ms  " + media.quality + "p  " + media.url.slice(0, 72));
  console.log("变体数=" + media.variants.length + " 加密=" + (media.cencKey ? "是" : "否") + " 时长=" + media.durationMs + "ms");
} catch (error) {
  console.log("appMedia 失败: " + error.message);
  process.exitCode = 1;
}
