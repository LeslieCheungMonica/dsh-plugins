# 适配 DSH 原生侧边栏 API（变更说明总结）

> 适用版本：DSH 原生侧边栏 API **v0.19.0** 起，插件侧要求 **DSH 0.1.5-rc.1+**。
> 本文是对该变更说明的整理总结，末附原始文字。

## 一句话结论

右侧那一列不再由插件自绘，改为交给 DSH 自己的右侧栏；插件只负责**注册 tab 类型**、**打开 tab**，以及通过统一入口打开右侧栏里的文件。底部工作台和对外的 `ctx.betterSidebar` 服务不受影响。

## 适配要点

| 关注点 | 变化后的做法 |
| --- | --- |
| 右列的归属 | 右列就是 DSH 自己的右侧栏，插件不再拥有这块区域 |
| 注册 tab 类型 | 通过 `ctx.sidebarRightTabs` 注册 |
| 打开 / 承载 tab 体 | 通过 `ctx.sidebarRight` 完成 |
| 聊天里打开文件 | 统一走 `ctx.sidebarRight.openResource('dsh-resource://file/…')` |
| 插件自绘右侧面板 | 移除 |
| 旧的浮窗能力 | 同步移除 |
| 自绘的底部工作台 | 保持不变 |
| 开放给其他插件的 `ctx.betterSidebar` 服务 | 保持不变 |

## 分点说明

1. **右列即原生右侧栏**
   界面右列由 DSH 自身的右侧栏承担，插件的每个 tab 类型与 tab 体都注册 / 打开到这套原生 API 上，而不是画在自己的面板里。

2. **两个 API 分工**
   `ctx.sidebarRightTabs` 负责 tab 类型的注册，`ctx.sidebarRight` 负责打开与承载具体 tab。

3. **文件打开收敛到统一入口**
   聊天中的文件打开统一使用 `ctx.sidebarRight.openResource('dsh-resource://file/…')`，不再各自实现打开逻辑。

4. **被移除的能力**
   插件不再自绘右侧面板，旧的浮窗能力一并移除。

5. **保持不变的部分**
   自绘的底部工作台照旧；开放给其他插件的 `ctx.betterSidebar` 服务照旧。

## 原始说明（原文留档）

> 已适配 DSH 原生侧边栏 API（v0.19.0 起，DSH 0.1.5-rc.1+）：右列就是 DSH 自己的右侧栏——插件的每个 tab 类型与 tab 体通过 ctx.sidebarRightTabs / ctx.sidebarRight 注册与打开，聊天里的文件打开统一走 ctx.sidebarRight.openResource('dsh-resource://file/…')，插件不再自绘右侧面板（旧的浮窗能力同步移除）。自绘的底部工作台与开放给其他插件的 ctx.betterSidebar 服务保持不变。
