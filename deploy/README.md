# 自动部署和运维

设置好以后，服务器程序和电脑网页后台的更新都由 GitHub 自动完成，不用再上传 zip、不用去宝塔点重启。同一台服务器上跑两份：**正式版**（3000 端口，店里真用的）和**测试版**（3001 端口，数据从正式版复制，随便试），见下面「测试版」一节。

- `main` 分支上 `server/` 或 `admin-web/dist/` 有改动，就自动部署到**测试版**。
- 测试版试过没问题，在 GitHub 仓库的 **Actions → 部署到服务器 → Run workflow** 里「部署到哪里」选 `prod`、分支留空，就把测试版现在跑的那个版本部署到**正式版**。
- 也可以在这里手动部署任意分支或提交到测试版（选 `test`，填分支名）。
- 日常运维在 **Actions → 服务器运维 → Run workflow** 里先选对哪个做（`prod` 正式版 / `test` 测试版），再选：`status` 看状态、`logs` 看日志、`restart` 重启、`backup` 马上备份数据库、`rollback` 退回上一版、`refresh-data` 把正式版现在的数据重新复制到测试版（只能对测试版做）。

小程序本身（`miniprogram/`、`miniprogram-carwash/`）不在这里，改了以后还是在微信开发者工具里上传、提交审核。

## 每次部署做了什么

1. 在 GitHub 上跑一遍测试，没通过就不部署。
2. 把 `server/` 和 `admin-web/dist/` 打成代码包，传到服务器。
3. 服务器检查代码包（只能有这两个文件夹，不能有链接），先试着加载一遍新代码，加载出错就停下，线上不受影响。
4. 备份数据库和现在的代码到 `/www/backup/jinshan/`（数据库留最近 20 份，代码留最近 10 份）。
5. 换上新代码，重启，检查 `/healthz`。启动不了就**自动退回上一版**。

`server/config.json`、`server/data/`（数据库和图片）、`server/cert/`（支付证书）永远不会被覆盖或删除。服务器上手动留的 `config*.json`、`*.pem`、`*.db`、`*.bak` 文件也不会被删。

## 第一次设置（只做一次）

需要的东西：宝塔面板能登录，GitHub 仓库是自己的。全程不需要把任何密码发给别人。

1. **上传脚本**：宝塔「文件」→ 进入 `/www/wwwroot/jinshan` → 上传 `jinshan-ops.sh`（就是本文件夹里那个）。
2. **运行设置**：宝塔「终端」里粘贴下面一行，回车（最后的 IP 换成自己服务器的公网 IP）：

   ```
   sudo bash /www/wwwroot/jinshan/jinshan-ops.sh install 139.155.154.80
   ```

   它会：
   - 把服务器程序改成系统服务 `jinshan`，用 `www` 用户运行，开机自动启动，程序崩了 3 秒后自动拉起来。宝塔「Node 项目」里原来那个项目会被停掉，以后不要再在宝塔里启动它，可以把它的「开机启动」关掉或者删掉这个项目条目（删的时候**不要**勾选删除文件）。
   - 建一个专用账号 `jinshan-deploy` 和一把部署钥匙。这把钥匙只能调用 `jinshan-ops` 的几个动作，不能登录终端、不能转发端口。
   - 把要填到 GitHub 的内容（以 `host` 开头、以 `-----END OPENSSH PRIVATE KEY-----` 结尾）存到 `/root/jinshan-github-secret.txt`，只有 root 能看，终端里不显示。
   - 程序如果不在 `/www/wwwroot/jinshan`，会按正在跑的进程找到实际目录，记在 `/etc/jinshan-ops.conf`。

   如果中途报错，程序会撤销改动，按提示到宝塔「Node 项目」把项目重新启动，再把报错截图发给 Claude。

3. **填到 GitHub**：宝塔「文件」打开 `/root/jinshan-github-secret.txt`，全选复制。仓库 **Settings → Secrets and variables → Actions → New repository secret**，Name 填 `SERVER_SSH`，Secret 粘贴，点 Add secret。GitHub 第一次连上服务器后，`/root/jinshan-github-secret.txt` 会自动删除。

腾讯云轻量服务器的防火墙默认放行 22 端口（SSH），GitHub 就是从这个端口连进来的，不要关掉它。

## 测试版

和正式版在同一台服务器上，完全分开：

