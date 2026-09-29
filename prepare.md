# prepare.md — EC2 部署前准备清单（pt-ai-acquisition-cause）

> 用途：在目标 EC2 上采集环境事实，用于确定部署方案（镜像构建位置、compose 配置、资源限制、端口与网络规划）。
> 使用方式：第 2 节共 6 个命令块，**逐块整段复制**到服务器 SSH 会话执行，把每块的**完整输出（含报错）**原样贴回。
> 所有命令均为只读探测，不会改动服务器；仅块 6 需要 sudo（会提示输密码）。
> 若长粘贴出现错乱，按块内行逐条执行即可，结果等效。

---

## 1. 目标部署形态（为什么查这些）

单台 EC2 同机部署，Docker 运行两个容器：

| 项 | 计划 |
| --- | --- |
| 应用容器 | Next.js（node:24-bookworm-slim 基座），监听 **3100**；仓库目前**没有** Dockerfile，部署阶段我会补 |
| 数据库容器 | `pgvector/pgvector:pg17`（PostgreSQL 17 + pgvector），**不映射宿主机端口**，仅容器内网可达（与仓库现有开发用 docker-compose.yml 不同，生产另给 docker-compose.prod.yml） |
| 数据持久化 | pgdata 命名卷 + 三个本地目录 bind mount：`data/research-graph/`（知识图谱）、`public/exports/`（导出图）、`.deliveries/`（投递记录）——这些状态不在数据库里 |
| 外部依赖 | 大模型网关、PT AI Access（Keycloak）、Adjust API 全部为外部 HTTP 调用，服务器**无需 GPU**，只需出站连通 |
| 对外入口 | 既定域名 `https://cause.pmdevops.com/`（走 ALB 或反代，需确认现状）；SSE 接口要求代理关闭缓冲 |

---

## 2. 服务器信息采集命令

### 块 1：系统与硬件

```bash
bash <<'SYSINFO'
echo "===== [1.1] 操作系统与内核 ====="
grep -E '^(PRETTY_NAME|NAME|VERSION_ID|ID)=' /etc/os-release 2>/dev/null
uname -mrs
echo
echo "===== [1.2] CPU ====="
echo -n "vCPU 数: "; nproc
lscpu 2>/dev/null | grep -iE '^(Architecture|Model name|CPU\(s\)|Hypervisor vendor)' || true
echo
echo "===== [1.3] 内存 ====="
free -h
echo
echo "===== [1.4] 时区与时间同步 ====="
timedatectl 2>/dev/null || date
echo
echo "===== [1.5] 当前用户与 sudo 权限 ====="
whoami
id
sudo -n true 2>/dev/null && echo "sudo: 免密可用" || echo "sudo: 需要密码（或无 sudo）"
echo
echo "===== [1.6] EC2 元数据（实例类型 / 区域） ====="
TOKEN=$(curl -s -m 2 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null)
if [ -n "$TOKEN" ]; then
  printf 'instance-type: %s\n' "$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-type)"
  printf 'region: %s\n'        "$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"
else
  echo "IMDSv2 不可达，尝试 IMDSv1："
  curl -s -m 2 http://169.254.169.254/latest/meta-data/instance-type || echo "IMDS 均不可达（需从 AWS 控制台人工提供）"
fi
SYSINFO
```

### 块 2：磁盘与数据卷

```bash
bash <<'DISKINFO'
echo "===== [2.1] 文件系统使用量 ====="
df -hT -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -hT
echo
echo "===== [2.2] 块设备与挂载点 ====="
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT 2>/dev/null || lsblk
echo
echo "===== [2.3] swap ====="
swapon --show 2>/dev/null || echo "无 swap"
DISKINFO
```

### 块 3：Docker 现状

