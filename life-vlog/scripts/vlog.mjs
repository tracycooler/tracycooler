import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inbox = path.join(root, "inbox");
const outFile = path.join(root, "out", "vlog.mp4");
const editFile = path.join(inbox, "剪辑.txt");
const videoExt = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const maxDurationSec = 15 * 60;
const maxClips = 40;
const fadeSec = 0.35;
const vertical = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=25";

const given = process.argv.slice(2).filter((arg) => arg !== "--");
const manual = await readEditList();
const files = manual?.map((item) => item.file) ?? (given.length > 0 ? given.map((file) => path.resolve(file)) : await listInbox());

if (files.length === 0) {
  console.log("把视频按顺序放进 inbox，或执行 npm run vlog -- 第一段.mp4 第二段.mp4");
  console.log("要自己定入点出点，在 inbox/剪辑.txt 写：文件名 开始秒 结束秒");
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
  const marked = manual?.find((item) => item.file === file);
  const ranges = marked ? [[clamp(marked.start, 0, durationSec), clamp(marked.end, 0, durationSec)]] : await autoCuts(file, durationSec);
  const usable = ranges.filter(([start, end]) => end - start >= 0.3);
  if (usable.length === 0) {
    console.error(`跳过 ${name}：剪完没有留下画面`);
    continue;
  }
  clips.push({ file, name, durationSec, ranges: usable });
}

if (clips.length === 0) {
  console.error("没有可用的视频");
  process.exit(1);
}

const kept = clips.reduce((sum, clip) => sum + clip.ranges.reduce((part, [start, end]) => part + (end - start), 0), 0);
if (kept > maxDurationSec) {
  console.error(`剪完还有 ${Math.round(kept)} 秒，超过 15 分钟`);
  process.exit(1);
}

const work = await mkdtemp(path.join(tmpdir(), "life-vlog-"));
try {
  const pieces = [];
  for (const [index, clip] of clips.entries()) {
    const rendered = [];
    for (const [rangeIndex, [start, end]] of clip.ranges.entries()) {
      const piece = path.join(work, `c${index}-r${rangeIndex}.mp4`);
      if (!(await renderRange(clip.file, piece, start, end))) {
        console.error(`处理失败：${clip.name}`);
        process.exit(1);
      }
      rendered.push(piece);
    }
    const combined = rendered.length === 1 ? rendered[0] : path.join(work, `clip-${index}.mp4`);
    if (rendered.length > 1 && !(await concatCopy(rendered, combined))) {
      console.error(`跳切失败：${clip.name}`);
      process.exit(1);
    }
    const duration = await probe(combined);
    pieces.push({ file: combined, duration });
    const keptSec = clip.ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
    const cuts = clip.ranges.map(([start, end]) => `${start.toFixed(1)}-${end.toFixed(1)}`).join("，");
    console.log(`${index + 1}. ${clip.name}，原长 ${clip.durationSec.toFixed(1)} 秒，留下 ${keptSec.toFixed(1)} 秒（${cuts}）`);
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  const joined = pieces.length === 1
    ? await ffmpeg(["-y", "-i", pieces[0].file, "-c", "copy", "-movflags", "+faststart", outFile])
    : await crossfade(pieces, outFile);
  if (!joined) {
    console.error("成片失败");
    process.exit(1);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log("");
console.log(`成片：${outFile}`);
console.log("1080x1920。每段先剪掉静音，段和段之间有 0.35 秒淡化。没有生成新画面，也没有发布。");

async function readEditList() {
  try {
    await access(editFile);
  } catch {
    return undefined;
  }
  const lines = (await readFile(editFile, "utf8")).split("\n");
  const items = [];
  for (const line of lines) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    const match = text.match(/^(\S+)\s+([0-9.]+)\s+([0-9.]+)$/);
    if (!match) {
      console.error(`剪辑.txt 这一行无法识别：${text}`);
      continue;
    }
    const file = path.resolve(inbox, match[1]);
    items.push({ file, start: Number(match[2]), end: Number(match[3]) });
  }
  return items;
}

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

async function autoCuts(file, duration) {
  if (!(await hasAudio(file))) {
    return duration <= 12 ? [[0, duration]] : [[(duration - 8) / 2, (duration + 8) / 2]];
  }
  const log = await silenceLog(file);
  const ranges = padRanges(activityRanges(duration, log), duration);
  if (ranges.length === 0) {
    const length = Math.min(2, duration);
    const start = Math.max(0, (duration - length) / 2);
    return [[start, start + length]];
  }
  return ranges;
}

function activityRanges(duration, log) {
  let cursor = 0;
  let silent = false;
  const ranges = [];
  for (const line of log.split("\n")) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (start) {
      const at = Number(start[1]);
      if (!silent && at - cursor >= 0.2) ranges.push([cursor, at]);
      silent = true;
    } else if (end) {
      cursor = Number(end[1]);
      silent = false;
    }
  }
  if (!silent && duration - cursor >= 0.2) ranges.push([cursor, duration]);
  return ranges;
}

function padRanges(ranges, duration) {
  const padded = ranges.map(([start, end]) => [Math.max(0, start - 0.12), Math.min(duration, end + 0.12)]);
  padded.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of padded) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 0.05) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged.filter(([start, end]) => end - start >= 0.3);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function renderRange(input, output, start, end) {
  const withAudio = await ffmpeg([
    "-y", "-i", input, "-ss", String(start), "-to", String(end),
    "-vf", vertical, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "44100", "-ac", "2", output,
  ]);
  if (withAudio) return true;
  return ffmpeg([
    "-y", "-i", input, "-ss", String(start), "-to", String(end),
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-filter_complex", `[0:v]${vertical}[v]`,
    "-map", "[v]", "-map", "1:a:0", "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", output,
  ]);
}

async function concatCopy(files, output) {
  const list = `${output}.txt`;
  await writeFile(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  return ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output]);
}

async function crossfade(pieces, output) {
  const fade = Math.min(fadeSec, ...pieces.map((piece) => piece.duration / 2));
  if (!(fade > 0.05)) return concatCopy(pieces.map((piece) => piece.file), output);
  const video = [];
  const audio = [];
  let previous = "[0:v]";
  let previousAudio = "[0:a]";
  let offset = pieces[0].duration - fade;
  for (let index = 1; index < pieces.length; index += 1) {
    const last = index === pieces.length - 1;
    const videoOut = last ? "[v]" : `[v${index}]`;
    const audioOut = last ? "[a]" : `[a${index}]`;
    video.push(`${previous}[${index}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}${videoOut}`);
    audio.push(`${previousAudio}[${index}:a]acrossfade=d=${fade.toFixed(3)}${audioOut}`);
    previous = videoOut;
    previousAudio = audioOut;
    offset += pieces[index].duration - fade;
  }
  return ffmpeg([
    "-y",
    ...pieces.flatMap((piece) => ["-i", piece.file]),
    "-filter_complex", [...video, ...audio].join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", output,
  ]);
}

function probe(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      const value = Number(out.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : undefined);
    });
  });
}

function hasAudio(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

function silenceLog(file) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-i", file, "-af", "silencedetect=noise=-35dB:d=0.35", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(err));
  });
}

function ffmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
