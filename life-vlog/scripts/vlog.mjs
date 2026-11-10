import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inbox = path.join(root, "inbox");
const outFile = path.join(root, "out", "vlog.mp4");
const videoExt = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const maxDurationSec = 15 * 60;
const maxClips = 40;
const vertical = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=25";

const given = process.argv.slice(2).filter((arg) => arg !== "--");
const files = given.length > 0 ? given.map((file) => path.resolve(file)) : await listInbox();

if (files.length === 0) {
  console.log("把视频按顺序放进 inbox，或执行 npm run vlog -- 第一段.mp4 第二段.mp4");
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
  clips.push({ file, name, durationSec });
}

if (clips.length === 0) {
  console.error("没有可用的视频");
  process.exit(1);
}

const total = clips.reduce((sum, clip) => sum + clip.durationSec, 0);
if (total > maxDurationSec) {
  console.error(`加起来 ${Math.round(total)} 秒，超过 15 分钟`);
  process.exit(1);
}

const work = await mkdtemp(path.join(tmpdir(), "life-vlog-"));
try {
  const parts = [];
  for (const [index, clip] of clips.entries()) {
    const part = path.join(work, `part-${String(index + 1).padStart(2, "0")}.mp4`);
    const ok = await normalize(clip.file, part);
    if (!ok) {
      console.error(`处理失败：${clip.name}`);
      process.exit(1);
    }
    parts.push(part);
    console.log(`${index + 1}. ${clip.name}，${Math.max(1, Math.round(clip.durationSec))} 秒`);
  }
  await mkdir(path.dirname(outFile), { recursive: true });
  const list = path.join(work, "list.txt");
  await writeFile(list, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n"));
  const joined = await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", outFile]);
  if (!joined) {
    console.error("拼接失败");
    process.exit(1);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log("");
console.log(`成片：${outFile}`);
console.log("1080x1920，按上面的顺序接在一起。没有配音，也没有发布。");

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

async function normalize(input, output) {
  const withAudio = await ffmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    vertical,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "44100",
    "-ac",
    "2",
    output,
  ]);
  if (withAudio) return true;
  return ffmpeg([
    "-y",
    "-i",
    input,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-filter_complex",
    `[0:v]${vertical}[v]`,
    "-map",
    "[v]",
    "-map",
    "1:a:0",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    output,
  ]);
}

function ffmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
