import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inbox = path.join(root, "inbox");
const seedDir = path.join(root, "bot/sandbox/workspace");
const videoExt = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const maxDurationSec = 15 * 60;
const maxClips = 40;

const given = process.argv.slice(2).filter((arg) => arg !== "--");
const files = given.length > 0 ? given.map((file) => path.resolve(file)) : await listInbox();

if (files.length === 0) {
  console.log("把视频放进 life-vlog/inbox，然后在这个目录执行 npm run draft");
  process.exit(0);
}

const clips = [];
for (const file of files.slice(0, maxClips)) {
  const name = path.basename(file);
  if (!videoExt.has(path.extname(name).toLowerCase())) {
    console.error(`跳过 ${name}：只收 mp4、mov、m4v、webm`);
    continue;
  }
  const durationSec = await probe(file);
  if (durationSec === undefined) {
    console.error(`跳过 ${name}：读不到时长`);
    continue;
  }
  const rounded = Math.max(1, Math.round(durationSec));
  if (rounded > maxDurationSec) {
    console.error(`跳过 ${name}：${rounded} 秒，超过 15 分钟`);
    continue;
  }
  clips.push({ file, name, durationSec: rounded });
}

if (clips.length === 0) {
  console.error("没有可用的视频");
  process.exit(1);
}

await mkdir(seedDir, { recursive: true });
const lines = [];
for (const [index, clip] of clips.entries()) {
  const safe = `clip-${String(index + 1).padStart(2, "0")}.mp4`;
  if (path.extname(clip.name).toLowerCase() === ".mp4") {
    await copyFile(clip.file, path.join(seedDir, safe));
    clip.safe = safe;
  }
  lines.push(`${index + 1}. ${clip.name}，${clip.durationSec} 秒${clip.safe ? `，文件 ${clip.safe}` : ""}`);
}

const message = [
  "下面这些素材已经量过时长。请生成一条中文草稿：镜头顺序、60 到 120 字口播、标题和封面时间点。",
  "不要发布，也不要做成片。",
  ...lines,
].join("\n");

console.log(lines.join("\n"));
console.log("");

const result = await runAgent(message);
const text = result?.trajectory?.finalText ?? "";
if (!result?.ok || text.length === 0) {
  const reason = result?.trajectory?.turns?.find((turn) => turn.error)?.error ?? "草稿没有生成";
  console.error(reason);
  process.exit(1);
}
console.log(text);

async function listInbox() {
  try {
    await access(inbox);
  } catch {
    return [];
  }
  const names = await readdir(inbox);
  return names
    .filter((name) => videoExt.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(inbox, name));
}

function probe(file) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      const value = Number(out.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : undefined);
    });
  });
}

function runAgent(prompt) {
  const bin = path.join(root, "node_modules/.bin/agent-sdk");
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ["run", "--dir", root, "--message", prompt, "--json", "--no-stream", "--timeout-ms", "180000"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const marker = out.lastIndexOf("\n{");
      const slice = marker >= 0 ? out.slice(marker + 1) : out;
      try {
        resolve(JSON.parse(slice));
      } catch {
        reject(new Error(code === 0 ? "没有返回草稿" : `agent-sdk 退出码 ${code}`));
      }
    });
  });
}
