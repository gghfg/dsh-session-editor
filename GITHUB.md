# 上传到 GitHub

从零开始的完整步骤。假设你已经把这份代码放在 `C:\Users\Bob\software\develop\translation\dsh-session-editor`。

---

## 0. 先做一次隐私检查

这个项目会读写 DSH 的会话日志，所以仓库里**绝对不能**出现这两类东西：

| 不能提交 | 为什么 |
|---|---|
| `.edit-history.json` | 里面存着被改写回复的**正文副本**和你的本机绝对路径 |
| `node_modules/` | 几百个文件，别人 `npm install` 就能重建 |
| `*.bak-*` | 会话日志备份，含你的真实对话 |

我已经把这三类写进 `.gitignore` 了。提交前自己再确认一遍：

```powershell
cd dsh-session-editor
git status --short
# 输出里只要出现 .edit-history.json 或 node_modules，就停下来检查 .gitignore
```

再确认没有 token / 密码 / 用户名泄露：

```powershell
git grep -n -I -E "ghp_|github_pat_|sk-|password|api[_-]?key" -- . ':!package-lock.json'
```

`.gitignore` 里那行 `C:\Users\Bob\...` 不需要改——它不是敏感信息，只是告诉你别人机器上路径不同。

---

## 1. 配置 git 身份

只需做一次（你机器上已经有 `gghfg` / `2421233080@qq.com`，可跳过）：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"     # 建议与 GitHub 账号邮箱一致
git config --global init.defaultBranch main    # 新仓库默认分支叫 main
git config --global core.autocrlf false        # 别自动改换行符，跨平台更省心
```

---

## 2. 处理网络（国内常见）

GitHub 直连经常失败。**先试直连**，不通再加代理：

```powershell
# 只看当前有没有配代理
git config --global --get http.proxy

# 走本地代理（端口按你自己客户端改：Clash 常见 7890，v2ray 常见 10809）
git config --global http.proxy  http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890

# 以后不想用代理了就取消
git config --global --unset http.proxy
git config --global --unset https.proxy
```

如果 SSH 的 22 端口被墙，用 443 端口代替，在 `~/.ssh/config` 里加：

```
Host github.com
  HostName ssh.github.com
  Port 443
  User git
```

---

## 3. 在 GitHub 上建一个空仓库

1. 打开 https://github.com/new
2. **Repository name**：`dsh-session-editor`
3. **Description**（可选）：`Graphical editor for DeepSeek Harness session logs — rewrite assistant replies`
4. **Public** 或 **Private** 都行；想分享就选 Public
5. **不要**勾选 `Add a README file`、`.gitignore`、`license` —— 我们已经有了，勾了反而要处理冲突
6. 点 **Create repository**

---

## 4. 登录凭据：推荐 Personal Access Token

GitHub 从 2021 年起**不接受账号密码**推送，要用 Token 或 SSH。

### 用 Token（HTTPS，最简单）

1. 打开 https://github.com/settings/tokens
2. **Generate new token** → **Fine-grained token**（或经典 token）
3. 名字随便填，有效期选个合适的，权限勾 **`repo`**（经典 token）或 **Contents: Read and write**（细粒度）
4. 生成后**立刻复制**那串 `ghp_...`，关掉页面就再也看不到了

推送时把它当密码用：

```powershell
# 提示 Username 时填 GitHub 用户名，提示 Password 时粘贴 token
git push -u origin main
```

Windows 上通常会自动弹出凭据管理器窗口，选 **Token** 粘贴进去即可，之后会记住。

### 或用 SSH（配一次，长期免密）

```powershell
ssh-keygen -t ed25519 -C "2421233080@qq.com"
# 一路回车；想设密码也行

# 把公钥内容复制到剪贴板
Get-Content ~\.ssh\id_ed25519.pub | Set-Clipboard
```

粘贴到 https://github.com/settings/keys → **New SSH key**。测试：

```powershell
ssh -T git@github.com
# 看到 "Hi <用户名>! You've successfully authenticated" 就成了
```

---

## 5. 初始化并推送

```powershell
cd C:\Users\Bob\software\develop\translation\dsh-session-editor

git init
git add .
git status --short          # ← 再确认一次：没有 .edit-history.json / node_modules
git commit -m "feat: DSH 会话日志图形编辑器

- 图形界面浏览会话、搜索回复、改写、一键回滚
- 多帧 zstd 容器正确读写（逐帧 [start,end) 解压）
- 写回严格模仿 DSH 的编码：逐行独立帧 + checksum
- 回滚用原始块快照整体还原，思考块不会丢
- 用 DSH 自己的恢复校验器离线验证日志
- 归档会话可见性标记，解释「记录找不到」"

# 关联远程仓库（把 <你的用户名> 换掉）
git remote add origin https://github.com/<你的用户名>/dsh-session-editor.git
git branch -M main
git push -u origin main
```

推完刷新仓库页面，应该能看到全部文件。

---

## 6. 把 README 里的占位符换掉

README 的「快速开始」里写着：

```bash
git clone https://github.com/<你的用户名>/dsh-session-editor.git
```

换成真实地址后提交：

```powershell
# 编辑 README.md 后
git add README.md
git commit -m "docs: 填上仓库地址"
git push
```

---

## 7. 以后再更新代码

```powershell
git status                     # 看改了什么
git add -A
git commit -m "fix: 说明这次改了什么"
git push
```

只想改一个文件时更省事：

```powershell
git commit -am "fix: 修正 xxx"   # 跳过 git add（仅对已跟踪的文件有效）
git push
```

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `failed to push some refs` / `rejected` | 远程有你本地没有的提交。先 `git pull --rebase origin main` 再 `git push` |
| `remote: Support for password authentication was removed` | 用了账号密码。改用 Token 或 SSH（见第 4 步） |
| `Failed to connect to github.com` / 超时 | 网络问题。配代理或走 SSH 443（见第 2 步） |
| `Permission denied (publickey)` | SSH 公钥没加到 GitHub，或 `ssh-agent` 没跑 |
| 误把 `.edit-history.json` 提交了 | 见下方「如果误提交了」 |
| `LF will be replaced by CRLF` | 只是警告。想彻底避免就设 `git config --global core.autocrlf false` |
| 提交里出现 `node_modules` | `.gitignore` 没生效。执行 `git rm -r --cached node_modules` 后再提交 |

### 如果误提交了敏感文件

仅仅删掉文件再提交**不够**，历史里还留着。最干净的做法是把它从所有历史中抹掉：

```powershell
# 1) 先撤销跟踪并加进 .gitignore
git rm --cached .edit-history.json
# 2) 用 filter-repo 重写历史（需先安装 git-filter-repo）
git filter-repo --path .edit-history.json --invert-paths
# 3) 强制推送
git push --force
```

如果 Token 之类**真的**泄露了，第一件事是去 GitHub **撤销那个 Token**，而不是只改代码。

---

## 附：这个仓库里没有的东西

发行压缩包 `dsh-session-editor-v0.1.0.zip`（43 KB）包含运行所需的一切，**不含** `node_modules` 和 `.edit-history.json`。别人拿到后：

```bash
unzip dsh-session-editor-v0.1.0.zip
cd dsh-session-editor
npm install     # 可选，只为校验与测试
node server.mjs # 或双击 start.cmd
```
