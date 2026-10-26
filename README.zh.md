![GitHub License](https://img.shields.io/github/license/CHKayanami/OpenWrt-nikki-rs?style=for-the-badge&logo=github) ![GitHub Tag](https://img.shields.io/github/v/release/CHKayanami/OpenWrt-nikki-rs?style=for-the-badge&logo=github) ![GitHub Downloads](https://img.shields.io/github/downloads/CHKayanami/OpenWrt-nikki-rs/total?style=for-the-badge&logo=github) ![GitHub Stars](https://img.shields.io/github/stars/CHKayanami/OpenWrt-nikki-rs?style=for-the-badge&logo=github) [![Telegram](https://img.shields.io/badge/Telegram-gray?style=for-the-badge&logo=telegram)](https://t.me/OpNikkiRS)

中文 | [English](README.md)

# Nikki RS

**Nikki RS** 是基于 [OpenWrt-nikki](https://github.com/nikkinikki-org/OpenWrt-nikki) 的 OpenWrt Fork 分支。本项目集成了由 Rust 编写的高性能代理核心 [clash-rs](https://chkayanami.github.io/clash-rs-alpha-docs/)，为 OpenWrt 提供轻量、高性能的透明代理解决方案。

---

## 项目特色
- **开箱即用**：内置预设防火墙规则（FakeIP + 绕过大陆）与分流策略，满足绝大多数常见使用场景，同时支持便捷的自建节点配置，只需要配置代理节点信息就可开始使用。
- **极致轻量 (`clash-rs`)**：基于 Rust 编写的 [clash-rs](https://chkayanami.github.io/clash-rs-alpha-docs/) Fork 版本核心，极大幅度降低内存占用与 CPU 开销；相比原版修复了多项 Bug、扩充了一些功能并提升了运行稳定性。
- **配置兼容**：配置绝大部分兼容mihomo，部分配置不支持的也不会报错，只是不会生效，具体配置参考[clash-rs配置](https://chkayanami.github.io/clash-rs-alpha-docs/configuration/overview)
- **透明代理**：原生支持 Redirect 、 TPROXY 和 TUN 模式，完整覆盖 IPv4 与 IPv6 流量分流。
- **eBPF代理**：基于eBPF的透明代理，支持内核态直连快路径决策（Direct Fast-Path）。
- **丰富协议支持**：良好支持 SS、AnyTLS、Hysteria2 (hy2) 及 VLESS-Vision-Reality 等协议；默认内核移除了 SSH、WireGuard、Tailscale、Shadowquic、Tor 等模块，可通过一键脚本快速切换为完整版内核：
  ```bash
  wget -O - https://github.com/CHKayanami/OpenWrt-nikki-rs/raw/refs/heads/main/switch_core.sh | ash
  ```
- **配置精简**：针对 `clash-rs` 的核心特性进行了适配，移除了不支持的冗余配置项，使控制界面更加纯粹易用。
---

## 内核管理与安全配置编辑

相较于直接替换系统内核，Nikki RS 现在支持独立管理 clash-rs 核心（功能借鉴 OpenClash）：

- **内核在线升级**：LuCI **服务 → Nikki RS → Core Management**，选择 `minimal` 或 `standard`，支持 `latest` 或指定官方 Release 标签。
- **安全更新**：根据 `uname -m` 选择架构，校验 GitHub Release 中的 SHA256 digest、解包后的可执行文件和当前启动配置；服务无法重新启动时自动恢复原内核。
- **不覆盖系统包**：下载的核心位于 `/etc/nikki-rs/core/clash-rs`，保留 `/usr/bin/clash-rs` 为基础版本。支持手动回退到上一个覆盖版本，或回退到系统包。
- **自动更新**：可在 LuCI 中开启，并设置 cron（默认每周日 04:15），默认**关闭**。
- **安全编辑器**：配置文件保存前校验 YAML 根节点格式；语法错误会显示解析器提供的行、列位置。原子覆盖保存，并在 `/etc/nikki-rs/backups/` 保留最近 10 个版本。LuCI **Editor → Validate Before Saving / History / Restore** 可检测和回退。修改 `run/config.yaml` 是临时的，服务重启会重新生成，应优先编辑源配置或 `mixin.yaml`。

命令行示例：

```sh
# 读取实际生效的内核位置及版本
/etc/nikki-rs/scripts/core-manager.sh status

# 跟踪上游最新发行版（根据 UCI 内核类型选择）
/etc/nikki-rs/scripts/core-manager.sh update

# 切换到标准内核，或安装指定官方标签
/etc/nikki-rs/scripts/core-manager.sh update standard latest
/etc/nikki-rs/scripts/core-manager.sh update minimal v0.20.23-alpha

# 回退到更新前的核心
/etc/nikki-rs/scripts/core-manager.sh rollback
```

**兼容性限制**：本项目的执行内核仍为 clash-rs，而不是 Mihomo；OpenClash 的所有高级规则和协议不能直接视为已兼容。上游目前未提供 i686 / riscv64 的 standard 版本。内核更新需要路由器能直接访问官方 GitHub API 和 Release 下载站点，且设备有足够可用存储空间。

---


## Clash 高级配置工作台

新增 LuCI **服务 → Nikki RS → Advanced Config**，按照 General、DNS/DNS2、Proxy Groups、Rules、TUN、Sniffer 和 Custom YAML 七个模块分别维护高级配置。

- 各模块位于 `/etc/nikki-rs/overrides/<模块名>.yaml`，软件包升级保留用户修改。
- 模块在原始订阅、`mixin.yaml` 和 UCI 生成的配置合并之后再覆盖，**不会改写订阅文件**。
- 标准 YAML 字段以覆盖方式合并；`nikki-rules`、`nikki-proxies`、`nikki-proxy-groups` 是专用的前置数组。规则优先级遵循 **general → dns → proxy-groups → rules → tun → sniffer → custom** 的读取顺序。
- 页面提供 YAML 校验、配置合并预览、使用安装内核进行候选配置测试、非敏感规则统计与重复规则检测、备份版本选择和历史恢复；编辑后**保存但不立即重启服务**。
- 首次预览前需至少启动一次 Nikki RS，以生成 `/etc/nikki-rs/run/base.yaml`。预览使用最近生成的配置快照，下一次启动会重新读取订阅/UCI，因此最终效果可能随订阅改变。
- 应用更新后由 Nikki RS 重新启动生成 `/etc/nikki-rs/run/config.yaml`。防火墙管理模式下 TUN 的自动路由相关选项仍会被强制关闭。

例如，若要新增自己的高优先级规则，可在 Rules 模块中填写：

```yaml
nikki-rules:
  - DOMAIN-SUFFIX,example.org,DIRECT
  - DOMAIN,example.com,DIRECT
```

DNS 模块可以设置覆盖项，而保留其它原有 DNS 配置：

```yaml
dns:
  enhanced-mode: fake-ip
  nameserver:
    - https://1.1.1.1/dns-query
```

### GeoSite 分流 DNS

新安装默认启用 GeoSite/MMDB 覆盖配置项和分流策略：

- `geosite:private,cn` → UDP `223.5.5.5`。
- `geosite:proxy` → Cloudflare 与 Google DoH。
- 代理节点引导解析使用配置中的阿里 DoH，避免代理 DNS 递归。

继续使用现有 GeoSite/MMDB 下载 URL；本次不增加定时更新任务。升级会保留 `/etc/config/nikki-rs`，已有安装不会自动覆盖原 UCI 值。

Nikki RS 默认关闭，因此软件包不会自动改写 dnsmasq。若要让 LAN 客户端使用 Nikki DNS，先备份 `/etc/config/dhcp`，确认 Nikki DNS 正在 `1053` 端口监听，再执行：

```sh
uci set dhcp.@dnsmasq[0].noresolv='1'
uci -q delete dhcp.@dnsmasq[0].server
uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#1053'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

这会替换 dnsmasq 的全部上游服务器，并使 LAN DNS 依赖 Nikki RS。停止 Nikki RS 或更改 DNS 监听端口前，先恢复备份或调整 dnsmasq 上游。


**候选配置内核测试**：使用临时目录执行当前 `clash-rs -t`，不会改动运行中的配置。核心在初始化远程 rule-provider 等资源时可能因网络超时而失败，不能把此类结果直接理解为 YAML 语法错误。测试最长约 35 秒。

**注意**：规则优先级和 `nikki-*` 字段是 Nikki RS 的扩展约定，不是通用 Mihomo 配置字段。版本更新前可先通过预览与内核兼容性检查。合并预览可能包含订阅中的代理凭据，仅应在可信任的管理员会话中查看。

---



## LuCI 原生配置界面

新增界面沿用 LuCI 的标签页、表单、GridSection 表格与编辑弹窗，不再复制 Mixin Config 已有的设置：

- **Mixin Config**：继续管理端口、DNS/DNS2、TUN、嗅探、Geo、规则与规则提供者；Proxy Config 与 eBPF Config 保持原有职责。
- **Additional Settings**：只提供绑定地址、路由标记、三项 profile 状态缓存与 TCP 缓冲区六项补充设置。选择“Unmodified”删除相应 YAML 覆写并恢复继承；只提交实际修改字段。旧版本保存的其他覆写不会被自动删除，仍可在 Advanced Config 中检查。
- **Local Collections**：用原生可排序表格管理自定义策略组、独立入站监听器与通用代理提供者。支持新增、复制、删除及弹窗编辑。规则提供者使用 Mixin Config，不再重复提供第二套表单。
- **Advanced Config**：保留各模块 YAML 编辑、预览、内核测试、影响分析、版本备份和安全应用。复杂扩展字段也可在集合条目的 **Additional fields (JSON)** 中编辑；普通表单修改会保留未显示字段。

自定义组存入 `nikki-proxy-groups`，自定义监听器存入 `nikki-listeners`，合并时排在订阅原有条目之前，不修改原始订阅。Provider 映射按键补充或覆写；移除本地 Provider 不会删除订阅自身的同名定义。eBPF 模式仍然过滤最终配置中的 TUN 监听器。

旧 Configuration Center 和 Collections Builder 地址保持有效。旧 Ordered Rules 地址转到 **Advanced Config → Rules**，继续编辑原来的 `overrides/rules.yaml`，不会隐式迁移或删除历史规则。日常规则编辑统一使用 Mixin Config；历史 YAML 覆写仍有原有优先级，请检查避免同时维护冲突的两份配置。

**DNS2 历史数据**：旧版结构化编辑器保存到 `overrides/dns2.yaml` 的内容继续保留；更早写入 `dns.yaml` 的 `dns2` 字段同样不会自动清除。现在使用 Mixin Config 编辑 DNS2，必要时在 Advanced Config 手动检查旧覆写的优先级。

**安全提示**：监听 `0.0.0.0` 或 `::` 时应检查身份验证与防火墙，不要对公网开放未认证代理。不同 clash-rs 版本对高级字段的支持以本机内核测试为准；不提供特定机场 API 或 Mihomo 专有功能。

## 定期重启计划

**App Config → Scheduled Restart** 仅重启 Nikki RS 服务，不重启路由器。**Restart Schedule** 沿用 LuCI 原生可编辑下拉框，可选每天、每周日、工作日或每月首日 03:00，也可输入自定义五段 Cron。按路由器本地时间执行，重启可能中断现有连接。

字段顺序为 `分钟 小时 日 月 星期`；星期日为 0。支持列表、范围与步长（例如 `0 */6 * * *`），保存前检查范围与语法。现有自定义计划会原样显示，不会因为打开页面而被预设覆盖；关闭定期重启保留计划内容。

## 候选配置内核预检与安全应用

LuCI **服务 → Nikki RS → Advanced Config** 现提供两种保存方式：

- **Save module**：只保存编辑器内容，验证 YAML 并保留历史备份，**不会重启 Nikki RS**。
- **Save, test and apply safely**：明确确认后才执行全流程——检查当前服务是否正在运行、使用当前 `clash-rs -t` 测试合并配置、按文件修订版本保存候选模块、重启服务、验证服务状态和内核进程。

应用失败时，会在没有其他配置写入冲突的前提下恢复应用前的模块内容，并再次尝试启动 Nikki RS。页面会区分**恢复成功**与**恢复失败**，不会把恢复失败误报成成功。用于恢复的模块不是原始订阅，也不更改其他覆写模块。

为避免误操作，安全应用只允许已运行的 Nikki RS 服务；未启动的服务请先排查，或者仅使用普通保存功能。配置信息的内核预检可能受远程规则提供者超时影响。应用时代理可能短暂断线，请使用可访问路由器管理页面的连接进行操作。

当前实现检查服务状态及 clash-rs 进程存在，不代表所有远程代理节点、DNS 或外网出口都能正常连通；建议仍使用路由器本机进行连通性验证。

## 配置修改影响分析与安全保存

LuCI **服务 → Nikki RS → Advanced Config → Review configuration changes**：

- **更改范围**：比较当前已保存的覆写模块与编辑器中未保存的候选内容，列出发生变化的配置顶层字段（如 `dns`、`rules`、`proxy-groups`），不展示代理凭据或规则正文。
- **结构变化**：显示规则、节点、代理组、规则提供者的修改前后数量；检查重复规则、重复节点名称、重复策略组名称，以及 DNS/DNS2 都关闭的情况。
- **eBPF/TUN 优先级**：差异分析使用和正式启动相同的配置合并器，因此可以预览 eBPF 开启后的 TUN 自动禁用结果。
- **减少误报**：按规范化 JSON 数据比较，不把 YAML 注释、缩进或格式转换直接认定为业务配置变化。
- **并发写入保护**：版本检查与最终提交处于同一个文件级锁内，并拒绝覆写符号链接；保存依然会建立历史备份。

分析基于上次启动生成的 `/etc/nikki-rs/run/base.yaml`，比较的是**已保存的配置和当前草稿**，不是正在运行的内核配置。分析没有修改服务，也不能代替 **Test with installed core** 的实际内核校验。若此前尚未启动过 Nikki RS，需要先生成基础快照。

## eBPF 与 TUN 自动互斥

开启 LuCI **eBPF Config → Enable**（对应 `nikki-rs.ebpf.enabled=1`）后，Nikki RS 生成最终 Clash 配置时会自动执行兼容处理：

- 强制 `ebpf.enable: true`、`tun.enable: false`、`tun.enable-tcp: false`。
- 移除 `listeners` 中所有 `type: tun` 的监听器，保留 TPROXY、HTTP、SOCKS 等其他监听器。
- 兼容处理在订阅、`mixin.yaml`、UCI 和 Advanced Config 的各模块合并后执行，防止后续覆写重新打开 TUN；配置预览和内核测试同样使用处理后的内容。
- **不更改订阅文件、`mixin.tun_enabled` 或 `overrides/tun.yaml` 的保存值**。关闭 eBPF 并重新生成配置后，原有 TUN 设置继续生效。
- 只影响生成的配置文件。切换开关后需要重新应用或重启 Nikki RS，才能影响正在运行的 clash-rs 进程。

## 历史规则覆写与并发保护

现有 `overrides/rules.yaml` 可通过 **Advanced Config → Rules** 编辑，例如：

```yaml
nikki-rules:
  - DOMAIN-SUFFIX,example.net,DIRECT
  - IP-CIDR,192.0.2.0/24,REJECT,no-resolve
```

普通保存建立修订备份且不会重启服务；SHA256 修订检查拒绝覆盖其他窗口的新修改。请先预览和测试合并配置，再显式安全应用。新规则优先使用原有 **Mixin Config → Rule Config**，避免重复维护。

## 本地 UI 回归验证

`tests/browser/verify_luci.py --luci /path/to/luci` 使用真实 LuCI 客户端模块、Bootstrap 样式和模拟 RPC，检查桌面/390px 手机布局、标签重载、集合弹窗、类型校验、未知字段保留与历史规则入口。需要 Python Playwright 和 Chromium。截图及结果默认写入 `/tmp/nikki-luci-ui`；此验证不等于路由器部署或真实内核启动验证。

## 环境要求

- **OpenWrt** >= 24.10
- **Linux Kernel** >= 5.13
- **firewall4** (基于 nftables)

---

## 快速使用

### 方式 A：从软件源安装（推荐）

1. **添加软件源**：
   ```bash
   wget -O - https://github.com/CHKayanami/OpenWrt-nikki-rs/raw/refs/heads/main/feed.sh | ash
   ```

2. **安装软件包**：
   - **opkg**：
     ```bash
     opkg update
     opkg install nikki-rs luci-app-nikki-rs luci-i18n-nikki-rs-zh-cn
     ```
   - **apk**：
     ```bash
     apk update
     apk add nikki-rs luci-app-nikki-rs luci-i18n-nikki-rs-zh-cn
     ```

### 方式 B：从 Release 一键安装

```bash
wget -O - https://github.com/CHKayanami/OpenWrt-nikki-rs/raw/refs/heads/main/install.sh | ash
```

### 快速配置

1. 打开 OpenWrt LuCI 后台。
2. 导航至 **服务 (Services)** -> **Nikki RS**。
3. 导入订阅链接或配置文件，启动透明代理服务。

---

## 卸载与重置

```bash
wget -O - https://github.com/CHKayanami/OpenWrt-nikki-rs/raw/refs/heads/main/uninstall.sh | ash
```

---

## 编译指南

如需在 OpenWrt 源码或 SDK 中自行编译 `nikki-rs`：

```bash
# 添加 feed 软件源
echo "src-git nikki-rs https://github.com/CHKayanami/OpenWrt-nikki-rs.git;main" >> "feeds.conf.default"

# 更新并安装 feeds
./scripts/feeds update -a
./scripts/feeds install -a

# 编译软件包
make package/luci-app-nikki-rs/compile
```

编译生成的 ipk / apk 文件位于 `bin/packages/<架构>/nikki-rs` 路径下。

---

## 软件包依赖

- `ca-bundle`
- `curl`
- `yq`
- `firewall4`
- `ip-full`
- `kmod-inet-diag`
- `kmod-nft-socket`
- `kmod-nft-tproxy`
- `kmod-tun`
- `kmod-dummy`

---

## 致谢 (Credits)

非常感谢上游项目及开源社区优秀开发者的贡献：

- **[nikki](https://github.com/nikkinikki-org/OpenWrt-nikki)** ([@nikkinikki-org](https://github.com/nikkinikki-org))：感谢 nikki 项目团队设计并维护了 OpenWrt LuCI 界面与透明代理基础架构。
- **[clash-rs](https://github.com/Watfaq/clash-rs)**：感谢开发团队用 Rust 打造了高性能、轻量且强大的 Clash 代理内核。


