# dsh-session-editor

直接改写 DeepSeek Harness 会话日志里**已经发生的助手回复**。带图形界面，不用敲命令。

改完之后，那条回复在模型眼里依然是「**助手说的**」——这是它相对插件方案的关键优势：插件只能追加一条 `user/message` 去遮蔽原回复（框架不允许用替换事件改写 `assistant/message`），说话人会变成「用户」；而直接改日志没有这个限制。

---

## 快速开始

需要 **Node.js 22 或更新版本**（用到内置的 zstd 支持）。

```bash
git clone https://github.com/gghfg/dsh-session-editor.git
cd dsh-session-editor
npm install          # 可选：只影响校验与测试，界面本身零依赖
```

> 想把这个项目传到自己的 GitHub？步骤见 **[GITHUB.md](GITHUB.md)**（含隐私检查、Token/SSH 登录、国内网络处理、常见报错）。

Windows 上**双击 `start.cmd`**（自动打开浏览器），或手动启动：

```bash
node server.mjs            # 打开 http://127.0.0.1:4319/
node server.mjs --no-open  # 不自动开浏览器
node server.mjs --port=4320
```

### 用之前请先退出 DeepSeek Harness

编辑的是磁盘上的会话日志，而 DSH 内存里还握着旧的事件列表。**边跑边改会让两边状态冲突**，最坏的结果是这个会话重启后加载不出来。正确顺序：

```
1. 完全退出 DeepSeek Harness
2. 双击 start.cmd
3. 在界面上找到并改写回复
4. 关掉命令行窗口
5. 启动 DeepSeek Harness —— 模型看到的就是改过的历史了
```

界面顶部会自动检测 DSH 是否在运行并给出提示。

### 校验与测试

```bash
npm run verify <日志文件> "期望出现的文本"   # 用 DSH 自己的恢复校验器验证
npm run scan   <日志文件>                    # 检查帧结构在 DSH 眼里是否完整
npm test                                     # 跑全部测试（会复制会话，不碰原日志）
```

`npm install` 装的 `@deepseek-ai/dsh-session` 就是 DSH 内部用的那个包（版本与本机安装一致），
所以 `verify-log.mjs` 是用 DSH 自己的校验逻辑判断日志合不合法，不是我自己写的解析器。

---

## 图形界面（推荐）

**双击 `start.cmd`**，浏览器会自动打开 `http://127.0.0.1:4319/`。

- **左栏**：本机所有会话，按工作区分组。每个会话显示**开场白标题**（第一条用户消息）+ 时间 + 大小，改写过的带「已改 N」角标；顶部可按标题 / 会话号 / 工作区筛选。
- **右栏**：选中会话的助手回复。**默认只显示真正的回答，把工具调用轮藏起来**——实测 1631 条助手消息里有 1582 条在驱动工具、1032 条连一个字都没有。想看过程就勾选「显示过程消息（工具调用轮）」，过程卡片会以虚线 + 降透明度出现，并标注「过程 · 工具调用」。
- **折叠**：长回答、「思考」块默认收起摘要，点「展开全文」/「展开思考」看全部。思考块默认只给 100 字预览，因为它同样是过程信息。
- **会话内搜索**：顶部搜索框按关键词过滤本会话的回复正文。
- **改写**：点某条回复的「改写」→ 文本框里直接编辑 → 选是否保留原思考块 → 「保存并写入日志」。
- **回滚**：每条改写过的回复下方列出改动时间，点「回滚这次改写」即可恢复原文。
- **顶部横幅**：启动时检测 DeepSeek Harness 是否在运行，在运行就提示你先退出。

### 操作顺序

```
1. 完全退出 DeepSeek Harness
2. 双击 start.cmd
3. 在界面上找到并改写回复
4. 关掉那个命令行窗口（结束服务）
5. 启动 DeepSeek Harness —— 模型看到的就是改过的历史了
```

**为什么必须先退出**：会话日志在磁盘上，但 DSH 内存里还握着旧的事件列表。边跑边改会让新旧内容混在一起。

启动参数：

```powershell
.\start.cmd --port=4320                 # 端口被占用时换一个
node server.mjs --sessions-root=<目录>  # 指向别的会话根（测试用，默认 ~/.dsh/sessions）
```

