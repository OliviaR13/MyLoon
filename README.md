# MyLoon

个人整理的 [Loon](https://www.nsloon.com/) 插件（`.plugin`）合集，附带一个可一键安装的网页插件盒子。部分插件在编写过程中使用了 Claude、ChatGPT 辅助。

## 安装

### 通过插件盒子

访问 [MyLoon Box](https://oliviar13.github.io/MyLoon/)，搜索或按分类筛选插件，点击「安装」，将通过 `loon://install?url=...` 唤起 Loon 导入。

### 手动添加

1. 在 [`plugin/`](plugin) 目录中打开目标 `.plugin` 文件，复制其 raw 链接：
   `https://raw.githubusercontent.com/OliviaR13/MyLoon/main/plugin/<文件名>.plugin`
2. Loon → 插件 → 右上角 `+` → 粘贴链接 → 添加

## 使用注意

- 名称中带「自选节点」的插件，安装后需在插件详情页的「代理指向的策略」中选择用于代理的策略组或节点。未选择时，默认使用全局策略的第一个节点。
- 建议选择固定的单一节点（`select` 类型策略组），不要使用 `url-test` 等自动测速类型，以免节点切换中断长连接。
- 插件需排在主配置中 `GEOIP,CN,DIRECT` 等国内直连规则之前，否则规则会被先行匹配而无法生效。

## 插件分类

分类由插件头部的 `#!tag` 字段决定，插件盒子取第一个标签作为所属分类。

| 分类 | 说明 |
|---|---|
| 代理分流 | 将指定 App 或服务的相关域名统一走 `PROXY` 策略 |
| IP 属地 | 仅代理承载属地 / 风控判定信号的接口，Feed、图片、视频等媒体 CDN 保持直连 |
| 登录修复 | 对认证域名直连并跳过 MITM，处理登录窗口反复弹出等问题 |

一个插件可以写多个标签，用英文逗号分隔，例如 `#!tag = IP 属地,功能增强`。第二个及之后的标签只在 Loon 中显示，不影响盒子里的分类。

插件列表以 `plugin/` 目录中的实际文件为准，本文档不单独维护清单。

## MyLoon Box

仓库内置一个静态网页形式的插件盒子，源码位于 [`box/`](box)。

- 读取 [`manifest.json`](manifest.json)，展示插件名称、版本、描述、分类和图标
- 支持搜索与分类筛选
- 通过 `loon://install?url=...` 安装
- 使用纯 HTML / CSS / JS，无构建依赖

`manifest.json` 由 GitHub Actions（[`update-manifest.yml`](.github/workflows/update-manifest.yml)）在 `plugin/*.plugin`、`box/**` 或工作流本身变更后重新生成，并部署到 GitHub Pages。部署时 `box/` 下的文件会被复制到站点根目录，因此页面地址不含 `/box/`。部署说明见 [BOX_SETUP.md](BOX_SETUP.md)。

## 添加插件

1. 将 `.plugin` 文件放入 `plugin/` 目录。
2. 在文件头部填写元数据，其中 `#!tag` 决定盒子里的分类：

   ```
   #!name = 示例 自选节点
   #!desc = 功能说明
   #!tag = 代理分流
   #!author = @OliviaR13
   #!icon = https://example.com/icon.png
   #!version = 1.0.0
   ```

3. 提交到 `main` 分支，工作流会自动更新 `manifest.json` 并部署。

未填写 `#!tag` 的插件，按工作流中的文件名映射表归类；映射表中也没有的，归入「其他」。

## 已知限制

插件作用于规则与路由层面，以下情况不在其可控范围内：

- **客户端超时**：部分 App 的接口设有较短的客户端超时。热启动时若新建代理连接耗时超过该阈值，请求会被 App 取消。此类问题与节点延迟和稳定性相关，与规则无关。
- **CDN 连接重置**：CDN 边缘节点偶发的连接重置，由对端或链路状况决定。
- **插件叠加**：同时启用对同一批域名进行 MITM 解密或响应体改写的其他插件（如去广告类）时，两者的作用相互独立，出现异常需分别排查。

## 免责声明

本仓库规则基于个人使用场景整理，不保证适用于所有网络环境和账号状态。仅供个人学习交流，请遵守相关 App 的用户协议。因使用本仓库内容导致的账号或网络问题，作者不承担责任。

## 参考

- [SunsetMkt/anti-ip-attribution](https://github.com/SunsetMkt/anti-ip-attribution)：IP 属地分流思路
- [Koolson/Qure](https://github.com/Koolson/Qure)：插件图标
- [Loon 插件文档](https://nsloon.app/docs/Plugin/)：插件头部字段说明

## 许可

[MIT](LICENSE)
