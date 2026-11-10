import { createHash } from "node:crypto";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const MAX_DURATION_SEC = 15 * 60;

const inputSchema = z.object({
  clips: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        durationSec: z.number().positive().max(24 * 60 * 60),
        bytes: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(40),
});

type ClipDecision = {
  id: string;
  name: string;
  durationSec: number;
  bytes?: number;
  accepted: boolean;
  reason?: string;
};

export default defineTool({
  description:
    "Check a life-vlog clip list. Marks any clip longer than 15 minutes as rejected and returns a stable id for each clip.",
  effect: "read",
  inputSchema,
  execute({ clips }) {
    const decisions: ClipDecision[] = clips.map((clip) => {
      const id = createHash("sha256")
        .update(`${clip.name}|${clip.durationSec}|${clip.bytes ?? 0}`)
        .digest("hex")
        .slice(0, 16);
      const tooLong = clip.durationSec > MAX_DURATION_SEC;
      return {
        id,
        name: clip.name,
        durationSec: clip.durationSec,
        ...(clip.bytes === undefined ? {} : { bytes: clip.bytes }),
        accepted: !tooLong,
        ...(tooLong ? { reason: "longer_than_15_minutes" } : {}),
      };
    });
    const accepted = decisions.filter((clip) => clip.accepted);
    return {
      accepted,
      rejected: decisions.filter((clip) => !clip.accepted),
      acceptedCount: accepted.length,
      totalDurationSec: accepted.reduce((sum, clip) => sum + clip.durationSec, 0),
    };
  },
});
