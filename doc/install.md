# install.md — EC2 软件与依赖安装清单（pt-ai-acquisition-cause）

> 依据：prepare.md §6 采集结果（2026-09-29，`prod-ai-cause-01` / m7g.xlarge / ap-southeast-1）
> 使用方式：按顺序执行 §3 的 8 个命令块，**每块整段复制**到 JumpServer 会话执行，把完整输出（含报错）贴回。
> 安全性：块内命令均幂等或带存在性判断，可重复执行；当前无任何业务容器在跑，本阶段不碰业务与数据。
> 除终验证块外全部以 `sudo`（ec2-user 免密）执行。
> 本阶段**不涉及**：镜像构建、compose 启动、数据库迁移、ALB 注册（属 deploy 阶段）；也**不需要**模型网关 / Keycloak / Adjust 凭据。

---

## 1. 采集结果判定与安装决策

结论：prepare.md §6 信息**足够开始安装**。逐项决策：

| 采集事实 | 本阶段决策 |
| --- | --- |
| Amazon Linux 2023.12 / aarch64（Graviton） | compose 插件取 `docker-compose-linux-aarch64`；后续镜像一律 `linux/arm64` |
| Docker 25.0.16 daemon 正常，`docker pull hello-world` 成功 | Docker 本体不重装不升级（由 AL2023 dnf 通道维护补丁） |
| dnf 仓库无 compose 包；`/usr/libexec/docker/cli-plugins/` 只有 buildx | 从 GitHub Releases 手动安装 compose v2 插件到该目录 |
| 出站经 NAT（出口 52.221.122.199），Docker Hub / GitHub 域名可解析 | 直连 GitHub 下载；块 2 内置连通性检查，失败走 §5 回退 |
| `ec2-user` 免密 sudo，不在 docker 组（组已存在，gid 993） | `usermod -aG docker`，**重新登录后**免 sudo 使用 docker |
| 数据盘 `/dev/nvme1n1` 50G xfs 挂在 `/srv/cause`（空、root:root） | 建目录骨架：pgdata + 三个业务目录 + 源码目录，属主对齐容器 UID |
| 无 daemon.json → 容器日志 json-file 无大小上限 | 写入生产配置：`max-size 50m × 5` + `live-restore` |
| 无 swap（内存 15G） | 建 4G swapfile + `vm.swappiness=10`，作镜像构建期 OOM 保险 |
| 宿主机无 git（curl 8.21 / tar 1.34 已有） | dnf 安装 git（源码分发用）与 jq（后续验证解析 JSON 用） |
| 80/443/3100/5432 全空闲；datakit 占用 127.0.0.1:6060/9529 | 无端口冲突；避开 6060/9529，**不动 datakit** |
| fstab 是否包含 `/srv/cause` 未确认 | 块 5 检查并按需补写（UUID + nofail），防重启后数据盘丢失 |
| SELinux Permissive；无 ufw / firewalld；chronyd active（UTC） | 无需处理；Adjust 时区由 `ADJUST_RS_UTC_OFFSET=+08:00` 显式控制 |

**不阻塞本阶段、但 deploy 前必须补齐**（继续并行推进，见 prepare.md §6.11）：

- ALB `cause.pmdevops.com` → 10.163.138.182 当前 502：控制台确认监听器 → 目标组 → 健康检查路径与端口（健康检查路径我在 deploy 阶段给出）
- 安全组入站：ALB→实例 3100 放通范围；5432 不得对公网开放
- 凭据：模型网关 / Keycloak realm / Access internal / `ADJUST_API_TOKEN`

---

## 2. 安装清单总览

| # | 块 | 内容 | 预期结果 |
| --- | --- | --- | --- |
| 1 | §3.1 | dnf 安装 git + jq | `git version` ≥ 2.40、`jq` 有版本输出 |
| 2 | §3.2 | GitHub 下载安装 Docker Compose v2 插件（aarch64） | `docker compose version` 输出 v2.x |
| 3 | §3.3 | ec2-user 加入 docker 组 | `id` 出现 `docker(993)`（需重新登录） |
| 4 | §3.4 | `/srv/cause` 目录骨架与属主 | 5 个目录，属主 1000 / 999 / 1000×4 |
| 5 | §3.5 | fstab 持久化检查（按需补写） | 「已在 fstab」或「已追加 UUID 行」 |
| 6 | §3.6 | 4G swapfile + swappiness=10 | `swapon --show` 显示 /swapfile 4G |
| 7 | §3.7 | daemon.json（日志轮转 + live-restore）并重启 docker | `docker info` 显示 json-file + Live Restore: true |
| 8 | §4 | 终验证（**新会话**，普通用户） | 全绿清单，见 §4 |

