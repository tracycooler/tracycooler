import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "A clip list becomes a draft, and the agent does not publish it.",
  async test(t) {
    await t.send(
      "这里有两段生活素材。早餐 42 秒，散步 95 秒。请用 intake-clips 检查，然后给我一条中文草稿。不要发布。",
    );
    t.succeeded();
    t.calledTool("intake-clips");
    t.notCalledTool("publish-douyin");
  },
});
