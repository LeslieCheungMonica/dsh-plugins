# dsh-feishu-login

一个 DeepSeek Harness **Web 插件**：在打开 GUI 之前先打开一个**飞书扫码登录页**——
用手机端飞书扫码、在飞书侧确认授权，Host 端向飞书核验身份，**只有核验通过才把 GUI 的
HTML 发出去**。

- 登录页是 Host 自己渲染的独立页面（默认 `/login`），页面中央就是飞书的二维码；
- 二维码用不了时，同一张卡片上有「整页打开飞书登录页」的兜底入口；
- 登录成功后签发一个签名会话 Cookie，回到你原本要去的地址（`?next=`）；
- 通过 `allow` 白名单控制谁能进（按 `open_id` / 邮箱 / 邮箱域 / 工号 / 手机号）；
- 登录后的身份在**左下角**：身份行落在 `dsh-web-ui` 侧边栏底部的「账号停靠位」里，点它向上
  打开抽屉，抽屉里是**使用情况 / 插件 / 技能 / 产品卡 / 设置 / 退出登录**（使用情况就地展开，
  插件打开一个与「设置 → 插件」同款列表的弹窗，这两个都由 `dsh-web-ui` 自己画；技能与产品卡
  目前是空壳入口，点了不做事；设置来自 `ui-settings`，退出登录由本插件提供）；
  同时把原本占右上角那个位置的官方「Session log」下载按钮**顶掉**（`hideSessionLog`，默认开）。
  只有在**没有 `dsh-web-ui`**（或它的接管还在重试）的部署里，才退回成原来那个右上角胶囊；
- **未配置 App ID 时插件完全惰性**：Host 半边不注册任何路由、不注入任何脚本、不拦截任何请求；
  浏览器半边读到「宿主没说它武装了」就**什么都不注册**（不探测、不画 DOM、不发请求）。

## 三层拦截

浏览器遇到的三道关卡，缺一层都不行：

1. **服务端文档门（`GET /`、`GET /index.html`）** —— 没有有效会话时直接
   `302 <loginPath>?next=…`。未登录的浏览器**根本拿不到** GUI 的 HTML。
   这两个路径是 frontend-static 的 fallback 会当作文档回答的路径，本插件用 exact 路由
   接管它们，并用公开的 `ctx.webServer.applyIndexTaps` 复现同一份渲染（boot manifest 就是
   它注入的）。
2. **index tap（预启动脚本）** —— 注入到**每一次** index 渲染里（包括前端对深链接给出的
   SPA fallback），是 `<head>` 里的第一个 classic script：模块脚本是 deferred 的，所以它在
   应用 bundle 执行**之前**同步读一次 hint cookie，没有就 `location.replace` 到登录页。
   页面因此完全不闪、不启动。
3. **浏览器半边（`shell.overlay` 占用者）** —— 打开着的标签页里会话过期时，它再问一次
   `<prefix>/session`，答案不一致就盖一层不透明全屏遮罩并跳转。这一层专门补服务端看不到的
   情况（会话在页面打开期间失效）。

`shell.overlay` 是**列表**槽位（可叠加、默认点透），所以本插件不抢任何现有 UI；如果注册到
`root`，就会把 `ui-layout` 的整帧连同它声明的 sidebar / conversation / details 一起顶掉。

## 安装

插件必须能被拥有 `cordis.yml` 的 profile 目录解析到，并作为一条 Loader 行存在。

### 方式 A —— symlink + profile patch（本机就是这么装的）

```sh
ln -sfn /Users/liyanhui/vscodeProjects/dsh-plugins/dsh-feishu-login \
        ~/.dsh/profiles/web/node_modules/dsh-feishu-login
```

然后把这段加进 `~/.dsh/profiles/web/cordis.patch.yml`（本机已加，配置项是注释状态）：

```yaml
- insert:
    - id: feishu-login
      name: dsh-feishu-login
      config:
        appId: cli_xxxxxxxxxxxxxxxx
        appSecretRef: FEISHU_APP_SECRET
        allow:
          - email:@asiainfo.com
```

profile patch 是被监听的：**存盘即生效，刷新页面即可**，不需要重启 `dsh web`。新插件的
client bundle 走 `/plugins/<id>/client.js`，同样在扫描后被挂进 boot graph。

