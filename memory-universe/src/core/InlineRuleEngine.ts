export class InlineRuleEngine {
    private sensitivePatterns: RegExp[];
    private greetingPatterns: RegExp[];
    private recentMessages: string[] = [];
    private readonly maxRecentMessages = 10;
    
    constructor() {
        this.sensitivePatterns = [
            /\b(password|密码|账号|account)\b/i,
            /\b(api[_-]?key|secret|token)\b/i,
        ];
        this.greetingPatterns = [
            /^(你好|hi|hello|hey|早上好|晚上好|哈喽)/i,
            /(在吗|在不在|有人吗)/i,
        ];
    }
    
    checkContent(text: string): { isSensitive: boolean; isGreeting: boolean; isRepetition: boolean; warnings: string[] } {
        const warnings: string[] = [];
        let isSensitive = false;
        let isGreeting = false;
        let isRepetition = false;
        
        for (const pattern of this.sensitivePatterns) {
            if (pattern.test(text)) {
                isSensitive = true;
                warnings.push('检测到敏感内容');
                break;
            }
        }
        
        for (const pattern of this.greetingPatterns) {
            if (pattern.test(text)) {
                isGreeting = true;
                break;
            }
        }
        
        isRepetition = this.detectRepetition(text);
        
        this.recentMessages.push(text);
        if (this.recentMessages.length > this.maxRecentMessages) {
            this.recentMessages.shift();
        }
        
        return { isSensitive, isGreeting, isRepetition, warnings };
    }
    
    private detectRepetition(text: string): boolean {
        if (this.recentMessages.length < 2) return false;
        const normalized = text.toLowerCase().trim();
        const matchCount = this.recentMessages.filter(m => m.toLowerCase().trim() === normalized).length;
        return matchCount >= 2;
    }
    
    getStats(): { recentMessagesCount: number } {
        return { recentMessagesCount: this.recentMessages.length };
    }
}
