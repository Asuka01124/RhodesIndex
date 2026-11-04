"""微博和小红书共用的角色话题名单。"""

from douyin_topic_runtime import primary_topic_name


PREFIXED_NAMES = {
    "宴", "山", "梅", "空", "红", "遥", "阿", "黑",
    "布丁", "可颂", "慕斯", "古米", "红豆", "杏仁", "松果", "桑葚",
    "香草", "龙舌兰", "芙蓉", "苇草", "杜宾", "食铁兽", "医生", "调香师",
    "机械师", "摆渡人", "清道夫", "刻刀", "和弦", "号角", "风笛", "极光",
    "流星", "暴雨", "惊蛰", "四月", "小满", "初雪", "白雪", "微风",
    "清流", "石英", "石棉", "铸铁", "白金", "泡泡", "斑点", "爱丽丝",
    "杰西卡", "杰克", "罗宾", "卡夫卡", "麦哲伦", "因陀罗", "普罗旺斯", "九色鹿",
    "罗小黑", "莱欧斯", "玛露西尔", "森西", "齐尔查克", "丰川祥子", "若叶睦", "三角初华",
    "八幡海铃", "祐天寺若麦", "结城理", "埃癸斯", "岳羽由加莉", "虎狼丸", "艾拉", "灰烬",
    "闪击", "战车",
}


def make_character_topic_plan(operators):
    plan = {}
    for operator in operators:
        name = primary_topic_name(operator)
        prefixed = name in PREFIXED_NAMES
        tag = f"明日方舟{name}" if prefixed else name
        item = plan.setdefault(tag, {
            "key": tag,
            "tag": tag,
            "operatorIds": [],
            "scope": "arknights_prefixed_topic" if prefixed else "bare_character_topic",
        })
        item["operatorIds"].append(operator["id"])
    return sorted(plan.values(), key=lambda item: item["tag"] not in ("阿米娅", "黍"))