---

## 命令行

界面之外，`tools/` 下的命令可以直接用。

### 1. 找到会话

```powershell
cd tools
node session-store.mjs list --limit=10
```

输出里带 `工作区目录名` 和完整的日志文件路径。

### 2. 找到要改的回复

```powershell
node session-store.mjs find <日志文件> "我可以完成这个任务"
```

输出形如：

```
# 832 [reasoning+text] (text) id=faded9ce-c372-41a5-a7c2-d60ffee5498b
    Host 半已完成并通过测试。先给你一个阶段性交代……
命中 1 条
```

也可以 `last <日志文件> 30` 看最近的若干条。

### 3. 关掉 DeepSeek Harness，然后改写

```powershell
node session-store.mjs rewrite <日志文件> 832 --text="我无法完成这个任务。"
```

> 新文本推荐用 `--text="…"` 传入。直接写成位置参数（`rewrite <文件> 832 我无法完成…`）
> 在 PowerShell 里遇到中文或空格时可能被分词，甚至误建出重定向文件——这个坑我踩过一次。

它会：备份原日志 → 替换文本块（**默认同时清空旧思考块**，避免「思考里说能做、回复里说不能做」的自相矛盾；要保留加 `--keep-reasoning`）→ 整体重压写回 → 删除该会话的投影缓存。

### 4. 验证

```powershell
node verify-log.mjs <日志文件> "我无法完成这个任务"
```

用 DSH 自己的恢复校验器检查：

```
✅ 恢复通过：会话日志能被校验器接受
✅ 历史里出现期望文本："我无法完成这个任务"
```

### 回滚

界面里点「回滚这次改写」，或把备份文件复制回去：

```powershell
Copy-Item <日志文件>.bak-<时间戳> <日志文件> -Force
```

---

## 为什么这条路走得通

模型每一步看到的历史，来自会话事件日志的表层投影。而日志就是磁盘上的：

```
~/.dsh/sessions/<工作区目录名>/<会话id>/session.v4.jsonl.zstd
```

把里面某条 `assistant/message` 的文本块换掉，重启恢复会话时模型看到的就是新文本。角色字段没动，所以它仍然是 assistant 的发言。

### 两个实测出来的坑

1. **日志是「逐帧追加」的 zstd，不是一个 zstd 流。** 当前会话有 600+ 个 zstd 帧。Node 的 `zstdDecompressSync` 对多帧输入**只返回第一帧**，所以天真地解压整个文件只能拿到一行会话头（看起来像"日志是空的"）。必须按魔数 `28 B5 2F FD` 的位置切帧，逐帧 `[offs[k], offs[k+1])` 解压再拼接。

2. **持久化是追加写**（`open(path, "a")` + `writeFile` + `sync`），不是整体重写。所以运行中改文件前部不会被后续写入覆盖；但内存里的会话仍是旧内容，务必按上面那个顺序做。

---

## 能改什么、不能改什么

| | 说明 |
|---|---|
| ✅ 任意历史位置的助手回复 | 按 seq 精确改写，角色仍是 assistant |
| ✅ 带工具调用的回复 | 只换 `text` 块，`tool-call` 块原样保留，工具配对不受影响 |
| ⚠️ 每次改写会清空该消息的思考块 | 界面里可勾选保留，命令行加 `--keep-reasoning` |
| ⚠️ 每次改写留一个 `.bak-<时间戳>` 备份 | 介意的话改完自行清理 |
| ❌ 不改界面已渲染的历史 | 界面等重启后从日志重建 |
| ❌ 不能改正在运行的内存会话 | 必须先退出 DSH |
| ❌ 只认 `session.v4` 格式 | DSH 升级改格式后，读取会直接报错退出，不会改坏文件 |

---

## 风险与注意事项

这是**直接改 DSH 的持久化数据**，请认真读这一节。

### 先退出 DSH

会话日志在磁盘上，但 DSH 内存里还握着旧的事件列表。边跑边改会让两边状态冲突——真实发生过一次「重启后这个会话加载不出来」，好在日志内容始终完整，用备份恢复即可。

### 每一次改写都会留备份

改写前会把原日志复制成 `<日志文件>.bak-<时间戳>`。出问题就把它改名覆盖回去：