执行顺序：1 → 7 依次执行；块 8 之前**退出 JumpServer 会话重新登录**（docker 组生效前提）。

---

## 3. 安装命令块

### 块 1 — dnf 安装 git 与 jq

```bash
sudo bash <<'STEP1'
echo "===== [1.1] 安装 git ====="
dnf install -y git || { echo "!! git 安装失败"; exit 1; }
git --version
echo
echo "===== [1.2] 安装 jq（验证阶段解析 JSON 用） ====="
if dnf install -y jq; then
  jq --version
else
  echo "!! jq 安装失败（不阻塞部署，仅影响后续部分验证命令）"
fi
echo "===== [RC] $? ====="
STEP1
```

预期：`git version 2.4x.x` 与 `jq-1.x`。若 dnf 报仓库错误，执行 `dnf repolist enabled` 贴回给我。

### 块 2 — Docker Compose v2 插件（aarch64）

```bash
sudo bash <<'STEP2'
echo "===== [2.1] GitHub 连通性 ====="
curl -s -m 10 -o /dev/null -w 'https://github.com -> HTTP %{http_code}\n' https://github.com/ || echo "!! github.com 不可达：停止本块，改用 §5.1 本地下传方案"
echo
echo "===== [2.2] 查询最新稳定版本号 ====="
COMPOSE_VER=$(curl -s -m 15 https://api.github.com/repos/docker/compose/releases/latest | sed -n 's/.*"tag_name": *"v\([0-9.][0-9.]*\)".*/v\1/p' | head -n1)
[ -n "$COMPOSE_VER" ] || COMPOSE_VER="latest"
echo "版本: $COMPOSE_VER"
echo
echo "===== [2.3] 下载二进制（linux-aarch64） ====="
TMP=$(mktemp -d)
if [ "$COMPOSE_VER" = "latest" ]; then
  BASE="https://github.com/docker/compose/releases/latest/download"
else
  BASE="https://github.com/docker/compose/releases/download/$COMPOSE_VER"
fi
curl -fSL --retry 3 -m 600 -o "$TMP/docker-compose-linux-aarch64" "$BASE/docker-compose-linux-aarch64" \
  || { echo "!! 下载失败：改用 §5.1 本地下传方案"; exit 1; }
ls -lh "$TMP/docker-compose-linux-aarch64"
echo
echo "===== [2.4] sha256 校验（软校验，功能验证是最终判据） ====="
if curl -fsSL -m 60 -o "$TMP/dc.sha256" "$BASE/docker-compose-linux-aarch64.sha256"; then
  if (cd "$TMP" && sha256sum -c dc.sha256); then
    echo "校验通过"
  else
    echo "!! sha256 不匹配（文件名或格式差异也会导致，继续以功能验证为准）"
  fi
else
  echo "(未获取到校验文件，跳过)"
fi
echo
echo "===== [2.5] 安装到 cli-plugins 目录 ====="
install -m 0755 "$TMP/docker-compose-linux-aarch64" /usr/libexec/docker/cli-plugins/docker-compose
rm -rf "$TMP"
ls -lh /usr/libexec/docker/cli-plugins/
echo
echo "===== [2.6] 功能验证 ====="
docker compose version || { echo "!! compose 插件不可用"; exit 1; }
echo "===== [RC] $? ====="
STEP2
```

预期：最后输出 `Docker Compose version v2.x.x`。安装位置选 `/usr/libexec/docker/cli-plugins/`（与现有 buildx 同目录，AL2023 的 docker CLI 会搜索该路径）。

### 块 3 — ec2-user 加入 docker 组

```bash
sudo bash <<'STEP3'
echo "===== [3.1] 变更前 ====="
id ec2-user
echo
usermod -aG docker ec2-user
echo "===== [3.2] 变更后 ====="
id ec2-user
echo
echo "说明：需退出 JumpServer 会话重新登录后，docker 组才对普通 docker 命令生效"
echo "安全提示：docker 组等价于 root 权限；ec2-user 本就有免密 sudo，未引入新的提权面"
echo "===== [RC] $? ====="
STEP3
```

