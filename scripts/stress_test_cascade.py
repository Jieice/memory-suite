import asyncio
import aiohttp
import time
import json
import statistics
import random

# 配置压力测试参数
TARGET_URL = "http://127.0.0.1:8080/api/chat" # 通过 Manager 进入
CONCURRENT_USERS = 5 # 模拟并发用户数
TOTAL_REQUESTS = 20  # 总请求数
TEST_MESSAGES = [
    "你好呀",
    "今天天气真不错",
    "给我讲个笑话吧",
    "你觉得你是人类吗？",
    "你是谁开发的？",
    "能不能跳个舞？",
    "你会唱歌吗？",
    "评价一下现在的AI技术",
    "为什么要当虚拟主播？",
    "你喜欢吃什么？"
]

async def send_request(session, request_id):
    payload = {
        "text": random.choice(TEST_MESSAGES),
        "userId": f"stress_test_user_{random.randint(1, 100)}",
        "userName": "压力测试员",
        "source": "danmaku"
    }
    
    start_time = time.time()
    try:
        async with session.post(TARGET_URL, json=payload, timeout=60) as response:
            status = response.status
            result = await response.json()
            elapsed = time.time() - start_time
            
            # 检查是否命中了 fallback
            is_fallback = "请告诉我的创造者" in str(result.get("text", ""))
            provider = result.get("metadata", {}).get("llmProvider", "unknown")
            
            return {
                "success": status == 200,
                "elapsed": elapsed,
                "is_fallback": is_fallback,
                "provider": provider,
                "error": None
            }
    except Exception as e:
        return {
            "success": False,
            "elapsed": time.time() - start_time,
            "is_fallback": False,
            "provider": "error",
            "error": str(e)
        }

async def run_stress_test():
    print(f"开始压力测试: {TARGET_URL}")
    print(f"并发数: {CONCURRENT_USERS}, 总请求: {TOTAL_REQUESTS}")
    
    async with aiohttp.ClientSession() as session:
        tasks = []
        for i in range(TOTAL_REQUESTS):
            tasks.append(send_request(session, i))
            if len(tasks) >= CONCURRENT_USERS:
                # 控制并发节奏
                await asyncio.sleep(random.uniform(0.5, 2.0))
        
        results = await asyncio.gather(*tasks)
    
    # 统计结果
    successful_requests = [r for r in results if r["success"]]
    fallbacks = [r for r in results if r["is_fallback"]]
    latencies = [r["elapsed"] for r in successful_requests]
    
    print("\n" + "="*50)
    print("压力测试报告")
    print("="*50)
    print(f"总请求: {TOTAL_REQUESTS}")
    print(f"成功请求: {len(successful_requests)}")
    print(f"失败请求: {TOTAL_REQUESTS - len(successful_requests)}")
    print(f"命中降级(Fallback): {len(fallbacks)}")
    
    if latencies:
        print(f"平均响应时间: {statistics.mean(latencies):.2f}s")
        print(f"中位数响应时间: {statistics.median(latencies):.2f}s")
        print(f"最大响应时间: {max(latencies):.2f}s")
        print(f"最小响应时间: {min(latencies):.2f}s")
        
        # 统计 Provider 分布
        providers = {}
        for r in results:
            p = r["provider"]
            providers[p] = providers.get(p, 0) + 1
        print(f"模型分布: {json.dumps(providers, ensure_ascii=False)}")
    print("="*50)

if __name__ == "__main__":
    asyncio.run(run_stress_test())
