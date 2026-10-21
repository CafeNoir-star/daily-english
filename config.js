// 运行时配置
// audioBase：音频公开访问前缀
//   - 留空：使用站点同目录的 audio/（本地开发 / 音频随应用一起部署）
//   - jsDelivr：https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/audio/
//   - 对象存储：https://audio.example.com/
// cloudEndpoint：WorkBuddy Cloud 端点
//   - "same-origin"（默认）：走本站 /wb-api 同源代理，真实 key 只在服务端
//   - 完整 URL：直连该端点（一般不需要）
window.APP_CONFIG = {
  audioBase: "https://gcore.jsdelivr.net/gh/CafeNoir-star/daily-english@main/audio/",
  cloudEndpoint: "same-origin"
};
