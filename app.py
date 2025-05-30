import os
from flask import Flask, request, abort
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, FlexSendMessage
import requests
import openai
from utils import create_flex_message, extract_location_from_text

# 設定你的LINE BOT資料
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "你的token")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "你的secret")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "你的openai-key")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

app = Flask(__name__)

@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers["X-Line-Signature"]
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)
    return "OK"

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_text = event.message.text

    # AI理解用戶輸入，抽取查詢地區
    location = extract_location_from_text(user_text)
    if not location:
        location = get_location_with_ai(user_text)
    if not location:
        reply_text = "請輸入要查詢的地區，例如：查詢台中空氣品質"
        line_bot_api.reply_message(
            event.reply_token,
            FlexSendMessage(alt_text="請輸入地區", contents=create_flex_message("查無地區", "請重新輸入地區名稱。"))
        )
        return

    # 查詢空氣品質API
    air_quality_data = get_air_quality(location)
    if air_quality_data:
        flex_msg = create_flex_message(location, air_quality_data)
        line_bot_api.reply_message(
            event.reply_token,
            FlexSendMessage(alt_text=f"{location} 空氣品質", contents=flex_msg)
        )
    else:
        line_bot_api.reply_message(
            event.reply_token,
            FlexSendMessage(alt_text="查無資料", contents=create_flex_message(location, "查無空氣品質資料"))
        )

def get_air_quality(location):
    url = f"https://data-external.airq.tw/v1/airquality/{location}"
    headers = {"Authorization": "Bearer a8947021-a75d-46a2-822f-280dcaad96db"}
    try:
        res = requests.get(url, headers=headers)
        if res.status_code == 200:
            data = res.json()
            # 你可根據API回傳格式自行調整
            pm25 = data.get("pm25")
            status = data.get("status")
            return f"PM2.5：{pm25}\n狀態：{status}"
        else:
            return None
    except:
        return None

def get_location_with_ai(text):
    openai.api_key = OPENAI_API_KEY
    prompt = f"請從這句話找出查詢的台灣地區名稱：{text}"
    try:
        response = openai.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": prompt}]
        )
        location = response.choices[0].message.content.strip()
        # 簡單檢查長度
        if len(location) > 1 and len(location) < 10:
            return location
    except:
        pass
    return None

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)