# 自动发布到 npm

推送 `v版本号` 标签后，GitHub Actions 会检查版本和 JavaScript 语法、生成 `.tgz`，并将该包发布到 npm。普通分支提交不会触发发布。

项目直接分发 `lib/` 中的 JavaScript，没有依赖安装或编译步骤。

## 首次配置

1. 将 `.github/workflows/publish.yml` 提交并推送到 GitHub。
2. 如果 npm 上还没有 `@igaozp/dsh-font-settings`，先在本地使用有权限的账号完成首次发布：

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm publish
   ```

3. 打开 npm 上该包的 **Settings → Trusted publishing**，添加 GitHub Actions，填写：

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `igaozp` |
   | Repository | `dsh-font-settings` |
   | Workflow filename | `publish.yml` |
   | Environment name | 留空 |
   | Allowed actions | 允许直接执行 `npm publish` |

该流程通过 OIDC 认证，无需在 GitHub Secrets 中保存 `NPM_TOKEN`。npm 的配置步骤见 [Trusted publishing 官方文档](https://docs.npmjs.com/trusted-publishers/)。

## 发布后续版本

确认工作区干净、修改已提交后，在项目目录执行：

```sh
npm version patch
git push origin main
git push origin --tags
```

例如当前为 `1.0.0`，`npm version patch` 会更新为 `1.0.1`，创建版本提交及 `v1.0.1` 标签。推送标签后自动发布。

流程要求标签与 `package.json` 的版本完全一致，仅支持 `x.y.z` 正式版本。已发布的版本不能重复发布；首次手动发布 `1.0.0` 后，应从新版本开始使用自动流程。

在 [GitHub Actions](https://github.com/igaozp/dsh-font-settings/actions/workflows/publish.yml) 查看运行结果。配置或网络问题修复后，可重跑失败任务；如果 npm 已成功发布该版本，不要再次发布相同版本。