```bash
bash <<'DOCKERINFO'
echo "===== [3.1] Docker 安装与版本 ====="
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version 2>&1 || echo "docker compose v2 不可用"
else
  echo "docker 未安装"
fi
echo
echo "===== [3.2] daemon 状态与配置 ====="
if docker info >/dev/null 2>&1; then
  echo "docker daemon: 可访问"
  docker info 2>/dev/null | grep -iE 'Server Version|Storage Driver|Cgroup|Total Memory|NCPU|Docker Root Dir|Registry Mirrors' || true
  echo "-- /etc/docker/daemon.json --"
  cat /etc/docker/daemon.json 2>/dev/null || echo "(无 daemon.json 或不可读)"
else
  echo "docker daemon 不可用（未安装 / 未运行 / 当前用户无权限），诊断信息："
  docker info 2>&1 | head -n 4
  echo -n "systemctl is-active docker: "; systemctl is-active docker 2>/dev/null || echo "未知"
fi
echo
echo "===== [3.3] 现有容器 ====="
docker ps -a 2>&1
echo
echo "===== [3.4] 现有镜像 ====="
docker images 2>&1
echo
echo "===== [3.5] 现有数据卷 ====="
docker volume ls 2>&1
DOCKERINFO
```

### 块 4：端口占用与软件冲突

```bash
bash <<'PORTINFO'
echo "===== [4.1] 全部监听端口 ====="
ss -tlnp 2>/dev/null || sudo ss -tlnp
echo
echo "===== [4.2] 关键端口判定（80 / 443 / 3100 / 5432） ====="
if ss -tln 2>/dev/null | grep -E ':(80|443|3100|5432) '; then
  echo "!!! 上述端口已被占用"
else
  echo "80 / 443 / 3100 / 5432 均空闲"
fi
echo
echo "===== [4.3] 运行中的相关服务 ====="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | grep -Ei 'postgres|mysql|mariadb|nginx|apache|httpd|node|redis|memcached|docker|containerd' || echo "无相关运行中服务"
echo
echo "===== [4.4] 宿主机已装相关软件 ====="
command -v psql >/dev/null 2>&1 && psql --version || echo "无 psql"
command -v node >/dev/null 2>&1 && node -v || echo "无 node"
command -v npm  >/dev/null 2>&1 && npm -v  || echo "无 npm"
command -v git  >/dev/null 2>&1 && git --version || echo "无 git"
command -v curl >/dev/null 2>&1 && curl --version | head -n1 || echo "无 curl"
command -v tar  >/dev/null 2>&1 && tar --version | head -n1 || echo "无 tar"
PORTINFO
```

### 块 5：出站连通性（Docker Hub / Adjust）

```bash
bash <<'NETINFO'
echo "===== [5.1] DNS 解析 ====="
for h in registry-1.docker.io auth.docker.io automate.adjust.com; do
  printf '%-28s -> ' "$h"
  IP=$(getent ahostsv4 "$h" 2>/dev/null | head -n1 | awk '{print $1}')
  [ -n "$IP" ] && echo "$IP" || echo "解析失败"
done
echo
echo "===== [5.2] HTTPS 出站连通性（HTTP 状态码） ====="
for u in https://registry-1.docker.io/v2/ https://auth.docker.io/token https://automate.adjust.com/reports-service; do
  printf '%-45s -> ' "$u"
  curl -s -m 10 -o /dev/null -w '%{http_code}\n' "$u" || echo "连接失败"
done
echo "（registry-1.docker.io/v2/ 返回 401 即代表连通正常）"
echo
echo "===== [5.3] Docker 拉取冒烟测试 ====="
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker pull hello-world 2>&1 | tail -n 4
else
  echo "docker 暂不可用，跳过（安装后在部署阶段再测）"
fi
NETINFO
```

### 块 6：防火墙与安全模块（需要 sudo）

