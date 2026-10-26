# 商品视觉素材链接采集

运行 `tbcli item media --item-id ID --out NEW.json --json`。输出路径必须未使用，权限为当前用户私有。

返回商品 `detail`（名称、店铺、主图、SKU 属性图片及 SKU 映射）、`description.images`（页面原序详情图）、`mainVideos.records`（主图视频真实播放源与可得的封面）、`coverage` 和来源时间。

`mainVideos.status: absent` 表示页面明确返回空视频列表。unavailable 表示无法识别列表；partial 表示部分记录尚未能解析。调用者应报告覆盖缺口，不能将封面图作为视频。原始图片顺序保留，去重和布局由应用决定。此命令不打开评价和问答。

沿用 tbcli 已登录会话、共享请求间隔及前后验证。遇登录、验证码或访问限制立即停止，输出已采集结果；人工处理后使用新输出路径继续。运行前检查认证，完成后核对商品身份和四类 coverage。
