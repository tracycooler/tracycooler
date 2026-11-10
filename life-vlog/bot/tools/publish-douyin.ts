import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const DIRECT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.mp4$/;

const inputSchema = z.object({
  draftId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  title: z.string().min(1).max(1000),
  approved: z.boolean(),
  videoId: z.string().min(1).max(400).optional(),
  fileName: z.string().regex(FILE_NAME).optional(),
  privateStatus: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
});

type PublishResult = {
  published: boolean;
  reason?: string;
  duplicate?: boolean;
  itemId?: string;
  videoId?: string;
  privateStatus?: number;
  detail?: string;
};

type StoredPublish = {
  itemId: string;
  videoId: string;
};

function publishKey(draftId: string): string {
  return `douyin-publish:${draftId}`;
}

function isStoredPublish(value: unknown): value is StoredPublish {
  if (!value || typeof value !== "object") return false;
  const record = value as { itemId?: unknown; videoId?: unknown };
  return typeof record.itemId === "string" && typeof record.videoId === "string";
}

function insideWorkspace(root: string, fileName: string): string | undefined {
  const base = path.resolve(root);
  const abs = path.resolve(base, fileName);
  const rel = path.relative(base, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return abs;
}

function douyinError(body: unknown): { code?: number; description?: string } {
  if (!body || typeof body !== "object") return {};
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return {};
  const record = data as { error_code?: unknown; description?: unknown };
  return {
    code: typeof record.error_code === "number" ? record.error_code : undefined,
    description: typeof record.description === "string" ? record.description.slice(0, 180) : undefined,
  };
}

async function uploadVideo(openId: string, token: string, bytes: Buffer, fileName: string): Promise<{ ok: true; videoId: string } | { ok: false; reason: string; detail?: string }> {
  const url = new URL("https://open.douyin.com/api/douyin/v1/video/upload_video/");
  url.searchParams.set("open_id", openId);
  const form = new FormData();
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  form.append("video", new Blob([payload], { type: "video/mp4" }), fileName);
  const response = await fetch(url, {
    method: "POST",
    headers: { "access-token": token },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const videoId = body && typeof body === "object"
    ? (body as { data?: { video?: { video_id?: unknown } } }).data?.video?.video_id
    : undefined;
  if (response.ok && typeof videoId === "string" && videoId.length > 0) {
    return { ok: true, videoId };
  }
  const error = douyinError(body);
  return { ok: false, reason: "upload_failed", detail: error.description ?? `http_${response.status}` };
}

async function createVideo(input: { openId: string; token: string; videoId: string; title: string; privateStatus: 0 | 1 | 2 }): Promise<{ ok: true; itemId: string } | { ok: false; reason: string; detail?: string }> {
  const url = new URL("https://open.douyin.com/api/douyin/v1/video/create_video/");
  url.searchParams.set("open_id", input.openId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "access-token": input.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: input.title,
      video_id: input.videoId,
      private_status: input.privateStatus,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const itemId = body && typeof body === "object"
    ? (body as { data?: { item_id?: unknown } }).data?.item_id
    : undefined;
  if (response.ok && typeof itemId === "string" && itemId.length > 0) {
    return { ok: true, itemId };
  }
  const error = douyinError(body);
  return { ok: false, reason: "create_failed", detail: error.description ?? `http_${response.status}` };
}

export default defineTool({
  description:
    "Publish one approved draft to Douyin with the official video.create.bind API. The same draftId publishes once. Refuses unapproved drafts, eval sessions, and missing credentials.",
  effect: "idempotent",
  inputSchema,
  async execute(input, ctx): Promise<PublishResult> {
    if (!input.approved) {
      return { published: false, reason: "needs_approval" };
    }
    if (ctx.session.purpose === "eval") {
      return { published: false, reason: "eval_session", privateStatus: input.privateStatus };
    }
    const existing = await ctx.host.kv.get(publishKey(input.draftId));
    if (isStoredPublish(existing)) {
      return {
        published: true,
        duplicate: true,
        itemId: existing.itemId,
        videoId: existing.videoId,
        privateStatus: input.privateStatus,
      };
    }
    const token = process.env.DOUYIN_ACCESS_TOKEN;
    const openId = process.env.DOUYIN_OPEN_ID;
    if (!token || !openId) {
      return { published: false, reason: "missing_credentials", privateStatus: input.privateStatus };
    }

    let videoId = input.videoId;
    if (!videoId) {
      if (!input.fileName) return { published: false, reason: "needs_video" };
      const abs = insideWorkspace(ctx.workspaceDir, input.fileName);
      if (!abs) return { published: false, reason: "bad_path" };
      const info = await stat(abs).catch(() => undefined);
      if (!info?.isFile()) return { published: false, reason: "file_missing" };
      if (info.size > DIRECT_UPLOAD_MAX_BYTES) return { published: false, reason: "needs_multipart" };
      const bytes = await readFile(abs);
      const uploaded = await uploadVideo(openId, token, bytes, path.basename(abs));
      if (!uploaded.ok) return { published: false, reason: uploaded.reason, detail: uploaded.detail };
      videoId = uploaded.videoId;
    }

    const created = await createVideo({
      openId,
      token,
      videoId,
      title: input.title,
      privateStatus: input.privateStatus,
    });
    if (!created.ok) {
      return { published: false, reason: created.reason, detail: created.detail, videoId };
    }
    await ctx.host.kv.put(publishKey(input.draftId), { itemId: created.itemId, videoId });
    return {
      published: true,
      itemId: created.itemId,
      videoId,
      privateStatus: input.privateStatus,
    };
  },
});