| | 正式版 | 测试版 |
|---|---|---|
| 目录 | `/www/wwwroot/jinshan` | `/www/wwwroot/jinshan-test` |
| 端口 | 3000 | 3001 |
| 系统服务 | `jinshan` | `jinshan-test` |
| 数据库和图片 | 自己的 `server/data` | 自己的 `server/data`，安装时从正式版复制 |
| 部署前备份 | `/www/backup/jinshan` | `/www/backup/jinshan-test` |
| 微信支付 | 按 `config.json` | 关闭（配置里不填商户号，程序也不读） |
| 订阅消息 | 发给顾客 | 只发给店主和店员（复制来的数据里有真顾客） |
| 网址 | `https://pigkun.com`（`www` 也行） | `https://test.pigkun.com` |
| 小程序 | 正式发布的版本连这里 | 开发者工具和体验版连这里 |

测试版的 `config.json` 里多了 `"env": "test"`，程序看到它才按测试版跑：网页后台顶上有一条红色「测试版」，扫码登录出体验版的码，`/healthz` 返回 `"env":"test"`。部署和启动前会检查测试版配置：`env` 是 `test`、端口不是 3000、数据目录在测试版自己的目录里、没填商户号，不对就不动。

**小程序连哪台**：`miniprogram/config.js` 里 `apiBase` 是正式版地址，`testApiBase` 是测试版地址。正式发布的版本连正式版；开发者工具和体验版默认连测试版，要用体验版管店里的真数据（比如还没发布时在手机上改菜单、扫正式后台的登录码），在「我的」页面最下面点一下切到正式服务器，只对这台手机有效。扫到另一台服务器后台的登录码时，确认页会提示先切过去。

**数据旧了**：测试版的数据只在安装时复制一次。想换成正式版现在的数据，运行「服务器运维」选 `test` + `refresh-data`（测试版原来的数据库会先备份到 `/www/backup/jinshan-test/db`），或者终端里 `sudo jinshan-ops test refresh-data`。

### 装测试版（只做一次）

正式版的自动部署装好以后，在服务器上用 root 运行一次（腾讯云轻量控制台「执行命令」或宝塔终端都行），先把本文件夹里新的 `jinshan-ops.sh` 放到服务器上：

```
sudo bash /www/wwwroot/jinshan/jinshan-ops.sh install-test 139.155.154.80
```

它会：

1. 把运维脚本升级成新版（部署钥匙不变，GitHub 上的 `SERVER_SSH` 不用改）。
2. 把正式版现在的代码复制到 `/www/wwwroot/jinshan-test`。
3. 照正式版的 `config.json` 生成测试版的：端口 3001、`env` 是 `test`、去掉商户号、数据放测试版自己的目录。
4. 复制正式版的数据库和图片（导出一致的副本，正式版不用停）。
5. 建系统服务 `jinshan-test`。正式版现在的代码还不认得测试版的话先不启动，GitHub 第一次部署测试版时会自动启动。
6. firewalld 放行 3001。

正式版全程不重启、不改动。装完还要在**腾讯云轻量服务器控制台 →「防火墙」**添加规则放行 TCP `3001`，然后在 GitHub 部署一次测试版（Actions → 部署到服务器，选 `test`）。测试版的网页后台当时是 `http://139.155.154.80:3001/admin/`（现在是 `https://test.pigkun.com/admin/`），账号和正式版一样（安装时复制过来的）。

再运行一次 `install-test` 也没关系：已经有的代码、配置和数据都不动，只升级运维脚本、重写系统服务并重启测试版。以后改了 `jinshan-ops.sh`，也用这条命令升级，不用重新运行 `install`、不用换钥匙。

### 域名

测试版是 `https://test.pigkun.com`（主域名备案了，子域名不用另外备案），宝塔反向代理到本机 `127.0.0.1:3001`，见下面「HTTPS」。测试版网页后台：`https://test.pigkun.com/admin/`。

### 不要测试版了

`systemctl disable --now jinshan-test`，删掉 `/etc/systemd/system/jinshan-test.service`，`firewall-cmd --permanent --remove-port=3001/tcp && firewall-cmd --reload`，腾讯云防火墙删掉 3001。`/www/wwwroot/jinshan-test` 确认不要了再删。`miniprogram/config.js` 的 `testApiBase` 改成空，小程序就都连正式版；`deploy.yml` 里 push 自动部署的目标也要改回正式版。