预期：groups 列表出现 `docker(993)`。当前会话内后续块仍统一带 `sudo`，不受影响。

### 块 4 — /srv/cause 目录骨架与属主

容器内 UID 约定：应用容器以 `node` 用户运行（node 官方镜像 UID=1000，与宿主机 ec2-user 一致）；postgres 容器官方用户 UID=999。属主按此预对齐，bind mount 后容器进程可直接读写。

```bash
sudo bash <<'STEP4'
echo "===== [4.1] 创建目录骨架 ====="
# 应用源码与 compose/.env（部署阶段上传）
mkdir -p /srv/cause/app
# PostgreSQL 数据目录（compose 阶段以 bind 卷挂给 postgres 容器）
mkdir -p /srv/cause/pgdata
# 三个业务持久化目录（知识图谱 / 导出图 / 投递记录）
mkdir -p /srv/cause/research-graph
mkdir -p /srv/cause/exports
mkdir -p /srv/cause/deliveries
chown 1000:1000 /srv/cause/app /srv/cause/research-graph /srv/cause/exports /srv/cause/deliveries
chown 999:999 /srv/cause/pgdata
chmod 700 /srv/cause/pgdata
echo
echo "===== [4.2] 确认 ====="
ls -lan /srv/cause/
echo "===== [RC] $? ====="
STEP4
```

预期：`app`/`research-graph`/`exports`/`deliveries` 属主 `1000 1000`，`pgdata` 属主 `999 999` 且权限 `drwx------`。

说明：pgdata 放数据盘（而非 docker 默认卷）是对 prepare.md §6.10 草案的微调——数据库是唯一持续增长的资产，放专用数据盘后，一张 EBS 快照即可覆盖全部业务状态（DB + 三个文件目录），系统盘只承担 OS 与镜像。

### 块 5 — fstab 持久化检查（防重启丢数据盘）

```bash
sudo bash <<'STEP5'
echo "===== [5.1] 当前挂载来源 ====="
findmnt /srv/cause
echo
echo "===== [5.2] /etc/fstab 原文 ====="
cat /etc/fstab
echo
echo "===== [5.3] 判定与补写 ====="
if grep -qE '[[:space:]]/srv/cause[[:space:]]' /etc/fstab; then
  echo "OK: /srv/cause 已在 fstab，无需处理（若按设备名 /dev/nvme1n1 写入也可接受，请贴回 5.2 原文由我确认）"
else
  UUID=$(findmnt -no UUID /srv/cause)
  if [ -z "$UUID" ]; then
    echo "!! 取不到数据盘 UUID，请把 5.2 的 fstab 原文贴回人工处理"
  else
    cp -a /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
    echo "UUID=$UUID  /srv/cause  xfs  defaults,nofail  0 0" >> /etc/fstab
    echo "已追加（原 fstab 已备份）：UUID=$UUID  /srv/cause  xfs  defaults,nofail  0 0"
  fi
fi
echo
echo "===== [5.4] fstab 全量语法校验 ====="
findmnt --verify
echo "===== [RC] $? ====="
STEP5
```

预期：「OK: 已在 fstab」或「已追加 UUID=…」，且 `findmnt --verify` 无 ERROR。

### 块 6 — 4G swapfile（构建期 OOM 保险）

用途：本机无 swap，15G 内存跑生产够，但 `next build`（arm64 原生构建）峰值高，swap + `swappiness=10` 只在内存耗尽临界时兜底，不影响 PostgreSQL 常态性能。

```bash
sudo bash <<'STEP6'
echo "===== [6.1] 现状 ====="
swapon --show || true
free -h | grep -i swap
echo
echo "===== [6.2] 创建 /swapfile 4G ====="
if [ -f /swapfile ]; then
  echo "/swapfile 已存在，跳过创建"
else
  dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress
  chmod 600 /swapfile
  mkswap /swapfile
fi
if swapon --show | grep -q '/swapfile'; then
  echo "swap 已激活"
else
  swapon /swapfile
fi
echo
echo "===== [6.3] 开机自动挂载 ====="
grep -q '^/swapfile' /etc/fstab || echo '/swapfile  none  swap  sw  0 0' >> /etc/fstab
grep '/swapfile' /etc/fstab
echo
echo "===== [6.4] swappiness=10 ====="
printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-cause-swap.conf
sysctl -w vm.swappiness=10
echo
echo "===== [6.5] 验证 ====="
swapon --show
free -h
echo "===== [RC] $? ====="
STEP6
```

