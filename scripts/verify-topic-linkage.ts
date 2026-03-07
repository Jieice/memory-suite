import axios from 'axios';

const BASE_URL = 'http://localhost:8080';
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
                session_id: 'topic-linkage-check',
                user_id: USER_ID,
                text: messages[i]
            });
            console.log(`[Turn ${i + 1}] AI: ${resp.data.response_text}`);
        } catch (err: any) {
            console.error(`[Turn ${i + 1}] Error: ${err.message}`);
        }
    }

    console.log('\n--- Verification Finished ---');
    console.log('Check the unified runtime session transcript for topic continuity.');
}

testTopicLinkage();
