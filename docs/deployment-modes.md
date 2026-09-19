# ShotSync：选择部署与使用方式 / Deployment modes

## 默认：部署自己的个人池

这是项目的主要使用方式。只需要自己的 Cloudflare 账号、一个 Worker、一个 R2 存储桶，以及自己生成的 `AUTH_TOKEN`。不需要注册 ShotSync 账号、Supabase、D1、邮件域名或验证码服务。

按 [中文快速部署](../README.zh-CN.md#自己部署约-5-分钟) 或 [English quick start](../README.md#deploy-your-own-5-min) 操作。`npm run deploy` 明确选择 `wrangler.toml`，入口是 `src/index.ts`；`npm run dev` 也使用同一配置。

部署成功后：

1. 保存 Wrangler 返回的个人实例地址及自己生成的访问令牌。
2. 每台设备打开该地址，输入相同令牌。令牌持有者共享整个池子，可查看、上传和删除。
3. 在一台设备发送一小段文字，检查另一台能看到。
4. 在 R2 配置 30 天删除规则。Worker 不会替你创建这条生命周期规则。

`AUTH_TOKEN` 是应用访问口令，**不要把 Cloudflare API Token、GitHub Token 或 Supabase Secret 填进网页**。令牌丢失时由部署者在自己的 Worker 上更换 `AUTH_TOKEN`；更换后各设备需重新输入，旧分享链接也会失效。

## 可选：直接使用公共托管服务

不想部署的用户可使用运营方提供的账号服务。浏览器通过邮箱和密码进入自己的文件池；文件存放在运营方的 Cloudflare 中，受服务人数、上传、存储和保留时间限制。使用者不需要开通 Cloudflare 或 Supabase。

托管服务与自部署实例的数据、登录账号和访问令牌不互通，不会自动迁移或同步。Mac App／快捷指令应填写所选服务的地址：个人池使用共享 `AUTH_TOKEN`，托管服务使用登录后创建的设备令牌。

当前公共服务仍为试用，原登录实现存在免费 CPU 限制，认证升级尚未部署；实际状态见[托管说明](hosted.md)。只读 demo 仅用于浏览公开样例，不接受上传，也不是公共账号服务。

## 仅运营者：部署多用户账号服务

[托管部署文档](hosted.md)面向想为多人运营服务的人。它有独立的 Worker 入口、D1 和 R2 资源；外部认证升级另需运营者的 Supabase 配置。不要把这套配置作为个人池的安装前提，也不要复制维护者的数据库 ID、存储桶或认证项目配置。

| 命令 | 配置 | 部署内容 |
| --- | --- | --- |
| `npm run deploy` | `wrangler.toml` | 无注册流程的个人 token 池（默认） |
| `npm run deploy:hosted` | `wrangler.hosted.jsonc` | 多用户账号服务，仅运营者使用 |

升级个人池代码不会自动开启账号系统。两种模式维持独立入口和显式配置；不根据是否发现 Supabase 密钥自动切换。只读 demo 是第三个独立演示环境。

## English summary

Self-hosting remains the default: Worker + R2 + one shared `AUTH_TOKEN`. Run `npm run deploy`; no ShotSync account, Supabase, D1, email or CAPTCHA setup is required. Token holders share the entire pool. Configure the 30-day R2 lifecycle explicitly.

The optional hosted service uses individual accounts and the operator's storage/quotas. Only its operator needs the extra infrastructure; end users sign in at that service's URL. Accounts, files and credentials are not automatically shared with personal deployments. The hosted beta is still undergoing an authentication upgrade; see its guide for current availability.

`npm run deploy:hosted` is an explicit, separate operator workflow. It never replaces the default personal deployment. The read-only demo is only for exploring sample content.
