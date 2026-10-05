<div align="center">

<img src="icon/myloon.png" alt="MyLoon Logo" width="120" height="120">

# MyLoon

**个人编写的 [Loon](https://www.nsloon.com/) 插件合集，附带可一键安装的网页插件盒子。**

[![License](https://img.shields.io/badge/License-All_Rights_Reserved-8a8a85?style=flat-square)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/OliviaR13/MyLoon?style=flat-square&logo=github)](https://github.com/OliviaR13/MyLoon/commits/main)

### 👉 [打开 Loon Box 插件盒子](https://olivia-loon-box.pages.dev/) 👈

**浏览全部插件 · 一键安装到 Loon**

</div>

> 本仓库的插件、脚本和网页主要借助 Claude、ChatGPT 等 AI 辅助编写。使用前请自行阅读规则内容。

## 📦 安装插件

**方式一：插件盒子（推荐）**

打开 **[Loon Box](https://olivia-loon-box.pages.dev/)**，浏览或搜索插件，点击「安装」即可通过 `loon://import?plugin=...` 唤起 Loon 完成安装。首次加载需完成人机验证；登录 GitHub 账号可同步收藏。插件持续更新，盒子里的列表永远是最新的。

**方式二：手动添加**

1. 在 [`plugin/`](plugin/) 中找到目标文件，复制 raw 链接：
   `https://raw.githubusercontent.com/OliviaR13/MyLoon/main/plugin/<文件名>.plugin`
2. Loon → 插件 → 右上角 `+` → 粘贴链接 → 添加

## 🧭 插件如何工作

插件通过 `[Rule]` 为指定域名选择走代理还是直连，部分插件还带有脚本：

```text
App 发出请求
 ├─ 命中插件规则 PROXY  → 走你在插件中选择的节点
 ├─ 命中插件规则 DIRECT → 直连
 └─ 未命中插件规则      → 继续匹配主配置规则
```

规则按顺序匹配，先命中的规则生效，所以插件需要排在 `GEOIP,CN,DIRECT` 等国内直连规则之前。

**「IP 属地」类插件的原理**：只把承载 IP 属地 / 风控判定信号的接口（如带经纬度参数的推荐接口、设备指纹注册接口、打点上报接口）送入代理，Feed、图片、视频等媒体 CDN 全部直连，因此不占用代理流量、不影响加载速度。

## 🗂️ 插件分类

插件头部的 `#!tag` 决定其在盒子中的分类，盒子取第一个标签。

| 分类 | 内容 |
|---|---|
| 🔀 代理分流 | 指定 App 或服务的相关域名统一走 `PROXY` |
| 📍 IP 属地 | 仅指定接口走代理，Feed、图片、视频等媒体 CDN 直连 |
| 🔑 登录修复 | 认证域名直连并跳过 MITM |

`#!tag` 可写多个标签，以英文逗号分隔，例如 `#!tag = IP 属地,功能增强`。

## 🎛️ 使用说明

- **选择节点**：名称带「自选节点」的插件，需在插件详情页的「代理指向的策略」中选择策略组或节点。未选择时，使用全局策略的第一个节点。
- **节点类型**：建议选择固定的单一节点（`select` 类型策略组）。使用 `url-test` 等自动测速类型时，节点切换可能中断已建立的连接。
- **规则顺序**：插件需排在主配置中 `GEOIP,CN,DIRECT` 等国内直连规则之前。
- **MITM**：带脚本的插件（如微博增强）需要在 Loon 中安装并信任 MITM 证书，并开启 MITM。
- **微博机型**：切换机型后，请到微博「微博来源」中重新选择一次。
- **插件叠加**：若同时启用了对相同域名做 MITM 解密或响应体改写的其他插件（如去广告类），各插件独立生效，出现异常时需分别排查。

## ❓ 常见问题

**为什么叫「自选节点」？**
插件里只写了哪些域名走代理，具体走哪个节点由你在插件详情页自己选。

**插件装了但好像没生效？**
先检查插件是否排在 `GEOIP,CN,DIRECT` 等国内直连规则之前；带脚本的插件还需检查 MITM 是否已开启。

**连接偶尔失败是插件的问题吗？**
插件只决定走代理还是直连。连接被取消、重置或超时的原因可能在 App、节点、CDN 或链路等环节，插件规则无法判断或修复。

## 🗃️ 目录结构

| 路径 | 内容 |
|---|---|
| [`plugin/`](plugin/) | Loon 插件文件（8 款） |
| [`script/`](script/) | 插件使用的脚本（微博机型伪装） |
| [`box/`](box/) | 插件盒子网页源码（HTML / CSS / JS） |
| [`functions/`](functions/) | 盒子的 Cloudflare Pages Functions（清单接口、GitHub OAuth、人机验证） |
| [`icon/`](icon/) | 图标资源 |
| [`manifest.json`](manifest.json) | 插件清单，由 GitHub Actions 自动生成 |
| [`.github/workflows/`](.github/workflows/) | 清单生成流程 |

## ⚙️ 自动化的工作流程

向 `main` 分支推送 `plugin/*.plugin` 或工作流本身的变更后，GitHub Actions 会：

1. 扫描 `plugin/` 下所有 `.plugin` 文件，解析头部元数据（`#!name`、`#!desc`、`#!tag`、`#!version` 等）；
2. 重新生成 `manifest.json` 并提交回仓库（使用默认 `GITHUB_TOKEN`，避免触发循环）；
3. Cloudflare Pages 检测到仓库更新后自动重新部署插件盒子。

没有 `#!tag` 的插件按工作流中的文件名映射表归类；映射表中也没有的，归入「其他」。

## 🛠️ 添加插件

1. 将 `.plugin` 文件放入 `plugin/`，配套脚本放入 `script/`。
2. 在插件头部填写元数据：

   ```
   #!name = 示例 自选节点
   #!desc = 功能说明
   #!tag = 代理分流
   #!author = @OliviaR13
   #!icon = https://example.com/icon.png
   #!version = 1.0.0
   ```

3. 提交到 `main` 分支，其余交给 Actions。

## 📊 统计

<p align="center">
  <a href="https://github.com/OliviaR13/MyLoon">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github-stats-extended.vercel.app/api/pin/?username=OliviaR13&repo=MyLoon&hide_border=true&locale=cn&theme=dark">
      <img alt="MyLoon" src="https://github-stats-extended.vercel.app/api/pin/?username=OliviaR13&repo=MyLoon&hide_border=true&locale=cn">
    </picture>
  </a>
  <a href="https://github.com/OliviaR13">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github-stats-extended.vercel.app/api?username=OliviaR13&show_icons=true&hide_border=true&locale=cn&theme=dark">
      <img alt="OliviaR13 的 GitHub 统计" src="https://github-stats-extended.vercel.app/api?username=OliviaR13&show_icons=true&hide_border=true&locale=cn">
    </picture>
  </a>
</p>

> 卡片由 [GitHub Stats Extended](https://github.com/stats-organization/github-stats-extended) 动态生成，它是已停止维护的 github-readme-stats 的后继项目。

## ⚠️ 免责声明

本仓库内容基于个人使用场景编写，主要由 AI 辅助生成，不保证适用于所有网络环境和账号状态。仅供个人学习交流，请遵守相关 App 的用户协议。因使用本仓库内容导致的账号或网络问题，作者不承担责任。

## 🙏 参考与致谢

| 类别 | 项目 | 用途 |
|---|---|---|
| 📖 文档 | [Loon 插件文档](https://nsloon.app/docs/Plugin/) | 插件头部字段、`[Argument]` 和 `#!tag` 的写法 |
| 📖 文档 | [SunsetMkt/anti-ip-attribution](https://github.com/SunsetMkt/anti-ip-attribution) | 规则思路参考 |
| 🎨 素材 | [Koolson/Qure](https://github.com/Koolson/Qure) | 插件图标 |
| 🎨 素材 | [luestr/IconResource](https://github.com/luestr/IconResource) | 小红书插件图标 |
| 🧩 服务 | [Cloudflare Pages](https://developers.cloudflare.com/pages/) | 插件盒子的托管与接口 |
| 🧩 服务 | [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) | 插件盒子的人机验证 |
| 🧩 服务 | [GitHub Stats Extended](https://github.com/stats-organization/github-stats-extended) | 统计卡片，基于 [github-readme-stats](https://github.com/anuraghazra/github-readme-stats) |
| 🧩 服务 | [Shields.io](https://shields.io/) | 顶部徽章 |

## 📄 许可

版权所有 © 2026 soobsessed，保留所有权利。详见 [LICENSE](LICENSE)。
