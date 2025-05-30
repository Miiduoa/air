def create_flex_message(location, content):
    return {
        "type": "bubble",
        "hero": {
            "type": "image",
            "url": "https://i.imgur.com/Hf6jAlp.png",
            "size": "full",
            "aspectRatio": "20:13",
            "aspectMode": "cover"
        },
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {"type": "text", "text": f"{location} 空氣品質", "weight": "bold", "size": "xl"},
                {"type": "text", "text": content, "margin": "md", "size": "md"}
            ]
        }
    }

# 如果有基本詞庫，可以用這種方法先嘗試抽出地區名
def extract_location_from_text(text):
    locations = ["台北", "新北", "桃園", "台中", "台南", "高雄", "新竹", "嘉義", "彰化", "雲林", "南投", "屏東", "宜蘭", "花蓮", "台東", "澎湖", "金門", "連江"]
    for loc in locations:
        if loc in text:
            return loc
    return None