```bash
sudo bash <<'FWINFO'
echo "===== [6.1] ufw（Ubuntu） ====="
command -v ufw >/dev/null 2>&1 && ufw status verbose || echo "无 ufw"
echo
echo "===== [6.2] firewalld（Amazon Linux / RHEL 系） ====="
command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state && firewall-cmd --list-all || echo "无 firewalld"
echo
echo "===== [6.3] SELinux / AppArmor ====="
command -v getenforce >/dev/null 2>&1 && getenforce || echo "无 SELinux"
command -v aa-status >/dev/null 2>&1 && aa-status 2>/dev/null | head -n 3 || echo "无 AppArmor（或未启用）"
echo
echo "===== [6.4] iptables 规则概览（前 25 条） ====="
iptables -S 2>/dev/null | head -n 25 || echo "iptables 不可用"
echo
echo "===== [6.5] daemon.json（root 视角） ====="
cat /etc/docker/daemon.json 2>/dev/null || echo "(无 daemon.json)"
FWINFO
```

---

## 3. 命令查不到、需要人工提供的信息

### 3.1 AWS 控制台侧（截图或文字描述均可）

| 信息 | 用途 |
| --- | --- |
| 实例类型、区域（若块 1 的 IMDS 拿不到） | 资源判定；中国区 region 会影响 Docker Hub 直连策略 |
| 安全组**入站**规则（哪些端口、对谁开放） | 确认 3100/443 放通范围；5432 不应对公网开放 |
| EBS 卷清单：系统盘/数据盘各多大、数据盘是否已挂载格式化 | 决定 pgdata 与三个 bind mount 目录落在哪个盘 |
| ALB 是否已创建、监听器（443 → 3100？）与目标组健康检查路径 | 域名入口与验证方案 |
| `cause.pmdevops.com` 的 DNS 解析现状（是否已指向 ALB/EC2） | APP_URL 与 OIDC 回调地址 |
| 出网方式：公网 IP / EIP / NAT Gateway | 判断能否拉镜像、外呼 Adjust 与模型网关 |

### 3.2 凭据与外部服务地址（建议现在就开始向管理员申请）

**启动必填**（`lib/env.ts` 无默认值，缺失则进程 fail-fast 拒绝启动）：

| 变量 | 说明 | 来源 |
| --- | --- | --- |
| `MODEL_GATEWAY_BASE_URL` / `MODEL_GATEWAY_API_KEY` / `MODEL_GATEWAY_DEFAULT_MODEL` | 统一模型网关，所有 AI 调用唯一入口 | 管理员 |
| `DATABASE_URL` | 生产 PG 连接串（口令部署时生成，容器内网互访，不走公网） | 部署阶段生成 |
| `AUTH_SECRET` | 会话签名密钥，≥32 字符 | 部署阶段生成 |

**生产必须显式覆盖**（当前默认值指向本地模拟器，不能带上生产）：

| 变量 | 生产取值方向 |
| --- | --- |
| `APP_ENV` / `NODE_ENV` | `production` |
| `APP_URL` | `https://cause.pmdevops.com/` |
| `OIDC_ISSUER` | 生产 Keycloak realm 地址（Access 管理员提供） |
| `OIDC_CLIENT_SECRET` | 默认值是本地占位符，必须换生产凭据 |
| `ACCESS_INTERNAL_BASE_URL` / `ACCESS_INTERNAL_SECRET` | access-app 生产内部接口地址与共享密钥 |
| `OIDC_CLIENT_ID` / `ACCESS_ENTRY_ID` | 默认 `pt-ai-cause` / `cause`，与 Access 侧注册核对即可 |

**建议配置**：`ADJUST_API_TOKEN`（Adjust 控制面板 → 账户设置 → 个人档案获取）、`ADJUST_RS_UTC_OFFSET=+08:00`。

**可选/预留**（当前无代码使用，可不填）：`REDIS_URL`（有默认值）、`MQ_URL`、`MCP_GATEWAY_*`、`FIRECRAWL_API_KEY`、`OBJECT_STORAGE_*`、`MODEL_GATEWAY_FALLBACK_*`。

### 3.3 代码分发方式（三选一，等块 2/块 5 结果出来我来定）

