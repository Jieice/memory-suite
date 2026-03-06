import requests

apis = [
    {
        'name': 'siliconflow',
        'url': 'https://api.siliconflow.cn/v1/chat/completions',
        'key': 'sk-wjziyhbaktockvshknswwwomzqkwnrinrqwlkhcuttbytfnh',
        'model': 'Qwen/Qwen3-8B',
    },
    {
        'name': 'aiping',
        'url': 'https://aiping.cn/api/v1/chat/completions',
        'key': 'QC-4ac6a96c9e5078222f1c066fb67892ad-abffe173d55547eab2c2c9b0dc1e26b1',
        'model': 'glm-4.7',
    },
]

for api in apis:
    print(f"测试 {api['name']} ({api['model']})...")
    try:
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f"Bearer {api['key']}"
        }
        payload = {
            'model': api['model'],
            'messages': [{'role': 'user', 'content': '你好，回复OK即可'}],
            'max_tokens': 20,
        }
        resp = requests.post(api['url'], headers=headers, json=payload, timeout=30)
        print(f"  Status: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
            print(f"  回复: {content[:50]}")
            print("  ✅ 可用!")
        else:
            print(f"  错误: {resp.text[:150]}")
    except Exception as e:
        print(f"  异常: {e}")
    print()
