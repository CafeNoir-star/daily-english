// 运行时配置
// audioBase：音频公开访问前缀
//   - 留空：使用站点同目录的 audio/（本地开发 / 音频随应用一起部署）
//   - jsDelivr：https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/audio/
//   - 对象存储：https://audio.example.com/
// 注意：这里必须用 cdn.jsdelivr.net，不要换回 gcore.jsdelivr.net。
//   jsDelivr 按 URL 缓存 12h，语料被覆盖后同名 mp3 的内容会变但 URL 不变；
//   purge 接口能清掉 Cloudflare 节点（cdn.*）的缓存，却清不掉 gcore 节点，
//   结果是页面显示新句子、播放出来还是旧音频。
// cloudEndpoint：WorkBuddy Cloud 端点
//   - 留空：直连 WorkBuddy（WorkBuddy Sites 部署时用这个）
//   - "same-origin"：走本站 /.cloud 反向代理（Render / 自建服务器时用这个）
window.APP_CONFIG = {
  audioBase: "https://cdn.jsdelivr.net/gh/CafeNoir-star/daily-english@main/audio/",
  cloudEndpoint: ""
};