- A：服务器上 `git clone` 后本地 `docker build`（需 git + 仓库可达 + 构建期约 4 GiB 可用内存）
- B：本地构建镜像 → `docker save` 打包 → scp 上传 → `docker load`（需磁盘余量与传输带宽）
- C：推送 ECR / 私有 registry，服务器拉取（需 AWS 或 registry 凭据）

---

## 4. 判定标准（拿到你的输出后我核对这些）

| 检查项 | 期望 | 不满足时 |
| --- | --- | --- |
| CPU 架构 | x86_64（aarch64 也可，镜像均支持，但需与构建机架构一致） | 调整镜像构建方案 |
| 操作系统 | Ubuntu 22.04/24.04 或 Amazon Linux 2023 | 影响安装命令序列 |
| 内存 | ≥8 GiB 可运行；既定建议规格 16 GiB（应用 4G + PG 4~8G + 余量） | 压缩容器 memory limit 或升配 |
| 磁盘余量 | ≥40 GiB（镜像 + 数据卷 + 构建） | 清理或扩盘 |
| Docker | 已装且 ≥24.x，Compose v2 可用，daemon 运行中 | 部署阶段先给安装命令 |
| 端口 | 3100 空闲（80/443 视是否上反代） | 改端口或清冲突 |
| 出站连通 | Docker Hub、Adjust、模型网关、Keycloak 可达；中国区 region 需确认镜像加速方案 | 配置 registry mirror 或走 B/C 分发 |
| 时间同步 | NTP active（Adjust 同步时区由 `ADJUST_RS_UTC_OFFSET` 显式控制，宿主机只需时间准） | 开启 chrony/ntp |
| sudo | 可用 | 安装软件的前提 |

---

## 5. 下一步预告

拿到块 1–6 的输出和 3.1/3.2 的信息后，我会依次给出：

1. **install 命令序列**（如需：Docker Engine + Compose v2 安装、目录与数据盘挂载初始化）
2. **Dockerfile + docker-compose.prod.yml**（含健康检查、资源限制、pgdata 与三个业务目录的持久化挂载；5432 不出宿主机）
3. **deploy 命令序列**（构建/分发镜像 → 启动 → `prisma migrate deploy` → 首次数据确认）
4. **verify.md**（登录链路、核心 API、SSE 流式问答、数据库与持久化目录的逐项验证命令与预期结果）

---

## 6. 服务器实际采集结果（2026-09-29 采集完成）

> **目标机**：`prod-ai-cause-01` / `ec2-user@10.163.141.20` / EC2 `i-0e8f1e7e13ee097f5` / `m7g.xlarge` / `ap-southeast-1a`
> **采集方式**：JumpServer Web CLI（Luna 终端）逐块执行 §2 的 6 个命令块，输出原样回贴（含报错）
> **补充说明**：
> - `ec2-user` **不在 docker 组**，因此块 3/4/5/6 以及补充探测均以 `sudo`（免密）执行，否则会得到 `permission denied`（块 3-a 保留了这种原样输出作为证据）。
> - 输出末尾的 `===== [RC] N =====` 是采集时追加的退出码（块 2 未加，当时屏幕显示 RC=0 / 15 行）。
> - 采集时刻：2026-09-29 02:48 UTC（服务器时区即 UTC）。

### 6.1 块 1 — 系统与硬件（原文输出）