```powershell
Copy-Item session.v4.jsonl.zstd.bak-1750000000000 session.v4.jsonl.zstd -Force
```

### 只在 DSH 侧栏重新加载后才生效

改写写入磁盘，但 DSH 正在运行的那个会话仍用内存里的旧内容。所以必须**重启 DSH**才能真正生效。

### 写回格式刻意模仿 DSH

DSH 的持久化后端（`@deepseek-ai/dsh-session-persistence-jsonl`）把日志写成「**每个批次一个带 checksum 的 zstd 帧**」拼成的多帧容器，而且 `scanZstdFrames()` 会逐字节解析帧结构、遇到不完整的尾部就**截断文件**。所以本工具写回时逐行独立成帧、并开启 `ZSTD_c_checksumFlag`，不改变日志的形状。可以自己验证：

```bash
npm run scan <日志文件>   # 用复刻的 DSH 扫描逻辑检查
```

### 隐私：`.edit-history.json` 不要外传

界面把每次改写的**原文副本**记在 `.edit-history.json` 里供回滚，所以它包含你的对话正文和本机绝对路径。它已在 `.gitignore` 中，也**不在**发行包里。

### 只认 `session.v4`

DSH 升级到 v5 改了格式的话，读取会直接报错退出，不会把文件改坏。

---

## 文件

| 文件 | 作用 |
|---|---|
| `start.cmd` | 双击启动图形界面（**纯 ASCII**，见下） |
| `start.ps1` | 实际启动逻辑：环境检查 + 启动服务（中文输出都在这里） |
| `server.mjs` | 本地 HTTP 服务（只监听 127.0.0.1）+ JSON 接口 + DSH 运行检测 |
| `web/index.html` | 单页界面（零依赖：原生 HTML/CSS/JS） |
| `tools/session-store.mjs` | 多帧 zstd 读写 + 会话发现 + 搜索 + 改写 + 回滚 |
| `tools/verify-log.mjs` | 用 DSH 自己的校验器离线验证日志与模型视角 |
| `tools/scan-frames.mjs` | 复刻 DSH 的 `scanZstdFrames`，判断文件在 DSH 眼里是否完整 |
| `tools/diag-frames.mjs` | 逐帧诊断：哪些帧可解、末尾有没有残留 |
| `tools/diag-missing.mjs` | 对比同一会话的多个版本，找出缺失的事件 |
| `tools/zstd-frames.mjs` | 多帧解析小工具（打印帧数、拼接长度、末尾事件） |
| `tools/surface-test.mjs` | 复现框架约束，解释为什么必须走文件方案 |
| `test/run-all.mjs` | 一次跑完所有测试 |
| `test/core.test.mjs`、`test/host.test.mjs` | 插件那半的逻辑回归测试 |
| `test/roundtrip.test.mjs` | 改写 → 回滚的往返测试（含思考块） |
| `GITHUB.md` | 上传到 GitHub 的完整步骤 |
| `.edit-history.json` | 界面改写历史，供回滚；**含对话正文，别外传** |

服务只监听回环地址，并拒绝任何非本机来源的请求，不向外暴露。

`verify-log.mjs` 与测试依赖 `@deepseek-ai/dsh-session@0.2.0-rc.2`（与本机 DSH 内部版本一致）。


---

## 一个编码上的坑（已修）

早期版本的 `start.cmd` 里写了中文注释和中文提示，双击后直接报一串乱码：

```
'Harness銆?setlocal' 不是内部或外部命令
```

原因：`.cmd` 文件是 UTF-8，而 cmd.exe 按**控制台代码页**（中文 Windows 上是 936/GBK）读取批处理文件，UTF-8 的中文字节被按 GBK 拆解后当成了命令去执行。

现在的做法：

1. `start.cmd` **保持纯 ASCII**（只有英文注释和 echo），这样命令行代码页随便怎么变都不会乱；
2. 真正的启动逻辑放进 `start.ps1`（UTF-8 由 PowerShell 自己处理，双击链路里由 `pwsh -File` 读取）；
3. `start.cmd` 先 `chcp 65001` 再启动 PowerShell，让 Node 的中文输出也能正常显示。

如果你想自己改 `start.cmd`：**别在里面写中文**。要加中文提示，加到 `start.ps1` 里。
