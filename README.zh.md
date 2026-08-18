# Tufte for Obsidian

![Obsidian Theme](https://img.shields.io/badge/Obsidian-Theme-7B2FBF) ![license MIT](https://img.shields.io/badge/license-MIT-4C9A2A) ![Dark & Light Supported](https://img.shields.io/badge/Dark_%26_Light-Supported-C9A227) ![Mobile Supported](https://img.shields.io/badge/Mobile-Supported-1E88C7)

[English](README.md) | **简体中文**

一款改写自 [Tufte CSS](https://edwardtufte.github.io/tufte-css/) 的 [Obsidian](https://obsidian.md) 主题，把 Edward Tufte 的书籍设计——ET Book 字体、页边旁注、克制的细线、一处刻意的红——带进应用的每一个角落，并在拉丁排印系统之外，配备一套完整的中文排印系统（宋体正文、楷体示例、黑体数据）。

请访问完整文档获得更完整的展示：[文档](https://dclin.me/TufteObsidian/)

![Tufte for Obsidian——Bases 书架画廊，明暗两色。](screenshot.png)

## 主题涵盖什么

- **排印** —— ET Book（内嵌、离线可用；MIT 许可），回落至 Palatino/Georgia；数据、界面乃至（自 1.17.0 起）整个应用外壳皆用 Gill Sans；55rem 的阅读栏宽，外加一条边注栏；凡数字成列之处，一律使用表格用正体数字。**字族与字重皆可调**——衬线、无衬线与中文伴随字体（思源预设、内嵌 Cabin，或任意已装字体）均在 Tufte Suite 的字体设置中选择。
- **表格与 Bases** —— 散文表格与 Obsidian 的 Bases 数据库视图共用一套取法《Beautiful Evidence》的样张表格规范：表头之下一条细线，不设竖线，对齐自会说话。Bases 的**卡片视图渲染为书架画廊**——无框封面立于同一条架线之上，配以居中的扉页式图注。
- **章首题图** —— 纯 CSS 实现的 `[!banner]` 标注块，以一幅通栏图版开启一篇笔记，如同 Tufte 书中的章首。
- **安静的界面** —— 侧边栏、标签页、菜单与关系图谱皆是纸墨本色；玻璃界面为 95% 不透明度加磨砂，并提供整窗半透明模式（三个 Style Settings 滑块）。
- **中文排印** —— 宋体正文；楷体承担斜体语境（题词、图注、署名）；黑体用于数据标签；行末标点挤压；并为 Windows 准备了 CJK 回落字体。
- **标签、高亮、标注块** —— 彩色文字而非胶囊；六色辅助色盘的彩度压在主红之下，让红色始终保有指示之义。

明暗两种模式全程可用；WCAG AA 对比度已在样式表中逐项记录。


### 旁注：Tufte 讲义设计的核心
旁注（sidenote）是 Tufte 讲义与书籍设计的核心特征之一，其渊源可上溯至页边评注（[Marginalia](https://en.wikipedia.org/wiki/Marginalia)）的传统。我发现这一功能对笔记过程颇有助益——一旦用起来，便渐渐在许多从前未曾留意的地方，发现了值得放一条旁注的位置。

<img width="809" height="167" alt="Sidenote-1" src="https://github.com/user-attachments/assets/fc615a85-6823-48c3-a30b-ed5bbc84c1d0" />
<img width="813" height="218" alt="Sidenote-2" src="https://github.com/user-attachments/assets/2feea790-b8b5-477a-936e-c3d05449cc8e" />

### 反向链接渲染器
反向链接是[卡片盒笔记法](https://en.wikipedia.org/wiki/Zettelkasten)（Zettelkasten）的核心特性。我为此写了一个插件，让反向链接以渲染后的 Markdown 呈现，而不是直接显示源码。

<img width="819" height="289" alt="BacklinkRender" src="https://github.com/user-attachments/assets/b8335034-de97-4816-85d8-5b86c93ec1aa" />

### 增强的插图功能
主题支持三种插图显示模式，包括把插图放进边注区。

<img width="812" height="518" alt="FigureMode-1" src="https://github.com/user-attachments/assets/4b41b036-0d3e-470e-97db-90364d71e714" />
<img width="860" height="607" alt="FigureMode-2" src="https://github.com/user-attachments/assets/24bbcb28-e240-4b35-bfa9-1bd83b463d72" />
<img width="833" height="606" alt="FigureMode-3" src="https://github.com/user-attachments/assets/c521476d-d62f-46f1-a280-8271e50662bb" />

把图片拖入窗格时，会弹出一个对话框询问该插图的更多细节——图注、编号与名称。同时支持多图并排与[图片拼贴](http://imagequilts.com/)（image quilts）。

<img width="545" height="707" alt="FigureSetting" src="https://github.com/user-attachments/assets/a9f18cc3-0c6a-4b59-8c57-26cbbe8516d9" />
<img width="851" height="453" alt="ImageQuilt" src="https://github.com/user-attachments/assets/08cc4703-e9dc-4003-9ed2-6746cab96853" />

## 配套插件 —— Tufte Suite

主题可以独立使用，但有一个插件补全了整套 Tufte 写作系统：**[Tufte Suite](https://github.com/PleiadesM/tufte-suite)**。它内含四个模块，每个都可在「设置 → Tufte Suite」中单独开关：

| 模块 | 功能 |
|---|---|
| **Tufte Sidenotes** | 在阅读视图中，把 `[^…]` 脚注与 `[!sidenote]`/`[!marginnote]` 标注块渲染为真正的页边旁注，编辑器保持单栏。 |
| **Tufte Figures** | 拖入或粘贴图片，即可编排正文栏、全宽、页边三种插图，图注得体；多图并排；图片拼贴生成器；自动编号的文内引用。 |
| **Tufte Inline** | 行内简写：`^^text^^` 小型大写开篇词，`&&text&&` 斜体引导句，`@@字@@` 两行中文首字下沉。 |
| **Tufte Backlinks** | 把「链接提及／未链接提及」的片段渲染为排版后的 Markdown——标题落回正文字号，反链引用本身加粗、下划线并作红色。 |

> **这四者原本是四个独立插件，现已归档。**
> 它们各自发布至 2026 年 8 月（Tufte Sidenotes 1.7.0、Tufte Figures 1.7.2、Tufte Inline 1.2.0、Tufte Backlinks 1.0.1）；本是一套写作系统，却要装四次、更新四次、分设四处设置。Tufte Suite 1.0.0 取代这四者，**此后所有插件更新只在那里进行**——各独立仓库与本仓库 [`plugins/`](plugins) 中的副本均已冻结，不再更新。
>
> 迁移不会损失任何功能：Suite 逐字节内嵌了各插件的代码作为模块，行为完全一致；关闭某个模块，就等同于卸载了原来的那个插件。**若你已安装这四个插件，请在启用 Suite 之前先禁用它们**，否则一切都会渲染两遍。Suite 会在首次加载时导入它们的设置与图片拼贴数据，并沿用原有的命令 ID，已绑定的快捷键照常可用。

## 安装

主题与插件均已上架 Obsidian 社区目录，无需手动下载：

- **主题：**设置 → 外观 → 主题 → *管理* → 搜索 **Tufte** → 安装并使用。（或打开 `obsidian://show-theme?name=Tufte`。）
- **插件：**设置 → 第三方插件 → *浏览* → 搜索 **Tufte Suite** → 安装 → 启用。（或打开 `obsidian://show-plugin?id=tufte-suite`。）

手动安装依然可行：把[最新 Release](../../releases/latest) 中的 `theme.css` 与 `manifest.json` 放入 `YourVault/.obsidian/themes/Tufte/`；把 [Tufte Suite Release](https://github.com/PleiadesM/tufte-suite/releases/latest) 中的 `main.js`、`manifest.json` 与 `styles.css` 放入 `YourVault/.obsidian/plugins/tufte-suite/`，再在第三方插件中启用。

可选：安装社区插件 **Style Settings**，即可获得玻璃界面的三个滑块（不透明度、模糊、整窗半透明）。字体选择位于 **Tufte Suite 自身的设置**（字体标签页），不在 Style Settings 中。

## 环境要求

- Obsidian 1.4.0 或更新版本（Bases 样式面向 1.9+）。
- 无需安装字体，也无需联网——ET Book 与 Cabin 已内嵌于样式表。

## 致谢

- [Tufte CSS](https://github.com/edwardtufte/tufte-css)，Dave Liepmann 与诸位贡献者——本主题所改写的排印源头。
- [ET Book](https://github.com/edwardtufte/et-book) © Dmitry Krasny、Bonnie Scranton、Edward Tufte、Adam Schwartz——MIT 许可，内嵌于 `theme.css`。
- [Cabin](https://github.com/impallari/Cabin) © the Cabin Project Authors——SIL OFL 1.1 许可，内嵌于 `theme.css`，作为字体设置随主题分发的无衬线字体。
- Edward Tufte 的著作——《The Visual Display of Quantitative Information》《Envisioning Information》《Visual Explanations》《Beautiful Evidence》——这里每一个设计决定背后的权威。

## 许可

[MIT](LICENSE) © 2026 Daocheng Lin。内嵌的 ET Book（MIT）与 Cabin（SIL OFL 1.1）字体保留其自身的许可与版权。

## 更新日志

- **1.18.0**（2026-08-14）
  - 调整属性面板
  - Style Settings 面板现已支持中文
  - 请与 Tufte Suite 1.2.0 搭配
- **1.17.0**（2026-08-14）
  - 字体可调：西文与中文的字族与字重（Tufte Suite → 字体）
  - 粗体随正文字重变化
  - 界面改用 Gill Sans，字号上调一档
  - 内嵌 Cabin 作为随主题分发的无衬线体
  - 请与 Tufte Suite 1.1.0 搭配
- **1.16.3**（2026-08-14）
  - 阅读版面只作用于笔记窗格
  - 更新插图题注的打印几何
- **1.16.2**（2026-08-11）
  - 导语略微放大
  - 收紧 H1 之后的间距
- **1.16.1**（2026-08-11）
  - 行内简写现可容纳嵌套标记
- **1.16.0**（2026-08-04）
  - 新增 Tufte 风格的打印／PDF 导出
  - 表格改为 booktabs 样式
  - 高亮改为淡彩；未创建链接的颜色变淡
- 更早版本——见 [Releases](https://github.com/PleiadesM/TufteObsidian/releases)。
