from flask import Flask, request, jsonify
from flask_cors import CORS
import json # 导入 json 模块以便更好地格式化打印

app = Flask(__name__)
# 允许所有来源的跨域请求，这对于本地调试通常是安全的
# 对于生产环境，你应该限制来源
CORS(app)

@app.route('/', methods=['POST', 'OPTIONS']) # 允许 POST 和 OPTIONS (用于 CORS 预检)
def receive_message():
    # Flask-CORS 会自动处理 OPTIONS 请求
    if request.method == 'POST':
        try:
            # 获取 POST 请求的 JSON 数据
            data = request.get_json()
            if data:
                # 在服务器控制台打印接收到的 JSON 数据 (格式化输出)
                print("=" * 20)
                print("Received Message:")
                print(json.dumps(data, indent=2)) # 使用 json.dumps 美化打印
                print("=" * 20)
                return jsonify({"status": "success", "message": "Data received"}), 200
            else:
                print("Received empty POST request.")
                return jsonify({"status": "error", "message": "No JSON data received"}), 400
        except Exception as e:
            print(f"Error processing request: {e}")
            # 打印原始请求体以便调试
            print("Raw request data:", request.data)
            return jsonify({"status": "error", "message": str(e)}), 500
    else:
        # Flask-CORS 会处理 OPTIONS 请求，这里理论上不会执行
        return '', 204


if __name__ == '__main__':
    print("Starting Flask server on http://localhost:8080")
    # 监听本地所有接口的 8080 端口
    app.run(host='0.0.0.0', port=9090, debug=True) # debug=True 会在代码更改时自动重启