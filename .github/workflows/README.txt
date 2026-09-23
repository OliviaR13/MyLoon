GitHub 手机端上传时如果看不到 .github 文件夹，请不要重复上传整个 ZIP。
先上传仓库普通文件，然后在 GitHub 网页创建 .github/workflows 文件夹，
分别把本目录的 deploy-pages.yml 和 update-manifest.yml 上传进去。
如果 Pages 页面选择 GitHub Actions，也可以直接使用 GitHub 提供的 Static HTML 模板，
但本包自带的 deploy-pages.yml 已经针对 MyLoon Box 配置好，优先使用它。