## 在服务器上直接操作

宝塔「终端」里也能用同样的命令：

```
sudo jinshan-ops status          # 看状态：版本、内存、磁盘、备份
sudo jinshan-ops logs 200        # 最近 200 行日志
sudo jinshan-ops restart         # 重启
sudo jinshan-ops backup          # 马上备份数据库
sudo jinshan-ops rollback        # 退回上一版代码
sudo jinshan-ops test status     # 前面加 test 就是对测试版做，比如看测试版的状态
sudo jinshan-ops test refresh-data   # 把正式版现在的数据重新复制到测试版
```

也可以用系统自带的命令：`systemctl status jinshan`、`journalctl -u jinshan -f`（测试版是 `jinshan-test`）。

- 现在线上是哪个版本：`/www/wwwroot/jinshan/.deploy-version`
- 部署记录：`/www/backup/jinshan/history.log`
- 每天凌晨 4 点后程序自己做的数据库备份还在 `server/data/backups/`，保留 14 天

**从备份恢复数据库**：`systemctl stop jinshan` → 把 `server/data/jinshan.db` 改名留底，删掉旁边的 `jinshan.db-wal`、`jinshan.db-shm` → 把要恢复的备份（`/www/backup/jinshan/db/` 或 `server/data/backups/` 里的）复制成 `server/data/jinshan.db`，所有者改成 `www` → `systemctl start jinshan`。

## HTTPS（2026-11-02 已配好）

pigkun.com 备案号 蜀ICP备2026066027号-2。程序不归宝塔「Node 项目」管，域名和证书用宝塔的反向代理：

| | 正式版 | 测试版 |
|---|---|---|
| 解析（腾讯云 DNSPod） | `@`、`www` → 139.155.154.80 | `test` → 139.155.154.80 |
| 宝塔「网站 → 反向代理」 | `pigkun.com`、`www.pigkun.com` → `http://127.0.0.1:3000` | `test.pigkun.com` → `http://127.0.0.1:3001` |
| `config.json` | `host` `127.0.0.1`，`publicUrl` `https://pigkun.com` | `host` `127.0.0.1`，`publicUrl` `https://test.pigkun.com` |

- 证书是宝塔申请的 Let's Encrypt（站点「设置 → SSL」），开了强制 HTTPS。宝塔「计划任务」里的「续签Let's Encrypt证书」每天检查，快到期自动续，不用管。
- 程序只听本机，3000、3001 外面访问不了：腾讯云轻量防火墙和 firewalld 都只开 22、80、443、8888。改之前的配置留在 `server/config.json.bak-20261102-165517`。
- 同一台服务器上还有 `xiyi.pigkun.com`（洗衣房，反代到 3100），不是本项目的，别动。
- 网站首页（`https://pigkun.com` 会跳到网页后台登录页）最下面挂着备案号，链到工信部备案网站，这是管局要求的；备案号写在 `admin-web/public/config.js` 的 `icp`。

以后要换域名：宝塔里加反代和证书 → 改两份 `config.json` 的 `publicUrl` → `sudo jinshan-ops restart`、`sudo jinshan-ops test restart` → 改 `miniprogram/config.js` → 公众平台服务器域名加上新域名。

## 换钥匙、停用自动部署

- **换钥匙**（比如怀疑泄露了）：在服务器上重新运行一次第 2 步，再把新打印的内容更新到 GitHub 的 `SERVER_SSH`。旧钥匙马上失效。
- **停用自动部署**：删掉 GitHub 上的 `SERVER_SSH`，或者删掉服务器上的 `/home/jinshan-deploy/.ssh/authorized_keys`。
- **改回宝塔管理**：`systemctl disable --now jinshan`，然后在宝塔「Node 项目」里重新添加并启动。

## 文件

```
deploy/jinshan-ops.sh            服务器上的运维脚本（install 时装到 /usr/local/bin/jinshan-ops）
.github/workflows/deploy.yml     部署到服务器
.github/workflows/ops.yml        服务器运维
.github/scripts/server.sh        GitHub 上连服务器用的小工具（读 SERVER_SSH、断线重试）
```

改了 `jinshan-ops.sh` 以后，要在服务器上重新运行一次 `install-test`（或 `install`，会换钥匙）才生效（这个脚本有 root 权限，所以故意不让 GitHub 自动更新它）。
