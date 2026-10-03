<div align="center">

# 🐦 MyLoon

**一份 [Loon](https://www.nsloon.com/) 插件合集，外加一个能一键安装的网页插件盒子。**

[![MyLoon Box](https://img.shields.io/badge/MyLoon-Box-2f6f5e?style=for-the-badge)](https://oliviar13.github.io/MyLoon/)
[![License](https://img.shields.io/github/license/OliviaR13/MyLoon?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/OliviaR13/MyLoon?style=for-the-badge)](https://github.com/OliviaR13/MyLoon/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/OliviaR13/MyLoon?style=for-the-badge)](https://github.com/OliviaR13/MyLoon/commits/main)

</div>

> 部分插件在编写过程中使用了 Claude、ChatGPT 辅助。

## 📦 安装插件

**方式一：插件盒子**

打开 [MyLoon Box](https://oliviar13.github.io/MyLoon/)，选择插件后点击「安装」，页面会通过 `loon://install?url=...` 唤起 Loon。

**方式二：手动添加**

1. 在 `plugin/` 中找到目标文件，复制 raw 链接：
   `https://raw.githubusercontent.com/OliviaR13/MyLoon/main/plugin/<文件名>.plugin`
2. Loon → 插件 → 右上角 `+` → 粘贴链接 → 添加

## 🧭 插件是怎么工作的

插件只做一件事：为指定域名的请求选择走代理还是直连。

```mermaid
flowchart LR
    A[App 发出请求] --> B{命中插件规则?}
    B -- "PROXY" --> C[你在插件里选的节点]
    B -- "DIRECT" --> D[直连]
    B -- 未命中 --> E[继续匹配主配置规则]
```

这也是「规则顺序」要求插件排在 `GEOIP,CN,DIRECT` 之前的原因：先命中直连规则的请求，不会再走到插件。

## 🗂️ 插件分类

插件头部的 `#!tag` 决定其在盒子中的分类，盒子取第一个标签。

| 分类 | 内容 |
|---|---|
| 🔀 代理分流 | 指定 App 或服务的相关域名统一走 `PROXY` |
| 📍 IP 属地 | 仅代理属地 / 风控相关接口，Feed、图片、视频等媒体 CDN 直连 |
| 🔑 登录修复 | 认证域名直连并跳过 MITM |

`#!tag` 可写多个标签，以英文逗号分隔，如 `#!tag = IP 属地,功能增强`。

当前包含哪些插件，以 `plugin/` 目录和插件盒子为准。

## 🎛️ 使用说明

- **选择节点**：名称带「自选节点」的插件，需在插件详情页的「代理指向的策略」中选择策略组或节点。未选择时，使用全局策略的第一个节点。
- **节点类型**：建议选择固定的单一节点（`select` 类型策略组）。使用 `url-test` 等自动测速类型时，节点切换可能中断已建立的连接。
- **规则顺序**：插件需排在主配置中 `GEOIP,CN,DIRECT` 等国内直连规则之前。
- **插件叠加**：若同时启用了对相同域名做 MITM 解密或响应体改写的其他插件（如去广告类），各插件独立生效，出现异常时需分别排查。

## 🎁 小彩蛋

微博插件除了属地分流，还可以自定义发博、评论、转发时显示的来源机型。设置页的下拉菜单里有 32 款，从 iPhone 11 到 iPhone 18 Pro Max 都有。

## ❓ 常见问题

**为什么叫「自选节点」？**
插件里只写了哪些域名走代理，具体走哪个节点由你在插件详情页自己选。

**选了机型之后微博里没变化？**
切换机型后，需要到微博「微博来源」中重新选择一次。

**插件装了但好像没生效？**
先检查插件是否排在 `GEOIP,CN,DIRECT` 等国内直连规则之前。

**连接偶尔失败是插件的问题吗？**
插件只决定走代理还是直连。连接被取消、重置或超时的原因可能在 App、节点、CDN 或链路等环节，插件规则无法判断或修复。

## 🗃️ 目录结构

| 路径 | 内容 |
|---|---|
| `plugin/` | Loon 插件文件 |
| `box/` | 插件盒子网页源码 |
| `icon/` | 图标资源 |
| `manifest.json` | 插件清单，由 GitHub Actions 自动生成 |
| `.github/workflows/` | 清单生成与 GitHub Pages 部署流程 |
| `BOX_SETUP.md` | 插件盒子的部署说明 |

## 🛠️ 添加插件

1. 将 `.plugin` 文件放入 `plugin/`。
2. 在文件头部填写元数据：

   ```
   #!name = 示例 自选节点
   #!desc = 功能说明
   #!tag = 代理分流
   #!author = @OliviaR13
   #!icon = https://example.com/icon.png
   #!version = 1.0.0
   ```

3. 提交到 `main` 分支。

`plugin/*.plugin`、`box/**` 或工作流文件变更后，GitHub Actions 会重新生成 `manifest.json` 并部署到 GitHub Pages。没有 `#!tag` 的插件，按工作流中的文件名映射表归类；映射表中也没有的，归入「其他」。

## ⚠️ 免责声明

本仓库内容基于个人使用场景整理，不保证适用于所有网络环境和账号状态。仅供个人学习交流，请遵守相关 App 的用户协议。因使用本仓库内容导致的账号或网络问题，作者不承担责任。

## 🙏 参考

- [Loon 插件文档](https://nsloon.app/docs/Plugin/)
- [SunsetMkt/anti-ip-attribution](https://github.com/SunsetMkt/anti-ip-attribution)：IP 属地分流思路
- [Koolson/Qure](https://github.com/Koolson/Qure)：插件图标

## 📄 许可

[MIT](LICENSE)
