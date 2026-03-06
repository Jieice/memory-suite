import { RawStreamInput } from '../types/brain';

export class SignalProcessor {
    processDanmaku(user: string, text: string): RawStreamInput {
        return {
            content: text,
            source: 'danmaku',
            userId: user,
            features: {
                intensity: Math.min(text.length / 20, 1.0),
                sentiment_hint: 0,
                timestamp: Date.now()
            }
        };
    }

    processGift(user: string, gift: string, count: number): RawStreamInput {
        return {
            content: `${user}送出${gift}x${count}`,
            source: 'gift',
            userId: user,
            features: {
                intensity: Math.min(count / 10, 1.0),
                sentiment_hint: 0.8,
                timestamp: Date.now()
            }
        };
    }
}
