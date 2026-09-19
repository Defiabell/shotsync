[English](README.md) | 简体中文

# shotsync

属于你自己的跨设备图片 & 文字中转池，几分钟就能部署到 Cloudflare 免费档。在一台设备上截图或存图，另一台设备随手就能拿到。手机端无需装 App（是 PWA），不经任何第三方图床——数据只待在你自己的 Cloudflare 账户里。

**🎬 在线演示（只读示例池）：https://shotsync-demo.defiabell.workers.dev**

## 选择使用方式

**自己部署是默认方式，不需要注册 ShotSync 账号，也不需要 Supabase、D1 或邮件服务。** 部署到自己的 Cloudflare 后，每台设备输入同一个访问令牌即可使用。

| 方式 | 适合谁 | 如何进入 | 数据存放 |
| --- | --- | --- | --- |
| **自己部署（默认）** | 想拥有自己的图片与文字池 | 部署后输入自己设置的 `AUTH_TOKEN` | 自己的 Cloudflare R2 |
| 公共托管服务（试用） | 不想部署，接受运营方存储数据和使用限额 | 在服务地址注册／登录 | 运营方的 Cloudflare R2 |
| 只读演示 | 先看看界面 | 打开上方演示地址；不能上传 | 公开样例 |

自部署按[下面的步骤](#自己部署约-5-分钟)操作即可。公共服务的可用状态和限额见[托管版说明](docs/hosted.md)；托管版目前仍有免费 CPU 限制，认证升级尚未上线。[模式区别与常见问题](docs/deployment-modes.md)。

![shotsync gallery](docs/screenshot.png)

## 这是什么

一个 **Cloudflare Worker + R2 存储桶**，配一个**网页相册（PWA）**：

- 上传**图片**（浏览器端转 JPEG + 生成缩略图）和**文字**片段。
- 任意设备倒序看瀑布流，点开可**保存/下载**、**删除**。
- 给单个 item 生成**带签名、会过期的公开链接**分享出去——而不暴露池子里的其余内容。
- **token 门禁**：一个共享密钥解锁整个池子，其余一律私有。
- 一个 **30 天自动清理的中转池**，不是归档仓库。

## 为什么

iCloud / AirDrop / 网盘 / 公开图床，要么手动、要么锁死在某个生态、要么把（可能含工作内容的）截图过别人的云。shotsync 是一个自托管、免费、尊重隐私的方案：数据只在你自己的设备和你自己的 Cloudflare 账户之间流转。

## 和别的工具比（LocalSend、PairDrop、发给自己）

分界线是**实时传输 vs 等着你来取的池子**。LocalSend 和 PairDrop 要求两台设备此刻都醒着，然后在它们之间直传。shotsync 把东西存 30 天，所以你去取的时候，发送那台可以已经睡了、换了网络，甚至在另一个国家。

|  | shotsync | [LocalSend](https://localsend.org) | [PairDrop](https://pairdrop.net) |
| --- | --- | --- | --- |
| 两台设备要同时在线 | 不需要 | 需要 | 需要 |
| 安装 | 不用装（浏览器 PWA） | 每台设备装一个 app | 不用装（浏览器） |
| 跨不同网络 | 可以 | 不行，必须同一局域网 | 靠临时公共房间 |
| 数据经过哪里 | 你自己的 Cloudflare R2 | 设备直连，无服务器 | 点对点，但用公共信令服务器 |
| 传完之后还留着吗 | 留 30 天，可翻阅 | 不留 | 不留 |
| 前期准备 | 部署一次，约 5 分钟 | 装好再打开 | 打开网页就行 |
| 单条大小上限 | 25 MB | 受硬盘限制 | 受连接限制 |

**这些情况用 LocalSend**：两台设备在同一个 Wi-Fi、都在你面前、文件还很大。它是点对点的，没有值得一提的体积上限，而且完全不需要联网。

**这些情况用 PairDrop**：你不想做任何准备工作，也不打算部署东西。从零到把文件传过去，它的路径最短。

**这些情况用 shotsync**：你老是要把截图发给自己，希望几小时后换台机器、换个网络坐下来时它还在；并且比起公共图床，你更愿意让这些东西待在自己的 Cloudflare 账号里。它替代的是「用微信发给自己」这个习惯，不是替代 AirDrop。

**默认自部署模式不区分用户账号**：一个共享 token 解锁整个池子。需要用户隔离时使用独立的托管账号模式；部署前请先看下面的「安全模型与限制」。

## 功能

- 跨设备图片 + 文字池（共享剪贴板 + 截图落点）
- PWA 相册——「添加到主屏幕」，无需原生 App、不上应用商店
- 客户端 HEIC→JPEG + 缩略图生成（省流量；Worker 不做图像处理）
- 带签名、会过期的公开分享链接（HMAC-SHA256，7 天）
- 单个保存/下载 + 多选批量删除
- 单 token 鉴权、constant-time 比较、token 永不进 URL
- 30 天自动留存（R2 lifecycle）
- 完全跑在 Cloudflare 免费档（Workers + R2）
- 自动化测试（Vitest + `@cloudflare/vitest-pool-workers`）

## 自己部署（约 5 分钟）

前置：一个 Cloudflare 账户、Node.js 22+、并**启用 R2**（控制台 → R2 → 启用；即使免费档 Cloudflare 也会要求绑卡——免费额度内不扣费）。

```bash
git clone https://github.com/Defiabell/shotsync
cd shotsync
npm install
npx wrangler login

# 1. 建 R2 存储桶（名字要和 wrangler.toml 里的 bucket_name 一致）
npx wrangler r2 bucket create shotsync

# 2. 设置共享访问 token —— 任意长随机串；每台设备要输它
openssl rand -hex 24                  # 生成一个，复制下来
npx wrangler secret put AUTH_TOKEN --config wrangler.toml --env ""    # 提示时粘贴

# 3. 部署
npm run deploy
```

你还需要一个 **workers.dev 子域名**（控制台 → Workers & Pages，一次性）或自定义域名。部署后会得到 `https://shotsync.<你的子域>.workers.dev`。

`npm run deploy` 固定使用 `wrangler.toml`，只部署个人池；不会创建账号数据库、要求 Supabase 密钥或部署公共账号服务。`AUTH_TOKEN` 是你自己生成的 ShotSync 访问口令，不是 Cloudflare API Token，也不是 Supabase 密钥。请保存它，并只交给允许访问整个池子的人。

部署后，在两台设备输入相同的地址和令牌，上传一小段文字并确认另一台能看到，即可完成检查。若出现邮箱注册页，你打开的是托管服务地址，请改用 Wrangler 刚返回的个人实例地址。

### 30 天自动清理

控制台 → R2 → 桶 `shotsync` → Settings → Object lifecycle rules → 对象创建 30 天后删除。

## 使用

界面按钮是中文，下面直接对应你看到的按钮。

### 1. 每台设备首次使用
1. 打开你的 Worker 地址（如 `https://shotsync.<你的子域>.workers.dev`）。
2. 弹框时输入你的 `AUTH_TOKEN` —— 它存在 `localStorage`，之后这台设备不再问。
3. （可选）Safari 里 **分享 → 添加到主屏幕**，装成 PWA，像 App 一样全屏运行。

相册倒序展示所有 item，约每 20 秒自动刷新，所以其它设备传的东西几秒内就会出现。

### 2. 往池子里加东西
- **图片** —— 点 **`+ 图片`**：从相册或相机选。浏览器端转成 JPEG + 缩略图后上传。
- **文字** —— 点 **`✎ 文字`**，粘贴/输入片段，点 **`发送`**。变成一张文字卡片——跨设备剪贴板。
- **Mac 截图（自动）** —— 装上 [Mac 菜单栏 App](mac/README.md)：每次截图自动上传。
- **iOS 分享菜单** —— 配一个[快捷指令](shortcut/README.md)，从任意 App 的分享菜单推图进来。

### 3. 点开单个 item
点任意缩略图/卡片全屏打开，然后：
- **`保存` / `复制`** —— 图片：存到相册（手机）或下载（桌面）；文字：复制到剪贴板。
- **`分享`** —— 为这一个 item 生成 **7 天有效的公开链接**并复制到剪贴板。拿到链接的人只能看这一个；池子其余部分仍私有。
- **`删除`** —— 删掉这个 item。
- **`关闭`** —— 返回相册。

### 4. 批量删除
1. 点 **`选择`** 进入多选模式。
2. 点 item 勾选（蓝框）；再点一下取消勾选。
3. 点 **`删除选中 (N)`** → 确认。或点 **`取消`** 不删退出。

### 5. 查看 token、配置另一台设备、退出登录
点顶栏的 **`⚙`**。面板里有这个池子的地址和当前设备保存的 token——默认打码显示，因为 Mac 端会把截图自动传进池子，屏幕上一串明文 token 离进池只差一个 ⌘⇧3。
- **`显示`** 切换明文；**`复制`** 放进剪贴板，拿去另一台设备粘贴。
- **`退出登录`** 只是让这台设备忘掉 token、回到输入页。服务端没有任何变化，同一个 token 在别的设备照常可用。

## 安全模型与限制

- **单一共享 token。** 拿到「地址 + token」的任何人都能看/传/删。这是单人 / 可信小圈子工具，不是多租户——没有按用户区分的账号，同一个池子也没有「切换 token」这回事；想要第二个池子就再部署一个 Worker。用 `npx wrangler secret put AUTH_TOKEN --config wrangler.toml --env ""` 轮换——注意这会同时让所有现存分享链接失效（token 也是链接的签名密钥）。
- **分享链接是公开的**，直到过期（7 天）：拿到链接的人都能看那一个 item。
- **中转池，不是归档。** item 按设计 30 天后自动删除。
- **界面目前是中文。** 欢迎提 i18n PR。
- Worker 原样存收到的字节（不做服务端图像处理）；格式转换和缩略图都在客户端做。

## 开发

```bash
npm test          # Vitest（workers pool）—— 全套
npx tsc --noEmit  # 类型检查
npm run dev       # 本地开发 —— 建一个含 AUTH_TOKEN=<任意串> 的 .dev.vars
```

## License

[MIT](LICENSE)

## 托管账号版（公开试用）

可独立部署邮箱＋密码注册／登录、恢复码重置密码（无需发邮件）、多用户文件隔离、设备令牌和账号／全站限额。[打开托管服务](https://shotsync-hosted.defiabell.workers.dev)。当前免费版试用，限 100 个账号；登录 CPU 实测仍超过免费版标称预算，高负载下可能受限。部署与限制见 [docs/hosted.md](docs/hosted.md)。现有自部署和只读 demo 保持原有使用方式；开发工具链需要 Node.js 22+。

新版认证已改为交给 Supabase Auth 处理密码，仍需配置独立个人项目后才能切换线上；迁移与故障处理见部署文档。
