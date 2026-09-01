# ⏪ dsh-rewind-file

**dsh 回退会话时,一并恢复工作区文件。**

dsh 的 `/rewind`(以及双击 Esc)只会回退*对话*——它把会话 fork 回更早的消息,但
磁盘上的*文件*原封不动。本插件补上这一半:回退时文件也跟着回来。**不新增任何
命令**,直接挂在现有 `/rewind` 上。

## 原理(opencode 机制,原样移植)

opencode 的 `undo`/`redo` 建立在每个项目一个独立裸 git 仓库之上
(`packages/opencode/src/snapshot/index.ts`)。本插件移植这套设计并接入 dsh 的
回退流程:

| opencode 原语 | dsh-rewind-file 对应 |
|---|---|
| 快照仓库 `data/snapshot/<project>/<hash>` | `$DSH_HOME/rewind-file/<16位hex>/repo.git` |
| `track()` = `git add --all` + `git write-tree` | 同左 —— 内容寻址的**树 hash** |
| `patch(hash)` = `git diff --cached --name-only <hash>` | 同左 —— 相对某树的变更文件 |
| `revert(patches)` = `git checkout <tree> -- <file>` + 删除边界后新建的文件 | 同左 —— 真正的回退会删掉边界后新建的文件 |

两个钩子完成工作:

1. **`session/event` → `step/end`** —— 每个助手步骤结束时,捕获工作区快照
   (树 hash),按该步骤的 `seq` 索引。
2. **`session/created`** —— 当 harness 发布一个 fork/回退子会话时
   (`header.parentSession` + `header.seedLength` = 回退边界),把文件恢复到
   该边界处或之前的最新快照。

git 仓库只运行白名单内、无副作用的动词(`init`、`config`、`add`、`write-tree`、
`diff`、`ls-tree`、`checkout`、`read-tree` …),绝不碰用户仓库、索引或历史。

## 行为

- **无命令、无快捷键、无需学配置** —— 装好照常 `/rewind`,文件跟着对话走。
- 快照树存于 git 对象,seq→树索引存于仓库旁的小 JSON 文件,无需宿主存储栈。
- 回退会恢复被修改/删除的文件,**并删除边界之后新建的文件** —— 工作区精确回到
  回退点(opencode 的"真撤销"语义)。
- 快照在 `step/end` 捕获,因此回退到回合边界会恢复到上一回合最后一步之后的状态;
  树视图的回合内回退则恢复到保留步骤结束时的状态。

## 安装

```sh
dsh plugin --profile tui add /path/to/dsh-rewind-file
# 重启 profile 后验证:
dsh --profile tui --dump-config | grep -A8 'id: dsh-rewind-file'
```

发布到 npm 后可用 `dsh plugin --profile tui add dsh-rewind-file` 安装。
卸载用 `dsh plugin --profile tui remove dsh-rewind-file`;快照数据保留,删除
`$DSH_HOME/rewind-file` 目录即彻底清除。

## 配置

`cordis.patch.yml` 中的普通 config 键:

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `gitBin` | `git` | git 可执行文件 |
| `snapshotDir` | `''` | 快照根目录;空 → `$DSH_HOME/rewind-file`(回退 `~/.dsh/rewind-file`) |
| `excludeGlobs` | `['node_modules','.git','.dsh','dist','build']` | `git add` 跳过的模式(gitignore 语义) |
| `maxSnapshots` | `500` | 每会话保留的快照条数 |

## 安全

- **仅白名单 git 动词** —— 运行时断言拒绝 `reset`、`clean`、`stash`、`rm` 等破坏性动词。
- **绝不碰你的仓库** —— 专用裸仓库存树,你的 `.git`、索引与历史毫发无损。
- **`.gitignore` 感知** —— `git add --all` 尊重工作区的 `.gitignore` 与插件的 `excludeGlobs`。
- **大声失败、绝不阻断** —— 快照或恢复失败只记日志,绝不打断回退或正在运行的工具。

## 为何不复用 dsh-checkpoint-rewind

那个插件做三态检查点(工作区 + 会话 + 配置),且**从不删除**检查点之后新建的文件。
opencode 的 `undo` 会删除快照之后新建的文件,本插件刻意保留这一语义 —— 回退把
工作区精确还原到被回退回合之前,包括被删除的文件。

## License

MIT
