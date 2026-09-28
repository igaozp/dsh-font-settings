# @igaozp/dsh-font-settings

为 DeepSeek Harness（DSH）添加字体设置，在 **设置 → 通用 → 字体** 中分别选择界面字体和代码字体。

## 安装

请先安装 DSH，并确保终端中可以运行 `dsh` 命令。本插件用于带有 Web 界面和「通用」设置页面的 profile。

以下命令中的 `demo` 都需要替换为你实际使用的 **profile 名称**；安装到其他 profile 不会影响当前界面。

### 从 npm 安装

包发布到 npm 后，执行：

```sh
dsh plugin --profile demo add @igaozp/dsh-font-settings
```

安装会自动启用插件配置层，无需手动编辑配置文件。

## 使用

1. 安装后完整退出并重新启动 DSH，然后刷新 Web 页面。
2. 打开 **设置 → 通用**，找到「字体」。
3. 分别选择「界面字体」和「代码字体」，更改立即生效，无需点击保存。
4. 要恢复默认样式，将对应选项改为「跟随系统默认」。

若设置无法保存，界面会显示错误提示。

## 常见问题

### 安装后没有看到字体设置

确认安装命令中的 profile 与当前使用的 profile 一致，并已完整重启 DSH。可以检查该 profile 的组合配置：

```sh
dsh --profile demo --dump-config
```

输出中应包含 `@igaozp/dsh-font-settings` 配置层。目标 profile 还需要提供 Web 服务和通用设置页面；本插件不会单独创建这些页面。

### 找不到想用的字体

先在运行 DSH 的机器上安装字体，再重启 DSH 并刷新页面。插件只能列出它能识别的已安装字体，不能直接选择尚未安装的字体文件。

如果通过浏览器访问另一台机器上的 DSH，字体列表来自运行 DSH 的机器；浏览器所在的机器也需要安装所选字体，才能正确显示。

### 如何卸载

```sh
dsh plugin --profile demo remove @igaozp/dsh-font-settings
```

卸载后重启 DSH，并刷新页面。

## 维护与发布

自动打包和 npm 发布流程见 [发布说明](PUBLISHING.md)。