```text
===== [1.1] 操作系统与内核 =====
NAME="Amazon Linux"
ID="amzn"
VERSION_ID="2023"
PRETTY_NAME="Amazon Linux 2023.12.20260918"
Linux 6.18.48-109.150.amzn2023.aarch64 aarch64

===== [1.2] CPU =====
vCPU 数: 4
Architecture:                            aarch64
CPU(s):                                  4

===== [1.3] 内存 =====
               total        used        free      shared  buff/cache   available
Mem:            15Gi       410Mi        13Gi       0.0Ki       1.2Gi        14Gi
Swap:             0B          0B          0B

===== [1.4] 时区与时间同步 =====
               Local time: Tue 2026-09-29 02:48:38 UTC
           Universal time: Tue 2026-09-29 02:48:38 UTC
                 RTC time: Tue 2026-09-29 02:48:39
                Time zone: n/a (UTC, +0000)
System clock synchronized: yes
              NTP service: active
          RTC in local TZ: no

===== [1.5] 当前用户与 sudo 权限 =====
ec2-user
uid=1000(ec2-user) gid=1000(ec2-user) groups=1000(ec2-user),4(adm),10(wheel),190(systemd-journal) context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023
sudo: 免密可用

===== [1.6] EC2 元数据（实例类型 / 区域） =====
instance-type: m7g.xlarge
region: ap-southeast-1
```

### 6.2 块 2 — 磁盘与数据卷（原文输出）

```text
===== [2.1] 文件系统使用量 =====
Filesystem       Type      Size  Used Avail Use% Mounted on
efivarfs         efivarfs  128K  3.0K  126K   3% /sys/firmware/efi/efivars
/dev/nvme0n1p1   xfs        50G  2.9G   48G   6% /
/dev/nvme0n1p128 vfat       10M  1.4M  8.6M  14% /boot/efi
/dev/nvme1n1     xfs        50G  389M   50G   1% /srv/cause

===== [2.2] 块设备与挂载点 =====
NAME          SIZE TYPE FSTYPE MOUNTPOINT
nvme1n1        50G disk xfs    /srv/cause
nvme0n1        50G disk
├─nvme0n1p1    50G part xfs    /
└─nvme0n1p128  10M part vfat   /boot/efi

===== [2.3] swap =====
```

> 注：`swapon --show` 无输出，即**没有启用 swap**（与块 1 的 `Swap: 0B` 一致）；采集时屏幕显示 RC=0、输出 15 行。

### 6.3 块 3 — Docker 现状（原文输出）

#### 3-a：按原样直接执行（当前用户 `ec2-user`，无 sudo）

```text
===== [3.1] Docker 安装与版本 =====
Docker version 25.0.14, build 0bab007
docker: 'compose' is not a docker command.
See 'docker --help'
docker compose v2 不可用

===== [3.2] daemon 状态与配置 =====
docker daemon 不可用（未安装 / 未运行 / 当前用户无权限），诊断信息：
Client:
 Version:    25.0.14
 Context:    default
 Debug Mode: false
systemctl is-active docker: active

===== [3.3] 现有容器 =====
permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.44/containers/json?all=1": dial unix /var/run/docker.sock: connect: permission denied

===== [3.4] 现有镜像 =====
permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Head "http://%2Fvar%2Frun%2Fdocker.sock/_ping": dial unix /var/run/docker.sock: connect: permission denied

===== [3.5] 现有数据卷 =====
permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.44/volumes": dial unix /var/run/docker.sock: connect: permission denied
===== [RC] 1 =====
```

#### 3-b：`sudo` 补采（daemon / 容器 / 镜像 / 卷）

```text
===== [3.2b] docker info (root 视角) =====
 Server Version: 25.0.16
 Storage Driver: overlay2
 Cgroup Driver: systemd
 Cgroup Version: 2
 Total Memory: 15.3GiB
 Docker Root Dir: /var/lib/docker
 Live Restore Enabled: false

-- /etc/docker/daemon.json --
(无 daemon.json)

-- docker compose 插件 --
docker: 'compose' is not a docker command.
See 'docker --help'

===== [3.3b] 现有容器 (docker ps -a) =====
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES

===== [3.4b] 现有镜像 (docker images) =====
REPOSITORY   TAG       IMAGE ID   CREATED   SIZE

===== [3.5b] 现有数据卷 (docker volume ls) =====
DRIVER    VOLUME NAME
===== [RC] 0 =====
```

### 6.4 块 4 — 端口占用与软件冲突（`sudo` 执行）

