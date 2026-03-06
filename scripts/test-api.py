import asyncio
import aiohttp

async def test():
    models_to_try = [
        'meta/llama-3.1-8b-instruct',
        'deepseek-ai/deepseek-v3.1',
        '01-ai/yi-large',
        'baichuan-inc/baichuan2-13b-chat',
    ]
    
    api_key = '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'
    
    async with aiohttp.ClientSession() as session:
        for model in models_to_try:
            print(f'测试 {model}...')
            try:
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {api_key}'
                }
                payload = {
                    'model': model,
                    'messages': [{'role': 'user', 'content': '分析：我好难过。输出JSON：{"emotion":"sad或happy"}'}],
                    'max_tokens': 100,
                    'temperature': 0.3,
                }
                async with session.post('https://integrate.api.nvidia.com/v1/chat/completions', headers=headers, json=payload, timeout=60) as resp:
                    print(f'  状态: {resp.status}')
                    if resp.status == 200:
                        data = await resp.json()
                        content = data['choices'][0]['message']['content']
                        print(f'  回复: {content[:100]}')
                        print('  ✅ 可用!')
                        break
                    else:
                        text = await resp.text()
                        print(f'  错误: {text[:100]}')
            except Exception as e:
                print(f'  异常: {e}')

asyncio.run(test())