预期：`swapon --show` 显示 `/swapfile ... 4G`，`free -h` Swap 行 total 4.0Gi。`dd` 约需 10–30 秒。

### 块 7 — daemon.json（日志轮转 + live-restore）并重启 docker

背景：当前无 daemon.json，容器日志 json-file **无大小上限**，长跑会写满磁盘；`live-restore` 让 daemon 升级/重启时容器不中断（单实例生产的重要保障）。

```bash
sudo bash <<'STEP7'
echo "===== [7.1] 现有配置 ====="
cat /etc/docker/daemon.json 2>/dev/null || echo "(不存在，将创建)"
echo
echo "===== [7.2] 写入生产配置 ====="
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  },
  "live-restore": true
}
JSON
cat /etc/docker/daemon.json
echo
echo "===== [7.3] JSON 语法校验并重启 docker ====="
python3 -m json.tool /etc/docker/daemon.json >/dev/null && echo "JSON 语法 OK" || { echo "!! JSON 语法错误，停止"; exit 1; }
systemctl restart docker
sleep 3
systemctl is-active docker || { systemctl status docker --no-pager -l | head -n 20; exit 1; }
echo
echo "===== [7.4] 验证生效 ====="
docker info 2>/dev/null | grep -iE 'Logging Driver|Live Restore' || true
echo "===== [RC] $? ====="
STEP7
```

预期：输出 `Logging Driver: json-file` 与 `Live Restore Enabled: true`。当前无容器运行，restart 无业务影响。

---

## 4. 终验证（新会话执行）

> **先退出 JumpServer 会话并重新登录**（块 3 的 docker 组此时才生效），然后整段执行：

```bash
bash <<'VERIFY'
echo "===== [V1] docker / compose 版本 ====="
sudo docker --version
sudo docker compose version
echo
echo "===== [V2] 当前用户组（应含 docker） ====="
id
echo
echo "===== [V3] 免 sudo 直连 docker ====="
docker ps 2>&1 | head -n 3
echo
echo "===== [V4] git / jq ====="
git --version
jq --version 2>/dev/null || echo "jq 未装（此前块 1 有提示则可接受）"
echo
echo "===== [V5] /srv/cause 目录骨架 ====="
ls -lan /srv/cause/
echo
echo "===== [V6] fstab 持久化 ====="
grep -E 'srv/cause|swapfile' /etc/fstab
findmnt --verify 2>&1 | grep -i error || echo "fstab 校验通过（无 error）"
echo
echo "===== [V7] swap ====="
swapon --show
free -h | tail -n 2
echo
echo "===== [V8] daemon.json 与 docker info ====="
sudo cat /etc/docker/daemon.json
sudo docker info 2>/dev/null | grep -iE 'Logging Driver|Live Restore'
echo
echo "===== [V9] 运行时冒烟（复跑 hello-world） ====="
sudo docker run --rm hello-world 2>&1 | sed -n '1,5p'
echo
echo "===== [V10] datakit 未受影响 ====="
ss -tln | grep -E ':(6060|9529) ' && echo "datakit 端口仍在" 
echo "===== [RC] $? ====="
VERIFY
```

全部符合预期后，安装阶段完成。任何一项不符，把该段输出贴回给我再继续。

---

## 5. 已知问题与回退方案

### 5.1 GitHub 不可达（块 2 失败时）

在你的 Mac 本地执行下载，经 JumpServer 文件上传功能传到服务器家目录，再安装：

```bash
# 本地 Mac：
curl -L -o docker-compose-linux-aarch64 https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64
# 上传后在服务器执行：
sudo install -m 0755 ~/docker-compose-linux-aarch64 /usr/libexec/docker/cli-plugins/docker-compose
docker compose version
```

### 5.2 dnf 仓库异常（块 1 失败时）

