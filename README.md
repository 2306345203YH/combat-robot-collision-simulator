# Combat Robot Collision Simulator · 竞技机器人碰撞实验室

在浏览器中模拟竞技机器人旋转武器与护甲、武器与武器的三维刚体碰撞。导入武器图片或平面 CAD 图纸，调整武器和车体参数，观察接触、转速、运动轨迹及能量变化。

A browser-based combat robot collision simulator with editable weapon profiles, image tracing, DXF/SVG import and 3D rigid-body physics.

**当前使用刚体模型，不计算真实凹陷、裂纹、断裂或材料破碎。** 适合比较几何与运动参数、理解碰撞过程，尚未经过实物试验标定。

## 功能

- 武器 × 护甲、武器 × 武器，以及武器触地测试。
- 武器材料名称、密度、轮廓、厚度、峰值转速、升速时间、初始转速、相位和转向。
- 车重、速度、起始距离、横向偏移、面向目标的角度和持续前进时长。
- 平板、斜板、折板及自定义护甲剖面，安装倾角范围 **0–180°**。
- PNG/JPG 二值化识别，自动提取外轮廓、孔洞及可能的中心点；支持两点尺寸标定。
- 导入 ASCII DXF、SVG 平面图纸，按文件单位或手动选择的单位转换尺寸。
- 拖拽、增删顶点、毫米坐标编辑、轴心调整，以及左右/上下翻转。
- 可关闭武器与自车体的干涉限制、允许护甲穿入地面、启用武器地面接触。
- 三维视角、时间轴、慢动作、单步、接触点/法线、运动轨迹和数据曲线。
- 浏览器内保存工程、JSON 导入导出、CSV 曲线、PNG 截图、HTML 报告及运行结果对比。

图纸识别、碰撞计算和工程保存均在访问者浏览器中执行，不需要账号，也不把图纸上传到服务器。

## 本地启动

安装 **Node.js 24**，克隆仓库或下载解压，进入项目根目录。

### Windows 快捷启动

双击 `启动碰撞实验室.cmd`。首次启动会安装依赖并构建，随后打开 `http://127.0.0.1:5173/`，启动窗口会打印同一局域网设备可访问的地址。

修改代码后先执行 `npm run build`，再刷新页面或重新使用启动脚本。其他设备无法访问时，检查 Windows 防火墙是否允许 Node.js 通过专用网络。

### 命令行开发

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173/`。需要局域网访问时执行：

```bash
npm run dev -- --host 0.0.0.0
```

其他设备访问 `http://运行电脑的局域网IP:5173/`。端口固定为 5173，若已占用，请先关闭占用服务。

测试与生产构建：

```bash
npm test
npm run build
```

生产网页生成到 `dist/`，服务器部署使用下方容器方式。

## Docker 部署

服务器需要 Docker Engine 和 Docker Compose v2；Windows Docker Desktop 使用 Linux 容器模式。进入克隆后的项目根目录执行：

```bash
cp .env.example .env
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 60
docker compose ps
curl -fsS http://127.0.0.1:8080/health
```

Windows PowerShell 将第一行替换为 `Copy-Item .env.example .env`。

默认入口 **`http://服务器IP:8080/`**，健康检查返回 `ok`。开放服务器防火墙/安全组的 TCP 8080，即可通过局域网或服务器地址访问。`--wait-timeout` 限制启动后的健康等待时间，不限制镜像构建时间。

镜像内使用 Node.js 24 安装锁定依赖、运行测试并构建，再由 Nginx 提供静态网页。宿主无需 Node.js 或预先生成的 `dist`，容器配置包含自动重启、健康检查和日志大小限制。

需要修改端口时编辑服务器自己的 `.env`：

```dotenv
LAB_BIND_ADDRESS=0.0.0.0
LAB_PORT=8081
```

重新执行 `docker compose up -d --wait --wait-timeout 60`，随后使用 8081 访问。`.env` 不提交到 Git。

