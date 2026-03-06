import axios from 'axios';

const BASE_URL = 'http://localhost:4005';
const USER_ID = 'test_user_linkage';

async function testTopicLinkage() {
    console.log('--- Starting Topic Linkage Verification ---');

    const messages = [
        '明天早上开播前帮我检查一下设备吧',
        '还是说说明天检查设备的事情',
        '检查设备真的很重要，你怎么看？',
        '我们再聊聊检查设备吧',
        '你还是在检查设备中吗？'
    ];

    for (let i = 0; i < messages.length; i++) {
        console.log(`\n[Turn ${i + 1}] User: ${messages[i]}`);
        try {
            const resp = await axios.post(`${BASE_URL}/api/chat`, {
                userId: USER_ID,
                content: messages[i],
                source: 'test'
            });
            console.log(`[Turn ${i + 1}] AI: ${resp.data.text}`);
        } catch (err: any) {
            console.error(`[Turn ${i + 1}] Error: ${err.message}`);
        }
    }

    console.log('\n--- Verification Finished ---');
    console.log('Check memory-universe logs for [TopicTracking] and [Topic Fatigue] markers.');
}

testTopicLinkage();
