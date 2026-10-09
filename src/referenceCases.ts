/**
 * Small, curated examples from the local NHRL snapshot. These are reference
 * shapes and labels only; missing values must be entered by the user before a
 * simulation is treated as a quantitative result.
 */
export interface ReferenceCase {
  id: string;
  name: string;
  weightClass: string;
  weapon: string;
  material: string;
  note: string;
  missing: string[];
  source: string;
  localSource: string;
  image: string;
}

export const REFERENCE_CASES: ReferenceCase[] = [
  {
    id: 'big-ish',
    name: 'Big-ish',
    weightClass: '12 lb',
    weapon: '垂直旋转刀片；资料写明约 3 lb，1/2 in 厚 AR500 steel',
    material: 'AR500 steel（牌号标签；密度、硬度和热处理未由本地条目给出）',
    note: '可作为盘式/刀片轮廓的起始案例；条目还记录 6061 铝车体、Propdrive 4248 650KV 与 2:1 减速。',
    missing: ['精确轮廓与直径', '武器实际质量分布/转动惯量', '峰值 RPM 与升速时间', '护甲厚度与碰撞数据'],
    source: 'https://wiki.nhrl.io/wiki/index.php?title=Big-ish',
    localSource: 'D:\\竞技机器人资料\\NHRL中文知识库\\机器人\\12lb\\Big-ish.md',
    image: '/references/big-ish.webp',
  },
  {
    id: 'carmen',
    name: 'Carmen',
    weightClass: '12 lb',
    weapon: 'Custom S7 Beater（打蛋器）',
    material: '车体材料标签：6061 Aluminum、AR500、Carbon Fiber、Grade 5 titanium、UHMW；武器牌号为 S7',
    note: '适合展示多材料机器人和打蛋器结构；本地条目没有可直接用于强度/损伤的材料本构。',
    missing: ['武器尺寸/厚度/质量', '密度与转动惯量', '峰值 RPM 与升速时间', '护甲各层厚度与连接方式'],
    source: 'https://wiki.nhrl.io/wiki/index.php?title=Carmen',
    localSource: 'D:\\竞技机器人资料\\NHRL中文知识库\\机器人\\12lb\\Carmen.md',
    image: '/references/carmen.webp',
  },
  {
    id: 'waddles',
    name: 'Waddles!',
    weightClass: '30 lb',
    weapon: '14 in AR500 disk + 4140 beater bar；下切式水平/复合旋转',
    material: 'AR500 steel 与 4140 steel（材料标签；未提供密度校准和热处理参数）',
    note: '可作为双武器或多轴结构的案例；条目含电机和传动标签，但不是实测 RPM 或冲击曲线。',
    missing: ['两件武器的厚度、质量和惯量', '峰值 RPM/升速曲线', '碰撞接触位置与护甲尺寸', '材料失效参数'],
    source: 'https://wiki.nhrl.io/wiki/index.php?title=Waddles%21',
    localSource: 'D:\\竞技机器人资料\\NHRL中文知识库\\机器人\\30lb\\Waddles!.md',
    image: '/references/waddles.webp',
  },
  {
    id: 'project-liftoff',
    name: 'Project LiftOff',
    weightClass: '3 lb',
    weapon: '整体旋转；模块化 AR500 武器环与齿',
    material: 'TPU 外壳 + AR500 武器环（条目描述）',
    note: '本地条目描述 2,000–4,000 RPM 和多次设计迭代；应选择具体迭代后再输入尺寸，不能混用版本参数。',
    missing: ['目标迭代的完整轮廓与厚度', '实际质量分布/转动惯量', '升速曲线', '护甲/地面碰撞几何'],
    source: 'https://wiki.nhrl.io/wiki/index.php?title=Project%20LiftOff',
    localSource: 'D:\\竞技机器人资料\\NHRL中文知识库\\机器人\\3lb\\Project LiftOff.md',
    image: '/references/project-liftoff.webp',
  },
];
