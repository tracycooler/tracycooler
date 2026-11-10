# 生活 vlog 自动化流水线

每天把生活素材收成一条竖版草稿。人确认之后，再用抖音开放平台发布。模型用普通 Grok 4.7，推理 `medium`，Fast 关闭。

## 流水线

1. 收片：`intake-clips` 检查素材。单条超过 15 分钟就拒绝。
2. 选片和文案：模型排镜头顺序，写 60 到 120 字口播、标题和 2 到 4 个话题。
3. 成片：`npm run vlog` 先剪掉每段里的静音，再把留下的画面裁成 1080x1920，段与段之间做 0.35 秒淡化。要指定入点出点，在 `inbox/剪辑.txt` 写「文件名 开始秒 结束秒」。画面用本机 ffmpeg 处理。
4. 确认：人在当次对话里明确同意后，才允许发布。
5. 发布：`publish-douyin` 调用官方接口。同一个 `draftId` 只发布一次。

每天 20:00（上海时间）的定时任务只生成草稿，不调用发布。

## 用法

把视频放进 `inbox`，在 `life-vlog` 目录执行 `npm run draft` 得到文案。执行 `npm run vlog` 剪辑并输出 `out/vlog.mp4`。传入路径时按参数顺序：`npm run vlog -- ~/早餐.mp4 ~/散步.mp4`。只放进 inbox 时按文件名排序。

## 模型

`bot/agent.ts` 使用：

- 模型 id：`grok-4.7`
- `reasoning_effort`：`medium`
- `fast`：`false`

短中文文案用不到 Fast。Cursor 价目表里，这个档位是每 100 万 token 输入 $2、缓存读取 $0.50、输出 $6。输入超过 25.6 万 token 后按 2 倍计。按一天三次短对话估算，大约 $0.16 一条。

## 抖音

只走开放平台，权限 `video.create.bind`（代替用户发布内容到抖音）。需要用户自己的应用和 OAuth，不能代发任意账号。

- 直传：`https://open.douyin.com/api/douyin/v1/video/upload_video/`
- 创建：`https://open.douyin.com/api/douyin/v1/video/create_video/`
- 单条不超过 15 分钟。50MB 以上需要分片，当前版本遇到更大的文件会返回 `needs_multipart`，不直接上传。
- 默认 `privateStatus` 为 1，仅自己可见。只有人明确要求公开才传 0。
- 创建后由抖音审核，通过前通常只有自己可见。

密钥只放部署环境，不进仓库：`DOUYIN_CLIENT_KEY`、`DOUYIN_CLIENT_SECRET`、`DOUYIN_ACCESS_TOKEN`、`DOUYIN_OPEN_ID`、`DOUYIN_REFRESH_TOKEN`。

## 文件

```text
life-vlog/
  PLAN.md
  bot/agent.ts
  bot/instructions.md
  bot/skills/life-vlog.md
  bot/tools/intake-clips.ts
  bot/tools/render-cut.ts
  bot/tools/publish-douyin.ts
  bot/schedules/daily-draft.md
  evals/smoke.eval.ts
```
