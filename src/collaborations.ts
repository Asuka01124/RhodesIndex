import type { Operator } from './types';

// 按 PRTS「分类:联动干员」核对（2026-11-03），包含本作角色的联动形态。
// https://prts.wiki/w/分类:联动干员
// 使用独立形态 ID，避免将夜刀、黑角等本体一起排除；不按阵营猜测。
export const COLLABORATION_OPERATOR_IDS: ReadonlySet<string> = new Set([
  'char_456_ash', // 灰烬
  'char_457_blitz', // 闪击
  'char_458_rfrost', // 霜华
  'char_459_tachak', // 战车
  'char_4123_ela', // 艾拉
  'char_4124_iana', // 双月
  'char_4125_rdoc', // 医生
  'char_4126_fuze', // 导火索
  'char_4019_ncdeer', // 九色鹿
  'char_4067_lolxh', // 罗小黑
  'char_1029_yato2', // 麒麟R夜刀
  'char_1030_noirc2', // 火龙S黑角
  'char_4077_palico', // 泰拉大陆调查团
  'char_4141_marcil', // 玛露西尔
  'char_4142_laios', // 莱欧斯
  'char_4143_sensi', // 森西
  'char_4144_chilc', // 齐尔查克
  'char_4182_oblvns', // 丰川祥子
  'char_4183_mortis', // 若叶睦
  'char_4184_dolris', // 三角初华
  'char_4185_amoris', // 祐天寺若麦
  'char_4186_tmoris', // 八幡海铃
  'char_4217_makoto', // 结城理
  'char_4218_aigis', // 埃癸斯
  'char_4219_yukari', // 岳羽由加莉
  'char_4220_kormr', // 虎狼丸
  'char_1048_orchd2', // 焰狐龙梓兰
  'char_1049_catap2', // 雷狼龙S空爆
  'char_4215_buddy', // 罗德岛隐秘队
]);

export function collaborationRoster(operators: Operator[], includeCollaborations: boolean) {
  return includeCollaborations
    ? operators
    : operators.filter((operator) => !COLLABORATION_OPERATOR_IDS.has(operator.id));
}
