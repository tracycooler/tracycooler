import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);
const MAX_DURATION_SEC = 15 * 60;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.mp4$/;

const inputSchema = z.object({
  clips: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        durationSec: z.number().positive(),
      }),
    )
    .min(1)
    .max(40),
  sourceFile: z.string().regex(FILE_NAME),
  outputName: z.string().regex(FILE_NAME),
});

type RenderResult = {
  rendered: boolean;
  reason?: string;
  durationSec: number;
  outputName: string;
};

function insideWorkspace(root: string, fileName: string): string | undefined {
  const base = path.resolve(root);
  const abs = path.resolve(base, fileName);
  const rel = path.relative(base, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return abs;
}

async function ffmpegExists(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export default defineTool({
  description:
    "Render an approved clip order to a 1080x1920 mp4 in the session workspace. Refuses a cut longer than 15 minutes.",
  effect: "write",
  inputSchema,
  async execute(input, ctx): Promise<RenderResult> {
    const durationSec = input.clips.reduce((sum, clip) => sum + clip.durationSec, 0);
    if (durationSec > MAX_DURATION_SEC) {
      return { rendered: false, reason: "longer_than_15_minutes", durationSec, outputName: input.outputName };
    }
    const source = insideWorkspace(ctx.workspaceDir, input.sourceFile);
    const outDir = insideWorkspace(ctx.workspaceDir, "out");
    const output = outDir ? path.join(outDir, input.outputName) : undefined;
    if (!source || !output || source === output) {
      return { rendered: false, reason: "bad_path", durationSec, outputName: input.outputName };
    }
    if (!(await ffmpegExists())) {
      return { rendered: false, reason: "ffmpeg_unavailable", durationSec, outputName: input.outputName };
    }
    await mkdir(path.dirname(output), { recursive: true });
    const args = [
      "-y",
      "-i",
      source,
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-t",
      String(MAX_DURATION_SEC),
    ];
    try {
      await execFileAsync("ffmpeg", [...args, "-c:a", "aac", output], { timeout: 120_000 });
    } catch {
      try {
        await execFileAsync("ffmpeg", [...args, "-an", output], { timeout: 120_000 });
      } catch {
        return { rendered: false, reason: "render_failed", durationSec, outputName: input.outputName };
      }
    }
    return { rendered: true, durationSec, outputName: input.outputName };
  },
});
