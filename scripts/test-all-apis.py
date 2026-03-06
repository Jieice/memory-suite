import requests

apis = [
    {'name': 'siliconflow', 'url': 'https://api.siliconflow.cn/v1/chat/completions', 'key': 'sk-wjziyhbaktockvshknswwwomzqkwnrinrqwlkhcuttbytfnh', 'model': 'Qwen/Qwen3-8B'},
    {'name': 'aiping', 'url': 'https://aiping.cn/api/v1/chat/completions', 'key': 'QC-4ac6a96c9e5078222f1c066fb67892ad-abffe173d55547eab2c2c9b0dc1e26b1', 'model': 'glm-4.7'},
    {'name': 'mitchll', 'url': 'https://api.mitchll.com/v1/chat/completions', 'key': 'sk-uVs6GcvcXuntdhVmxIDIAVpVmdu3Nbf7VsUP4v6etLL8bcyc', 'model': 'glm-4.7'},
    {'name': 'nki', 'url': 'https://newapi.nki.pw/v1/chat/completions', 'key': 'sk-uVs6GcvcXuntdhVmxIDIAVpVmdu3Nbf7VsUP4v6etLL8bcyc', 'model': 'glm-4.7'},
]

for api in apis:
    print(f"测试 {api['name']} ({api['model']})...", end=' ')
    try:
        headers = {'Content-Type': 'application/json', 'Authorization': f"Bearer {api['key']}"}
        payload = {'model': api['model'], 'messages': [{'role': 'user', 'content': '回复OK'}], 'max_tokens': 10}
        resp = requests.post(api['url'], headers=headers, json=payload, timeout=15)
        if resp.status_code == 200:
            print("✅")
        else:
            print(f"❌ {resp.status_code}: {resp.text[:80]}")
    except Exception as e:
        print(f"❌ {e}")