### 方式 B —— bundle 安装

`dsh.bundle.patch` 指向本包的 `cordis.patch.yml`：

```sh
dsh plugin --profile web add /Users/liyanhui/vscodeProjects/dsh-plugins/dsh-feishu-login
```

之后重启 `dsh web`（bundle 成员在启动时固定）。两种方式**只能二选一**，否则会插入两行。

### 构建

```sh
node node_modules/tsdown/dist/run.mjs                            # 或 npm run build
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # 类型检查
```

`lib/index.js` 是 Host 半边（ESM，只依赖 node 内置模块 + `@deepseek-ai/schemastery`）；
`lib/client.js` 是浏览器半边（经典脚本，通过 `window.__ModuleLoader__.load({ id })` 注册闭包
工厂）。`lib/client.js` 是 HMR 监听的产物：改完重新 build，刷新页面即可。

## 配置飞书应用

1. 在[飞书开放平台](https://open.feishu.cn/)创建一个**企业自建应用**；
2. 「添加应用能力」→ 添加 **网页应用**；
3. 「安全设置 → 重定向 URL」里登记**回调地址**。它由请求的 Host 推导，所以用到哪些地址就要
   登记哪些，必须**完全一致**（不支持通配符；`?` 之后的部分不生效）：

   | 访问方式 | 需要登记的回调地址 |
   |---|---|
   | `http://127.0.0.1:3080/` | `http://127.0.0.1:3080/feishu-auth/callback` |
   | `http://localhost:3080/` | `http://localhost:3080/feishu-auth/callback` |
   | 局域网 IP | `http://192.168.x.x:3080/feishu-auth/callback` |

   登录页底部会把**当前这次访问**要登记的地址原样打出来，照着抄即可（`showRedirectUri: false`
   可关掉）。

4. 「权限管理」按需开通：
   - 纯登录（只拿 `open_id` / 姓名 / 头像）**不需要任何权限**；
   - 白名单要按邮箱判断 → 开 `contact:user.email:readonly`，并在 `scopes` 里写上
     `contact:user.email:readonly`（授权页请求了没开通的权限会报 `20027`）；
   - 要工号 → `contact:user.employee_id:readonly`；要手机号 → `contact:user.phone:readonly`。
5. 「版本管理与发布」创建版本，配置**可用范围**并提交管理员审核。**没发版之前配置不生效**；
   开发期建议用「测试企业」（权限改动自动生效，但注意**测试版是另一个 `app_id`**）。

### 密钥（**必须**）

换票是服务端行为，而开放平台里创建的自建应用都是 **Confidential Client**：`oauth/v3/token`
必须带 `client_secret`，没有「不要密钥」的注册方式（Public Client 不对外开放）。所以密钥是**必需**
的——它不能放到浏览器里（token 与 `user_info` 接口都不返回 CORS 头，且密钥绝不能进前端）。

密钥**不写进插件配置**：`appSecretRef` 是一个**凭证引用**（POSIX 风格的环境变量名），由
`ctx.credentials` 在**每次请求**时解析，所以轮换密钥下一次请求就生效、不用重启。

这个宿主已经组合了 `dsh-credentials-local`，按信任度分层：

```text
继承来的进程环境              （只读，优先级最高）
> $DSH_HOME/.credentials.yaml  （宿主托管、可写，本机就是 ~/.dsh/.credentials.yaml）
> <启动目录>/.env              （只读兜底）
> $DSH_HOME/.env               （只读兜底）
```

**最省事的写法**——往 `~/.dsh/.credentials.yaml` 里加一行（该文件是严格映射，且**热生效**：
本机实测改完不需要重启，下一次请求就解析到新值）：

```yaml
DSH_FEISHU_LOGIN_SECRET: 你的应用密钥
```

⚠️ **但引用名不能和 shell 里已有的同名环境变量撞。** 分层规则的第一行就是
「继承的进程环境（只读，**优先级最高**）」：如果你在 `~/.zshrc`（或启动 `dsh web` 的那个窗口）里
`export FEISHU_APP_SECRET=…`（比如为了别的应用），那么：

- **它永远赢**，往凭证文件里写多少次都没用 —— 表现为扫码后换票报
  **`20002 The client secret is invalid`** / **`10014 app secret invalid`**；
- 这种遮蔽**完全静默**：`configured` 照样是 true，只是值是别人家的，日志里也没有任何提示。

诊断一行（看运行中的进程继承了哪些相关变量）：

```sh
ps eww -p $(lsof -nP -iTCP:3080 -sTCP:LISTEN -t) | tr ' ' '\n' | grep -E '^(FEISHU|DSH_)' | sed -E 's/=(.{4}).*/=\1…/'
```

所以：**引用名挑一个环境里不存在的**（本机用的是 `DSH_FEISHU_LOGIN_SECRET`），或者把那个 `export`
从 shell 里去掉。

没有 `dsh-credentials` 的宿主会退回读 `process.env[appSecretRef]`；实在都没有，才用配置里的
`appSecret`（不推荐：它会留在 644 的 patch 文件里，而凭证文件是 600）。不想重启又必须立刻换密钥时，
`appSecret` 是唯一**不重启就生效**的路子——patch 的改动是热生效的。

没有 `dsh-credentials` 的宿主会退回读 `process.env[appSecretRef]`；实在都没有，才用配置里的
`appSecret`（不推荐，它会留在 patch 文件里）。

## 准入白名单

`allow` 为空 = **该应用可用范围内的任何人都能进**。要收紧就写规则：

| 规则 | 含义 |
|---|---|
| `*` | 所有人 |
| `none` | 谁都不许（用于临时关门） |
| `email:@asiainfo.com` | 邮箱域匹配 |
| `email:me@asiainfo.com` | 指定邮箱（`enterprise_email` 也参与匹配） |
| `open_id:ou_xxx` | 指定用户（**open_id 是按应用隔离的**，换应用就变） |
| `union_id:on_xxx` / `user_id:xxxx` / `mobile:138…` | 其余标识 |
| `ou_xxx`（不带前缀） | 与所有身份字段做等值比较 |

**怎么知道自己该填什么**：每次登录成功，Host 日志都会打一行
`feishu-login: login ok: 李彦辉 open_id=ou_… email=…`；被白名单拒绝时页面也会把身份字段
完整列出来（Host 日志同样记一行 warning）。复制进 `allow` 即可。

**最省事的顺序**：先让 `allow` 为空（该应用可见范围内的人都能进）把扫码链路跑通，从日志里拿到
自己的 `open_id` / 邮箱，再把规则填进去 —— 这样白名单一定匹配得上。

如果规则指向的字段飞书**根本没返回**（例如 `email:@corp.com` 但应用没开
`contact:user.email:readonly`），拒绝页和 Host 日志会直接点名缺哪个 scope：`user_info` 对
`email` / `user_id` / `mobile` 是**静默不返回**的，不会报错——没有这条提示，这种拒绝看起来
和「白名单写错了」一模一样。

## 三种登录形态

| `mode` / `qrEmbed` | 行为 | 说明 |
|---|---|---|
| `embed` + `sdk`（默认） | 登录页加载飞书官方二维码 SDK（`LarkSSOSDKWebQRCode-1.0.3.js`），它把紧凑 QR 页嵌进自己的 250px 框 | 框内布局由飞书自己保证：实测二维码 y33~267，**在 300×300 的框里完整可见**。唯一外部依赖是 CDN 脚本，加载失败会显示提示并引导用下面的按钮 |
| `embed` + `page` | 直接 iframe 飞书的 `qrconnect` 登录页 | 不依赖第三方脚本；但那页在**窄宽度下会把语言切换栏和标题排在二维码上面**（实测二维码在 y183~407），所以本插件按测量值把它**加高再上移**（`iframe.offset { height:472px; margin-top:-172px }`），让 300×300 的可视窗口正好落在二维码上。飞书若重设计那页，需要重新量一次 |
| `redirect` | `/login` 直接 302 到飞书自己的授权页 | 完全按官方文档走，最稳；代价是登录页是飞书的样式 |

**这段几何是踩出来的**：第一版把 iframe 做成 300×300，用户看到的是「语言切换栏」而二维码被裁在框外
（症状正是"登录页出来了但二维码没刷出来"）。现在 `verify-armed.mjs` 里有一条回归用例按
**登录页坐标**断言「二维码完整落在框内」，任何嵌法漂移都会立刻红。

`embed` 两种形态下，卡片上都保留「整页打开飞书登录页」的按钮：浏览器的第三方 Cookie 限制会让
iframe 里的扫码失败（飞书登录页会下发 `SameSite=None` 的 cookie），这时点它走顶层跳转即可。

## 验证

```sh
node scripts/smoke.mjs                 # 23 项：Host 半边全链路（飞书接口在 wire 上打桩）
node scripts/smoke-browser.mjs         # 17 项：对**正在运行**的 GUI 做浏览器验证
node scripts/verify-armed.mjs --browser # 20 项：对**已武装**的 GUI 做真机前演练
node scripts/probe-redirect.mjs        # 问飞书：这个应用到底认哪些重定向地址
node scripts/preview-login.mjs         # 用真实渲染器生成登录页并截图 + 排版自检
```

`probe-redirect.mjs` 是排查 `20029` 的利器：授权页对不在名单里的 `redirect_uri` 一律回
`20029`，所以**对每个候选地址加载一次那个页面就等于把控制台里的名单读出来**——不用进控制台、
不用猜。它把我们的回调、带尾斜杠的、裸 origin、`localhost` 变体全部试一遍：如果**全都**被拒，
那就不是"字符串填错了"，而是这个应用的可用重定向列表还是空的（多半是**配置没发版生效**）。

`verify-armed.mjs` 是「扫码前把两边都验一遍」：它用插件**自己的** `issueSession` 签一个会话
（所以签名方案与宿主完全一致，且这一步本身自证 —— 宿主接受了就说明格式对），然后验证
`/` 被 302 拦住、登录页渲染、静态资源照旧、伪造 Cookie 打不开文档、已登录文档带着预启动脚本、
左下角账号行里出现身份；**并且直接打开飞书那个二维码页，把飞书自己的回答原样读出来** ——
重定向 URL 没登记（`20029`）、没开网页应用能力这类问题，都在拿起手机之前就暴露了。

它从 profile patch 读 `appId`、从 `~/.dsh/.credentials.yaml` 读密钥，且**从不打印密钥**。

`smoke.mjs` 不需要凭证、不需要手机：它驱动真实的处理函数，断言未配置即惰性、伪造 state 被拒、
`v3 → v2` 换票回退、完整链路（扫码 → 换票 → 取身份 → 白名单 → Cookie → 受门保护的文档）、
白名单放行/拒绝/**缺 scope 时的点名提示**、`redirect` 与 `lark` 分支、index tap 的注入位置与
幂等、预启动脚本在真实 DOM 契约下的三种行为（无 Cookie 跳转 / 有 hint 放行 / 循环守卫）、
`next=//evil.example` 被丢弃、密钥缺失时**放行且大声报错**。

`smoke-browser.mjs` 打桩 `/feishu-auth/session`：未配置时插件必须**什么都画不出来**，报告已登录
时出现身份胶囊，报告未登录时标签页被推到 `/login?next=…`；并读插件列表里那颗状态点，确认
**Host 半边的 fiber 是 active 而不是 failed**（即 `apply` 真的跑完了）。Playwright 是 dev-only
依赖，从 `dsh-web-ui/node_modules` 解析；若本机 chromium 版本不匹配，用 `CHROME=<可执行文件>`
指定。

`preview-login.mjs` 还会顺手检查排版（卡片居中、二维码 300×300、品牌 mark 已绘制、兜底按钮在），
不需要人肉看图。

## 身份放哪，以及「Session log」按钮怎么没的

**身份和退出动作分在两个座位上，都由 `dsh-web-ui` 声明，本插件去填**（`src/client/Gate.tsx`）：

| 是什么 | 在哪 | 用的座位 |
|---|---|---|
| 身份（头像 + 名字） | 侧边栏左下角的账号行 | `sidebar.account`，单值座位，由 `dsh-web-ui` 的 `sidebar` 注册声明 |
| 退出登录 | 账号行上方那个抽屉里的一行 | `sidebar.account.menu`，列表座位，`id: feishu-login-sign-out` |
| 兜底胶囊（只在没有 `dsh-web-ui` 时出现） | 会话标题栏那一行（右侧 utility 区） | `conversation.session.header.utilities`，列表座位，`id: feishu-login-account` |

**为什么不在右上角了。** 右上角那个角落是框架自己的控件该在的地方，而账号是**一天碰一次**的
东西；它现在和「设置」一起待在左列底部，点一下向上开抽屉，抽屉里六行依次是使用情况、插件、
技能、产品卡、设置、退出登录（其中技能与产品卡是空壳入口，点了不做事）。抽屉本身、账号行、
箭头、前四行都是 `dsh-web-ui` 的，本插件只负责往里画「我是谁」和
「怎么退出」——这也是为什么两个插件谁都不 import 谁：客户端 bundle 之间有纯度限制（见本文件
「依赖」一节），而**槽位 key 本身就是契约**。

**座位 shape 为什么两边各声明一次。** 这个组合里的插件**不发类型声明**（本包的 `tsdown` 只出
`lib/*.js`），所以填座位的一侧必须自己把吃到的 owner share 重新声明一遍，接口合并后两边
是同一个类型。多出来的那十行就是这个跨包契约的代价。

**兜底是有界的，不是第二个家。** 没装 `dsh-web-ui` 的部署永远不会有这两个座位，
`slots.inject` 会一直不触发，于是**整页都没有退出口**——那比「右上角有个胶囊」更糟。所以本插件
起了一个 `HEADER_FALLBACK_MS`（2s）的定时器：座位一直没出现就把原来的右上角胶囊注册回去；
座位一出现就把它撤掉，并且**再也不回来**（`dsh-web-ui` 是在自己的 `apply` 里同步声明这两个座位
的，所以这个兜底只有在那个插件真的不在、或者它自己的 ~5s 接管重试还没成功时才会活下来）。

**退出登录那一行故意不先关抽屉。** 点下去之后：成功会跳走，失败则把「退出失败，请重试」写在
这一行上——那一行只有抽屉还开着才看得见。

**「Session log」按钮是被「顶掉」的，不是被 CSS 藏起来的。** 那个按钮由
`@deepseek-ai/dsh-session-log-export` 注册在 `conversation.session.header.utilities` 上，
id 是 `session-log-download`。列表座位**一个 id 一个格子、优先级最低者胜**，所以本插件用同一个
id 在 `priority: -1` 注册一个渲染 `null` 的条目，就把它从 DOM、Tab 顺序和无障碍树里一起拿掉了
—— 而那个包自己的下载对话框与 `/export` 命令**原封不动**，只是没有按钮触发它。
`hideSessionLog: false` 可以把按钮放回来（那时兜底胶囊排在它右边）。

> 为什么不直接 disable `session-log-export` 那一行？那会连带拿掉 `/export` 命令和
> `sessionLogDownload` 服务；而这里要的只是「这个角落归胶囊」。

## 已知边界

- **密钥可能被 shell 的同名环境变量静默遮蔽**（详见「密钥」一节）：现象是换票报 20002/10014，
  而 `configured` 仍然是 true。引用名要挑环境里不存在的。
- **Host 半边改动不会热加载。** 浏览器半边（`lib/client.js`）有 HMR：重新 build + 刷新页面即可。
  Host 半边（`lib/index.js`）是 Node 模块，Loader 只 `import()` 一次（Node 按 URL 缓存），
  **改完必须重启 `dsh web`**。改配置（patch 文件）不需要重启，行会重新 compose。
- **`ctx.baseUrl` 是 file:// URL**（`app-boot` 写的是 `pathToFileURL(dirname(cfg)).href + '/'`），
  不是普通目录。本插件早期版本先 `join()` 再 `pathToFileURL()`，把锚点揉成了 `file:/…`，
  于是解析失败、**服务端文档门静默关闭**（只剩预启动脚本与浏览器半边在工作）。
  现在两种形状都吃，且失败会**出声**：日志说明是哪一步失败、门是关的。
  `smoke.mjs` 里那两个 `dist resolution` 用例就是钉这个回归的。
- **`/api` 不在本插件的门内。** webserver 的路由表只有 exact / prefix / fallback 三种座位，
  没有中间件，而 `/api` 的 prefix 座位被 API 桥占用，本插件无法插到它前面。所以这道门保护的是
  **界面与文档入口**；直接构造 `/api/...` 请求仍可访问宿主能力。真正要在这层做访问控制，得在
  webserver 里加一层前置钩子（或让 API 桥自己支持鉴权），那是另一个改动。默认只监听
  `127.0.0.1` 时这一层本来就只有本机用户可达。
- **未配置即放行（fail-open）。** 没有 `appId`、或密钥解析不出来时，插件宁可不管也不锁门：
  文档门放行、登录页给一张「登录未配置」的说明页，同时 Host 日志大声报错。这样绝不会有
  「配置不全 → 自己被关在门外」的结果。
- **Cookie 是无状态签名，没有服务端吊销表。** 「退出登录」清的是浏览器上的 Cookie；已经泄露的
  旧 Cookie 在过期前仍然有效。会话默认 12 小时（`sessionTtlHours`）。
- **扫码的前提是该用户能用这个应用**：不在可用范围内会报 `20010`（企业未安装是 `20009`），
  这和本插件无关，是飞书后台的可用范围设置。
- **hint cookie 只是提示。** 预启动脚本同步读到的那个 `=1` 可以被伪造，伪造的收益是「看到一个
  壳」，服务端文档门和 `/feishu-auth/session` 复核都会把它按未登录处理（应用数据请求照旧被
  宿主拒绝）。
- **`/connect/qrconnect/page/sso/` 是仍在服务但已不再被官方文档引用的旧入口。** 这正是默认
  之外还提供 `sdk` 与 `redirect` 两种形态的原因。
- **深链接的 SPA fallback 由前端自己回答**，本插件拦不到那个座位，靠 index tap 里的预启动脚本
  兜住（脚本先跳转，应用不启动）。这是路由表限制下的最优解。
- **改过配置把自己锁在外面怎么办**：在 profile 的 `cordis.patch.yml` 里给这一行加 `gate: false`
  （或删掉行）。patch 文件是被监听的，**下一次请求就已经放行**，不用重启。
- **只在 Web（浏览器）载体里工作。** Electron 载体走 `file://` + IPC，不经过 webserver。

## 自定义

| 想改什么 | 改哪里 |
|---|---|
| 登录页文案 / 主副标题 | 配置 `title`、`subtitle`、`brandName` |
| 去掉登录页上的品牌图形 | 配置 `showBrandMark: false`（图形本体在 `src/host/pages.ts` 的 `BRAND_MARK`） |
| 登录页配色 | `src/host/pages.ts` 的 `STYLE`（跟随 `prefers-color-scheme`） |
| 路由前缀 / 登录页路径 | 配置 `routePrefix`、`loginPath` |
| 会话时长 / Cookie 名 | 配置 `sessionTtlHours`、`cookieName`、`hintCookieName`、`cookieSecure` |
| 身份的外观（头像 / 名字 / 退出行的文案） | `src/client/styles.ts` 的 `account` 变体与 `src/client/locales.ts`（身份行与抽屉的几何属于 `dsh-web-ui`，见上一节）；关闭整块账号 UI 用 `accountChip: false` |
| 「Session log」按钮的去留 | 配置 `hideSessionLog`（默认 `true` = 顶掉；见上一节） |
| 遮罩层文案 | `src/client/locales.ts`（命名空间 `feishulogin`） |
| 白名单语义 | `src/host/config.ts` 的 `isAllowed` |
| 换票顺序与端点 | `src/host/feishu.ts` 的 `Endpoints` 表与 `exchangeCode` |
| 三层拦截本身 | `src/host/plugin.ts`（路由）、`src/host/gate.ts`（预启动脚本）、`src/client/Gate.tsx`（遮罩） |

## 依赖

- Host 半边：只 import `node:*` 与宿主提供的 `@deepseek-ai/schemastery`，无运行时依赖。
- 浏览器半边：只用 `react` / `react/jsx-runtime` 这两个基线模块；`@deepseek-ai/dsh-client-*`
  全部是**类型导入**（构建期被擦除），符合 client bundle 的纯度规则。
