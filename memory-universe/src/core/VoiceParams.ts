/**
 * Voice/TTS parameter generation.
 * Pure function extracted from SoulOrchestrator.
 */

export function generateVoiceParams(soul?: any, emotionName?: string): any {
    const params: any = {
        emotion: 'neutral',
        speech_rate: 1.0,
        pitch: 0
    };

    if (!soul) return params;

    const emotionState = soul.emotion || {};
    const drives = soul.drives || {};

    // ????????Qwen3-TTS ????????
    switch (emotionName) {
        case 'joy':
        case 'happy':
            params.emotion = 'happy';
            params.speech_rate = 1.1;
            params.pitch = 3;
            break;

        case 'anger':
        case 'angry':
            params.emotion = 'angry';
            params.speech_rate = 1.15;
            params.pitch = 5;
            break;

        case 'sadness':
        case 'sad':
            params.emotion = 'sad';
            params.speech_rate = 0.9;
            params.pitch = -5;
            break;

        case 'fear':
            params.emotion = 'calm';
            params.speech_rate = 1.2;
            params.pitch = 2;
            break;

        case 'surprise':
            params.emotion = 'happy';
            params.speech_rate = 1.1;
            params.pitch = 4;
            break;

        case 'disgust':
            params.emotion = 'angry';
            params.speech_rate = 0.95;
            params.pitch = -3;
            break;

        default:
            params.emotion = 'neutral';
            params.speech_rate = 1.0;
            params.pitch = 0;
    }

    // ??????????????
    if (drives.boredom > 0.6) {
        params.speech_rate = Math.max(0.5, params.speech_rate * 0.95);
    }

    if (drives.fatigue > 0.7) {
        params.speech_rate = Math.max(0.5, params.speech_rate * 0.9);
    }

    if (drives.curiosity > 0.6) {
        params.speech_rate = Math.min(2.0, params.speech_rate * 1.05);
    }

    // ????????????
    const emotionIntensity = (emotionName && emotionState[emotionName as keyof typeof emotionState]) || 0.5;
    if (typeof emotionIntensity === 'number' && emotionIntensity > 0.7) {
        params.speech_rate = Math.min(2.0, params.speech_rate * 1.1);
    }

    // ???????????????
    params.speech_rate = Math.max(0.5, Math.min(2.0, params.speech_rate));
    params.pitch = Math.max(-20, Math.min(20, params.pitch));

    return params;
}
