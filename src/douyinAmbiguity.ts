import type { Operator } from './types';

// 用户指定隐藏2026-11-03抖音总排行的前29项。
// 固定条目ID，不随筛选、排序、联动开关或后续数值变化重新选取前29名。
export const DOUYIN_AMBIGUOUS_OPERATOR_IDS: ReadonlySet<string> = new Set([
  'char_4125_rdoc', // 医生
  'char_304_zebra', // 暴雨
  'char_174_slbell', // 初雪
  'char_130_doberm', // 杜宾
  'char_290_vigna', // 红豆
  'char_201_moeshd', // 可颂
  'char_149_scave', // 清道夫
  'char_422_aurora', // 极光
  'char_181_flower', // 调香师
  'char_118_yuki', // 白雪
  'char_381_bubble', // 泡泡
  'char_4067_lolxh', // 罗小黑
  'char_347_jaksel', // 杰克
  'char_126_shotst', // 流星
  'char_195_glassb', // 真理
  'char_473_mberry', // 桑葚
  'char_4004_pudd', // 布丁
  'char_4230_mcnist', // 机械师
  'char_101_sora', // 空
  'char_338_iris', // 爱丽丝
  'char_144_red', // 红
  'char_4122_grabds', // 小满
  'char_1042_phatm2', // 酒神
  'char_306_leizi', // 惊蛰
  'char_264_f12yin', // 山
  'char_107_liskam', // 雷蛇
  'char_344_beewax', // 蜜蜡
  'char_4182_oblvns', // 丰川祥子
  'char_2014_nian', // 年
]);

export function hideAmbiguousDouyinTopics(operators: Operator[], hide: boolean): Operator[] {
  return hide
    ? operators.filter((operator) => !DOUYIN_AMBIGUOUS_OPERATOR_IDS.has(operator.id))
    : operators;
}