```text
===== [4.1] 全部监听端口 =====
State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      4096       127.0.0.1:6060       0.0.0.0:*    users:(("datakit",pid=3007,fd=59))
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=2343,fd=7))
LISTEN 0      4096       127.0.0.1:9529       0.0.0.0:*    users:(("datakit",pid=3007,fd=60))
LISTEN 0      4096       127.0.0.1:44151      0.0.0.0:*    users:(("containerd",pid=29173,fd=13))
LISTEN 0      128             [::]:22            [::]:*    users:(("sshd",pid=2343,fd=8))

===== [4.2] 关键端口判定（80 / 443 / 3100 / 5432） =====
80 / 443 / 3100 / 5432 均空闲

===== [4.3] 运行中的相关服务 =====
  containerd.service         loaded active running containerd container runtime
  docker.service             loaded active running Docker Application Container Engine

===== [4.4] 宿主机已装相关软件 =====
无 psql
无 node
无 npm
无 git
curl 8.21.0 (aarch64-amazon-linux-gnu) libcurl/8.21.0 OpenSSL/3.5.8 zlib/1.2.11 libidn2/2.3.2 libpsl/0.21.5 nghttp2/1.59.0 mit-krb5/1.21.3
tar (GNU tar) 1.34
===== [RC] 0 =====
```

### 6.5 块 5 — 出站连通性（`sudo` 执行）

```text
===== [5.1] DNS 解析 =====
registry-1.docker.io         -> 100.57.240.195
auth.docker.io               -> 104.18.43.178
automate.adjust.com          -> 185.151.204.110

===== [5.2] HTTPS 出站连通性（HTTP 状态码） =====
https://registry-1.docker.io/v2/              -> 401
https://auth.docker.io/token                  -> 200
https://automate.adjust.com/reports-service   -> 404
（registry-1.docker.io/v2/ 返回 401 即代表连通正常）

===== [5.3] Docker 拉取冒烟测试 =====
58dee6a49ef1: Pull complete
Digest: sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8
Status: Downloaded newer image for hello-world:latest
docker.io/library/hello-world:latest
===== [RC] 0 =====
```

### 6.6 块 6 — 防火墙与安全模块（`sudo` 执行）

```text
===== [6.1] ufw（Ubuntu） =====
无 ufw

===== [6.2] firewalld（Amazon Linux / RHEL 系） =====
无 firewalld

===== [6.3] SELinux / AppArmor =====
Permissive
无 AppArmor（或未启用）

===== [6.4] iptables 规则概览（前 25 条） =====
-P INPUT ACCEPT
-P FORWARD DROP
-P OUTPUT ACCEPT
-N DOCKER
-N DOCKER-ISOLATION-STAGE-1
-N DOCKER-ISOLATION-STAGE-2
-N DOCKER-USER
-A FORWARD -j DOCKER-USER
-A FORWARD -j DOCKER-ISOLATION-STAGE-1
-A FORWARD -o docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A FORWARD -o docker0 -j DOCKER
-A FORWARD -i docker0 ! -o docker0 -j ACCEPT
-A FORWARD -i docker0 -o docker0 -j ACCEPT
-A DOCKER-ISOLATION-STAGE-1 -i docker0 ! -o docker0 -j DOCKER-ISOLATION-STAGE-2
-A DOCKER-ISOLATION-STAGE-1 -j RETURN
-A DOCKER-ISOLATION-STAGE-2 -o docker0 -j DROP
-A DOCKER-ISOLATION-STAGE-2 -j RETURN
-A DOCKER-USER -j RETURN

===== [6.5] daemon.json（root 视角） =====
(无 daemon.json)
===== [RC] 0 =====
```

### 6.7 补充探测 1 — EC2 元数据 / 域名入口 / 数据盘

