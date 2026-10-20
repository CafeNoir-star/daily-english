// 运行时配置
// audioBase：音频公开访问前缀
//   - 留空：使用站点同目录的 audio/（本地开发 / 音频随应用一起部署）
//   - jsDelivr：https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/audio/
//   - 对象存储：https://audio.example.com/
// cloudEndpoint：WorkBuddy Cloud 端点
//   - 留空：直连 WorkBuddy（WorkBuddy Sites 部署时用这个）
//   - "same-origin"：走本站 /.cloud 反向代理（Render / 自建服务器时用这个）
window.APP_CONFIG = {
  audioBase: "https://gcore.jsdelivr.net/gh/CafeNoir-star/daily-english@main/audio/",
  cloudEndpoint: ""
};