执行 `sudo dnf repolist enabled` 与 `sudo dnf makecache`，把输出贴回；git 非硬依赖（源码可走 tar 包上传），jq 可跳过。

### 5.3 fstab 特殊情况

若 `/srv/cause` 已按设备名 `/dev/nvme1n1` 写入 fstab：AL2023/Nitro 下 EBS 设备名稳定，可接受；但更稳妥是换 UUID，把 5.2 原文贴回我来判断，不自行改写。

### 5.4 swap 创建失败

磁盘或权限异常时不阻塞整体（内存 15G 本身够跑生产），跳过并在回贴结果中注明即可；构建期 OOM 风险届时改用本地构建 + save/load 分发规避。

### 5.5 docker 重启后异常（块 7）

极小概率：`daemon.json` 与 AL2023 打包的 docker 25 不兼容（理论不会）。回退：`sudo rm /etc/docker/daemon.json && sudo systemctl restart docker`，贴回 `systemctl status docker --no-pager -l` 输出。

---

## 6. 下一步（deploy.md，等块 1–8 输出确认后给出）

1. **Dockerfile**（node:24-bookworm-slim 基座，arm64 原生构建，非 root 运行）与 **docker-compose.prod.yml**（app + postgres 两个服务；postgres 不映射宿主机端口，pgdata bind 到 `/srv/cause/pgdata`，三个业务目录 bind mount；资源限制 app 4G / PG 6G；healthcheck）
2. **源码分发**：优先方案 A（git 或 tar 上传后在服务器构建，arm64 天然匹配）；`.env` 生产模板（`AUTH_SECRET` 与数据库口令的生成命令）
3. **启动与迁移**：`docker compose up -d` → `prisma migrate deploy`（离线迁移工作流）→ 首次数据确认
4. **ALB 接入**：健康检查路径与目标组注册（需你先从控制台拿到 §1 遗留项）
5. **verify.md**：登录链路（OIDC 回调）、核心 API、SSE 流式、数据库与三个持久化目录逐项验证

---

## 7. 安装与验证结果（2026-09-29 执行完成）

> 执行对象：`prod-ai-cause-01`（`ec2-user@10.163.141.20`），全程通过 JumpServer Web CLI 执行
> **结论：§3 的 7 个安装块与 §4 终验证全部通过，安装阶段完成**，可进入 deploy 阶段。

### 7.1 各块结果

| # | 块 | 结果 |
| --- | --- | --- |
| 1 | dnf 安装 git + jq | ✅ `git 2.50.1` 新装（连带 git-core/perl 共 8 包，8.1 M）；`jq 1.8.1` **已是最新**（Nothing to do） |
| 2 | Docker Compose v2 插件 | ✅ 取 GitHub latest = **v5.5.1**，下载 28.83 MB，sha256 `OK`，装入 `/usr/libexec/docker/cli-plugins/`；`docker compose version` 正常 |
| 3 | ec2-user 加入 docker 组 | ✅ groups 追加 `993(docker)` |
| 4 | `/srv/cause` 目录骨架 | ✅ `app`/`research-graph`/`exports`/`deliveries` = `1000:1000`；`pgdata` = `999:999` `drwx------` |
| 5 | fstab 持久化 | ✅ `/srv/cause` **已存在**（UUID `9848f90b-a87c-48c7-a644-49d425de3900`，`xfs defaults`）；`findmnt --verify` 0 error（5 warning） |
| 6 | 4G swapfile | ✅ `/swapfile` 4G 已激活（dd 4096 MiB，11 s / 387 MB/s），已写入 fstab，`vm.swappiness=10` |
| 7 | daemon.json + 重启 docker | ✅ 写入 `json-file(max-size 50m, max-file 5)` + `live-restore=true`；JSON 校验通过，重启后 `active`，`docker info` 已生效 |
| 8 | §4 终验证 | ✅ 全绿，见 §7.3 |

### 7.2 执行中发现的两个环境事实（影响 deploy 阶段）

