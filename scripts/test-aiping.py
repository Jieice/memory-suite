import requests

headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer QC-4ac6a96c9e5078222f1c066fb67892ad-abffe173d55547eab2c2c9b0dc1e26b1'
}
payload = {
    'model': 'glm-4.7',
    'messages': [{'role': 'user', 'content': '你好'}],
    'max_tokens': 50,
}

print('测试 aiping glm-4.7...')
try:
    resp = requests.post('https://aiping.cn/api/v1/chat/completions', headers=headers, json=payload, timeout=30)
    print(f'Status: {resp.status_code}')
    print(f'Response: {resp.text[:500]}')
except Exception as e:
    print(f'Error: {e}')
