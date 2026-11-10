import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  description: "把生活素材整理成一条竖版 vlog 草稿，确认后用抖音开放平台发布。",
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "medium" },
      { id: "fast", value: "false" },
    ],
  },
  hosting: {
    egressDomains: ["open.douyin.com"],
    secretNames: [
      "DOUYIN_CLIENT_KEY",
      "DOUYIN_CLIENT_SECRET",
      "DOUYIN_ACCESS_TOKEN",
      "DOUYIN_OPEN_ID",
      "DOUYIN_REFRESH_TOKEN",
    ],
  },
});
