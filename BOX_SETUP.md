# MyLoon Box 安装说明

本包已经包含：

- `box/`：MyLoon Box 静态网页
- `manifest.json`：插件索引
- `.github/workflows/update-manifest.yml`：插件变更后自动更新 manifest
- `.github/workflows/deploy-pages.yml`：自动部署 GitHub Pages

上传到 `OliviaR13/MyLoon` 的 `main` 分支后：

1. GitHub → Settings → Pages
2. Build and deployment → Source 选择 **GitHub Actions**
3. 等待 `Deploy MyLoon Box` 工作流完成
4. 访问 `https://oliviar13.github.io/MyLoon/box/`

以后只要新增或修改 `plugin/*.plugin`，`Update MyLoon manifest` 会自动重新生成 `manifest.json`。

注意：首次启用 Pages 时可能需要手动保存一次设置；仓库必须允许 GitHub Actions 写入 contents，才能让 manifest 自动提交更新。