```text
===== [7.1] EC2 元数据 =====
instance-id:        i-0e8f1e7e13ee097f5
instance-type:      m7g.xlarge
availability-zone:  ap-southeast-1a
region:             ap-southeast-1
public-ipv4:        <?xml version="1.0" encoding="iso-8859-1"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
                 "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
 <head>
  <title>404 - Not Found</title>
 </head>
 <body>
  <h1>404 - Not Found</h1>
 </body>
</html>

local-ipv4:         10.163.141.20
iam-instance-role:  <?xml version="1.0" encoding="iso-8859-1"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
                 "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
 <head>
  <title>404 - Not Found</title>
 </head>
 <body>
  <h1>404 - Not Found</h1>
 </body>
</html>


===== [7.2] 域名与入口现状 =====
cause.pmdevops.com -> 10.163.138.182
jumpserver.pmdevops.com -> 10.101.175.218

===== [7.3] 出网公网 IP 与 cause 域名探测 =====
egress public ip: 52.221.122.199
https://cause.pmdevops.com/  -> code=502 ip=10.163.138.182 redirect=

===== [7.4] 数据盘挂载与目录 =====
/dev/nvme1n1 /srv/cause xfs    49.9G
drwxr-xr-x. 2 root root 6 Sep 28 08:16 /srv/cause
/dev/nvme1n1     50G  389M   50G   1% /srv/cause
===== [RC] 0 =====
```

> 读法：IMDS 返回 404 表示**该实例没有 public IPv4、也没有 IAM 实例角色**（出网走 NAT，实测出口 `52.221.122.199`）。
> `cause.pmdevops.com` 已解析到内网 `10.163.138.182`（疑似 ALB），当前 **502** = 监听器/目标组在，但**没有健康后端**。

### 6.8 补充探测 2 — compose 插件与 docker 组

```text
===== [8.1] 已装 docker 相关 RPM =====
containerd-2.2.7-1.amzn2023.0.1.aarch64
docker-25.0.16-1.amzn2023.0.4.aarch64

===== [8.2] dnf 仓库中可用的 compose 包 =====

===== [8.3] 现有 cli-plugins 目录 =====
ls: cannot access '/usr/lib/docker/cli-plugins/': No such file or directory
/usr/libexec/docker/cli-plugins/:
total 58708
-rwxr-xr-x. 1 root root 60112976 Aug 10 22:59 docker-buildx

===== [8.4] docker 用户组 =====
docker:x:993:
uid=1000(ec2-user) gid=1000(ec2-user) groups=1000(ec2-user),4(adm),10(wheel),190(systemd-journal)

===== [8.5] 时间同步服务 =====
chronyd              active
systemd-timesyncd    inactive
ntpd                 inactive
===== [RC] 0 =====
```

### 6.9 判定结论（对照 §4）

| 检查项 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| CPU 架构 | x86_64（aarch64 亦可，但需与构建机一致） | **aarch64**（Graviton3，m7g.xlarge，4 vCPU） | ⚠️ 镜像必须按 `linux/arm64` 构建 |
| 操作系统 | Ubuntu 22.04/24.04 或 Amazon Linux 2023 | Amazon Linux 2023.12.20260918，内核 6.18.48 | ✅ 符合 |
| 内存 | ≥8 GiB（建议 16 GiB） | 15 GiB，无 swap | ✅ 够用 |
| 磁盘余量 | ≥40 GiB | 系统盘 50G（已用 2.9G）＋数据盘 `/dev/nvme1n1` 50G 已挂 `/srv/cause`（空） | ✅ 充裕 |
| Docker | ≥24.x，Compose v2 可用，daemon 运行中 | 25.0.16（daemon active）；**compose v2 未安装**；`ec2-user` 不在 docker 组 | ⚠️ 需补装 compose v2 并处理权限 |
| 端口 | 3100 空闲（80/443 视是否反代） | 80 / 443 / **3100** / 5432 **全部空闲**；仅有 22 与 datakit 本地口 | ✅ |
| 出站连通 | Docker Hub、Adjust、模型网关、Keycloak 可达 | Docker Hub 401/200 ✅、`docker pull hello-world` **成功** ✅、Adjust 404（连通）✅；模型网关/Keycloak **未测**（缺地址） | ⚠️ 待补测 |
| 时间同步 | NTP active | chronyd active，系统时区 UTC | ✅ |
| sudo | 可用 | `ec2-user` 免密 sudo | ✅ |
| 防火墙/安全模块 | — | 无 ufw、无 firewalld；SELinux `Permissive`；iptables 仅 Docker 链 | ✅（入站放通完全依赖安全组） |
| 公网入口 | — | 无 public IPv4，出网经 NAT；域名走内网 ALB（当前 502） | ⚠️ 部署后需把后端注册进目标组 |