域名与 HTTPS 可由宿主机 Nginx/Caddy 反向代理提供。网页资源采用根路径，应部署在独立域名或 `/`；直接挂到子路径需要调整构建配置。

## 通过 Git 更新

开发电脑修改代码后提交并推送：

```bash
git add .
git commit -m "Update collision simulator"
git push
```

服务器进入原先克隆的项目目录，执行：

```bash
sh deploy/update.sh
```

脚本要求工作区无本地修改、当前分支有远端跟踪。它执行 `git pull --ff-only`，先构建镜像，再替换容器并等待健康检查。构建期间旧服务继续运行，替换时有短暂停顿；启动失败不会自动回退。

也可以手动更新：

```bash
git pull --ff-only
docker compose build
docker compose up -d --no-build --wait --wait-timeout 60
```

更新后刷新网页。仅执行 `docker compose restart` 不会部署新的源代码。

查看日志或停止服务：

```bash
docker compose logs --tail=100 collision-lab
docker compose down
```

## 使用流程

1. 选择武器 × 护甲或武器 × 武器，使用内置轮廓或导入图片/DXF/SVG。
2. 核对图片比例、CAD 单位、孔洞和轴心，必要时修改轮廓或翻转方向。
3. 设置密度、厚度、转速、车重、速度、起始距离和角度。
4. 在“接触与求解设置”中选择地面接触及干涉开关，设置持续前进时长；填 0 表示自由碰撞。
5. 点击“开始碰撞”，等待计算完成，使用时间轴和曲线查看结果；修改参数后需重新计算。
6. 保存或导出工程，也可以将上次结果作为对比基线。

## 物理模型与限制

根据几何、厚度和密度计算质量、质心与三维惯量，再由 Rapier 求解带关节的刚体接触。基本关系包括角速度 `ω = 2πn / 60` 和旋转动能 `E = ½Iω²`；页面可查看物理解释及数值诊断。

- 材料名称是标签，密度预设是可修改的教学假设，不会自动生成材料强度数据。
- 没有塑性凹陷、应力云图、裂纹或真实碎片；接触高亮与箭头表示接触信息。
- 峰值转速和升速时间采用线性升速近似，启用武器驱动后采用有限净扭矩近似。
- 车体采用均匀刚体，地面采用摩擦接触近似，未建立完整轮胎、悬架和底盘驱动模型。
- 关闭自车体干涉限制可允许武器与车体几何重叠，但连接仍禁用自碰撞，不能模拟武器切割自己的车体。
- 图片需要尺寸标定；不支持二进制 DXF、DWG 或三维 STEP 实体，复杂图纸的导入结果需人工核对。

真实变形或破碎需要后续接入材料模型、有限元求解与实测标定，目前未实现。

## 数据保存

“保存工程”使用访问者浏览器的 IndexedDB。服务器不保存共享实验记录，本版不需要数据卷。

记录按协议、域名/IP、端口及浏览器区分。切换服务器、端口、HTTPS 或设备前，先导出 JSON，再在新地址导入。同一访问地址下，替换容器不会直接清除浏览器记录；清理浏览器数据会清除本机存档。

## 项目结构

```text
src/
  components/       参数面板、轮廓编辑器、三维视口与结果
  imaging/          二值化与轮廓识别
  importers/        DXF/SVG 平面图纸解析
  physics/          几何、质量/惯量与 Worker 碰撞求解
public/             图标与案例图片
deploy/             Nginx 配置与 Git 更新脚本
Dockerfile          构建及静态服务镜像
docker-compose.yml  端口、重启与健康检查
```

技术栈：React、TypeScript、Vite、Three.js、Rapier、Recharts、KaTeX。依赖版本固定在 `package.json` 和 `package-lock.json`；构建需要联网获取镜像和依赖，锁文件当前使用 `registry.npmmirror.com`。

仓库保留代码、运行资源、构建部署配置及本 README；本地计划、项目记忆、实验输出、依赖目录和其他资料不会提交。
