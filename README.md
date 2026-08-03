# MoviePilot PT Send

一个 Chrome Manifest V3 扩展，用于从 PT 详情页或种子链接提取发布信息，调用 MoviePilot 识别媒体，并按 MoviePilot 已配置的媒体类型与分类目录创建下载任务。

## 功能

- 关闭识别确认时，右键菜单显示“直接发送到 MoviePilot”并立即发送；开启后菜单自动切换为“识别并发送到 MoviePilot”。
- 从常见 NexusPHP 类页面和通用 PT 页面提取下载链接、发布标题与副标题。
- 可配置“发送前识别并确认”；开启后自动预览媒体、年份、季集和分类，再由用户确认下载。
- 调用 MoviePilot `/api/v1/download/add` 创建任务。
- 下载器与保存路径默认留空，由 MoviePilot 自动选择；也可以在弹窗中临时覆盖。
- 可在设置中统一控制是否附带当前 PT 站 Cookie，发送弹窗不再提供单次覆盖。
- 下载请求完成后，在来源网页底部显示成功或失败提示。
- 支持 HTTP(S) 种子下载链接和 magnet 链接。

当前实现按本机 MoviePilot `v2.15.3` API 开发。

浏览器最低版本为 Chrome 127，以保证右键菜单可以直接打开扩展弹窗。

## 安装

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录：

   ```text
   /home/ts/projects/tools/MoviePilot-Download
   ```

5. 打开扩展设置，填写 MoviePilot 地址和 MoviePilot 配置中的 `API_TOKEN`。
6. 按需要配置“发送前识别并确认”和“附带当前站点 Cookie”。
7. 点击“测试连接”，一次性授权所需权限并同步下载器、下载目录。

MoviePilot 地址填写 Web 入口或反向代理入口即可，例如：

```text
http://192.168.1.10:3000
https://moviepilot.example.com
https://example.com/moviepilot
```

地址末尾的 `/api/v1` 会被自动移除，扩展会自行拼接接口路径。

## 使用

### 右键种子链接

1. 在 PT 站种子下载链接上点击右键。
2. 选择“直接发送到 MoviePilot”。
3. 默认模式会直接使用设置中的下载器、保存路径和 Cookie 策略创建任务。
4. 网页底部会显示发送成功或失败结果。

开启“发送前识别并确认”后，右键菜单会改为“识别并发送到 MoviePilot”，并自动打开弹窗展示 MoviePilot 识别结果；核对后点击“发送到 MoviePilot”才会创建任务。标题或链接被修改后，必须重新识别。

### 当前详情页

在 PT 种子详情页打开扩展弹窗。扩展会从当前页面选择最可能的种子下载链接，并提取标题和副标题。页面结构特殊时可以直接编辑三个字段。

## 自动分类规则

默认保存路径为“按媒体分类自动选择”，发送请求时 `save_path` 为 `null`。MoviePilot 将：

1. 根据发布标题和副标题识别媒体。
2. 补充媒体类型与二级分类。
3. 按 MoviePilot 下载目录的 `media_type`、`media_category` 和优先级选择目录。
4. 将媒体分类传给下载器创建任务。

在扩展中显式选择保存路径会覆盖这套自动目录选择规则。

## 权限与凭据

扩展没有固定的全站主机权限。设置保存或连接测试时会申请 MoviePilot 主机权限，并按 Cookie 配置申请或撤销可选权限；右键发送本身不再弹出授权框：

| 权限 | 用途 |
| --- | --- |
| `activeTab`、`scripting` | 在用户当前打开的 PT 页面只读提取种子信息。 |
| `contextMenus` | 提供右键发送入口。 |
| `storage` | 在本机保存 MoviePilot 地址、API Token 和默认选项。 |
| 可选主机权限 | 仅访问用户配置的 MoviePilot 主机；当前 PT 页面由 `activeTab` 临时授权。 |
| 可选 `cookies` | 仅在设置启用后读取当前 PT 详情页对应的 Cookie。 |

- API Token 保存在 `chrome.storage.local`，不会使用浏览器同步存储；存储访问级别限制为扩展可信上下文。
- PT Cookie 不会写入扩展存储，只在发送时从当前 PT 页面临时读取并交给用户配置的 MoviePilot；关闭配置后发送逻辑不会读取 Cookie。
- MoviePilot 请求使用 `X-API-KEY` 请求头，API Token 不出现在 URL、错误消息或扩展日志中。
- 扩展申请主机权限时会固定 URL 的实际端口；未填写端口时使用 HTTP 80 或 HTTPS 443。

## 开发与校验

项目不需要打包器或运行时依赖。Node.js 仅用于测试与静态校验：

```bash
npm test
```

校验内容包括 Manifest V3 结构、引用文件、PNG 图标、本地 HTML 资源、ES Module 导入以及 JavaScript 语法。

目录结构：

```text
manifest.json                 Chrome Manifest V3 配置
src/background.js             右键菜单、页面提取、Cookie 和 MoviePilot 请求编排
src/shared/                   API、权限、存储、URL 与页面提取逻辑
src/popup/                    种子确认、识别和发送弹窗
src/options/                  MoviePilot 连接与默认路由设置
tests/                        Node.js 单元测试
scripts/validate-extension.mjs 静态结构校验
```

## 已知边界

- 扩展发送的是可直接下载 `.torrent` 的 URL 或 magnet 链接，不会把 PT 详情页 URL 当成种子文件。
- 各 PT 站 DOM 结构并不统一；需要逐次核对时应开启“发送前识别并确认”。
- 如果 PT 站使用验证码、一次性页面交互或非 Cookie 鉴权，MoviePilot 仍可能无法从链接取得种子文件。
- MoviePilot 必须已经配置至少一个下载器和匹配媒体分类的下载目录。

## 许可证

本项目采用 GPL v3。Chrome 图标由 MoviePilot `app.ico` 转换；界面图标使用 Lucide，许可证见 [src/vendor/LUCIDE_LICENSE](src/vendor/LUCIDE_LICENSE)。