1. **JumpServer 会复用 SSH 连接，导致用户组变更"看起来不生效"**
   块 3 改完 docker 组后，我按 §4 先新开了一个 Web CLI 会话，但它提示
   `复用SSH连接（prod-ai@10.163.141.20）[连接数量: 2]`，此时 `id` 里**仍没有 docker 组**、免 sudo `docker ps` 依旧 `permission denied`。
   原因：OpenSSH 的补充组是在**连接建立时**由 sshd 的 privsep 子进程（`sshd-session: ec2-user [priv]`）一次性 `initgroups` 定下的，同一连接上的新 channel 直接复用这份凭据 —— JumpServer 的「SSH 连接复用」正好命中这一行为。
   把目标机上那条复用连接的 sshd 进程 kill 掉、重新连接（拿到全新 `ssh` 登录横幅 + `Last login` 更新）后，验证全部通过：`groups=...,993(docker)`、免 sudo `docker ps` 正常。
   → **后续凡是改了用户/组/权限或需要重新读 `/etc/group` 的场景，都必须断开旧连接（必要时在服务器上 `kill` 掉对应 `sshd-session`）再重连**，否则会误判为"改了不生效"。
2. **`/srv/cause` 的 fstab 条目缺 `nofail`**
   当前是 `UUID=… /srv/cause xfs defaults 0 0`。数据盘若未能挂上，systemd 会进入 emergency mode（对无人值守的生产机不友好）。建议实施阶段改为 `defaults,nofail`。本次未改动，避免超出安装阶段范围。

### 7.3 §4 终验证原文输出（新会话 / 普通用户，未使用 sudo 调 docker）

> 末尾的 `===== [RC] 0 =====` 是块内自带的退出码输出；采集包装脚本额外追加的 `[WRAPPER-RC]` 已省略。

```text
===== [V1] docker / compose 版本 =====
Docker version 25.0.14, build 0bab007
Docker Compose version v5.5.1

===== [V2] 当前用户组（应含 docker） =====
uid=1000(ec2-user) gid=1000(ec2-user) groups=1000(ec2-user),4(adm),10(wheel),190(systemd-journal),993(docker) context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023

===== [V3] 免 sudo 直连 docker =====
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES

===== [V4] git / jq =====
git version 2.50.1
jq-1.8.1

===== [V5] /srv/cause 目录骨架 =====
total 0
drwxr-xr-x. 7    0    0 86 Sep 29 03:15 .
drwxr-xr-x. 3    0    0 19 Sep 28 08:17 ..
drwxr-xr-x. 2 1000 1000  6 Sep 29 03:15 app
drwxr-xr-x. 2 1000 1000  6 Sep 29 03:15 deliveries
drwxr-xr-x. 2 1000 1000  6 Sep 29 03:15 exports
drwx------. 2  999  999  6 Sep 29 03:15 pgdata
drwxr-xr-x. 2 1000 1000  6 Sep 29 03:15 research-graph

===== [V6] fstab 持久化 =====
UUID="9848f90b-a87c-48c7-a644-49d425de3900"  /srv/cause   xfs    defaults  0  0
/swapfile  none  swap  sw  0 0
0 parse errors, 0 errors, 5 warnings

===== [V7] swap =====
NAME      TYPE SIZE USED PRIO
/swapfile file   4G   0B   -2
Mem:            15Gi       436Mi       9.6Gi       0.0Ki       5.3Gi        14Gi
Swap:          4.0Gi          0B       4.0Gi

===== [V8] daemon.json 与 docker info =====
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  },
  "live-restore": true
}
 Logging Driver: json-file
 Live Restore Enabled: true

===== [V9] 运行时冒烟（复跑 hello-world） =====

Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:

===== [V10] datakit 未受影响 =====
LISTEN 0      4096       127.0.0.1:6060       0.0.0.0:*
LISTEN 0      4096       127.0.0.1:9529       0.0.0.0:*
datakit 端口仍在
===== [RC] 0 =====
```

### 7.4 备注

- `docker --version` 显示 `25.0.14` 而 `docker info` 显示 `Server Version: 25.0.16`：`rpm -q docker` 为 `docker-25.0.16-1.amzn2023.0.4.aarch64`，同一个包内 CLI 与 daemon 的版本字符串写法不同（`docker version` 实测 `25.0.14 / 25.0.16`），不影响功能，compose 插件已被正确识别。
- 服务器上遗留 `/tmp/jms_i*.sh` 与 `/tmp/jms_i*.out`（本次安装/验证的脚本与输出），可随时删除。
- 安装阶段未触碰业务容器与数据；`datakit`（127.0.0.1:6060/9529）全程未受影响。
