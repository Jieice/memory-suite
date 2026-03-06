import requests
import json

headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer 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'
}
payload = {
    'model': 'z-ai/glm4.7',
    'messages': [{'role': 'user', 'content': '分析这句话的情绪：我好难过，工作压力太大了。只输出JSON格式'}],
    'max_tokens': 200,
    'temperature': 0.5,
}

print('测试 z-ai/glm4.7...')
resp = requests.post('https://integrate.api.nvidia.com/v1/chat/completions', headers=headers, json=payload, timeout=60)
print(f'Status: {resp.status_code}')
print(f'完整响应: {json.dumps(resp.json(), ensure_ascii=False, indent=2)}')