### 6.10 据此对部署方案（§3.3 分发方式 / compose）的调整

1. **镜像架构**：目标是 `arm64`，构建产物必须匹配。
   - 方案 A（服务器上构建）：天然匹配，**推荐**；代价是要先装 `git`（当前无）或经 JumpServer 文件管理上传源码 tar 包。
   - 方案 B（本地构建 + `docker save/load`）：本机若是 x86，必须用 `buildx --platform linux/arm64`（QEMU 模拟，构建慢）。
   - 方案 C（ECR）：该实例**无 IAM 实例角色**，需要先配角色或把 AWS 凭据放上去。
2. **Compose v2**：AL2023 官方源查不到 compose 包，`/usr/libexec/docker/cli-plugins/` 里只有 `docker-buildx` → 部署脚本里直接从 GitHub 取 `docker-compose-linux-aarch64` 放到该目录即可。
3. **Docker 权限**：`docker` 组已存在（gid 993）但 `ec2-user` 不在其中 → 建议部署前 `sudo usermod -aG docker ec2-user` 并重新登录（或所有命令带 `sudo`）。
4. **数据落盘**：数据盘已挂在 `/srv/cause`（root 所有、空）。建议
   - `pgdata` 命名卷可用默认（系统盘 `/var/lib/docker`，余量 48G 足够）；
   - 三个 bind mount 目录放数据盘：`/srv/cause/research-graph`、`/srv/cause/exports`、`/srv/cause/deliveries`，并把属主改为部署用户（`ec2-user`），compose 里按此路径挂载。
5. **外部依赖未测**：`MODEL_GATEWAY_BASE_URL` 与 Keycloak 地址拿到后，需在服务器上补一次块 5 的连通性测试再部署。
6. **无 swap**：内存 15 GiB 够跑应用 4G + PG 4~8G，但服务器上构建镜像时注意内存峰值（buildx 默认并行会吃内存）。
7. **旁路进程**：`datakit` 在跑并占用 `127.0.0.1:6060 / 9529`（本机回环），部署时避开这两个端口即可，不要动它。

### 6.11 仍需 AWS 控制台 / 管理员提供（§3.1 剩余项）

| 信息 | 状态 |
| --- | --- |
| 实例类型 / 区域 / AZ / 实例 ID | ✅ 已自采（m7g.xlarge / ap-southeast-1 / ap-southeast-1a / i-0e8f1e7e13ee097f5） |
| 出网方式 | ✅ 无公网 IP，经 NAT 出网（出口 52.221.122.199） |
| 数据盘 | ✅ `/dev/nvme1n1` 50G xfs，已挂 `/srv/cause` |
| 安全组入站规则 | ❌ 仍需控制台确认（80/443/3100 对谁开放） |
| ALB 监听器与目标组健康检查路径 | ⚠️ 域名 `cause.pmdevops.com` → 10.163.138.182 已通但返回 502，监听器存在，需确认目标组与健康检查路径 |
| EBS 卷 ID / 快照策略 | ❌ 需控制台确认 |
| 模型网关 / Keycloak 地址 | ❌ 待管理员提供 |
| `ADJUST_API_TOKEN` 等凭据 | ❌ 待管理员提供 |
