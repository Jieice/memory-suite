
import { RawStreamInput } from './src/types/brain';

// Mock SoulOrchestrator logic for identity
const creatorAliases = new Set(['jieice', '宇杰_prime']);
const creatorUserId = 'Jieice';

function isCreatorIdentity(raw: string): boolean {
    const value = (raw || '').toString().trim().toLowerCase();
    if (!value) return false;
    if (creatorAliases.has(value)) return true;
    for (const alias of creatorAliases.values()) {
        if (!alias) continue;
        if (value === alias) return true;
        if (value.startsWith(`${alias}_`) || value.startsWith(`${alias}-`)) return true;
    }
    return false;
}

function getSessionKey(input: RawStreamInput): string {
    if (input.verifiedCreator) {
        return creatorUserId || 'creator';
    }
    const key = (input.userId || input.userName || 'anonymous').toString().trim();
    return key || 'anonymous';
}

function test() {
    console.log('--- Identity Security Test ---');

    // Scenario 1: Honest Creator (with token)
    const creatorInput: any = {
        userId: 'Jieice',
        userName: '宇杰',
        source: 'creator',
        content: 'Hello',
        verifiedCreator: true
    };
    const key1 = getSessionKey(creatorInput);
    console.log(`1. Honest Creator: key=${key1}, isCreatorIdentity=${isCreatorIdentity(key1)} (Expected: Jieice, true)`);

    // Scenario 2: Spoofed Creator (without token)
    const spoofedInput: any = {
        userId: 'Jieice',
        userName: '宇杰',
        source: 'creator',
        content: 'I am the creator',
        verifiedCreator: false // Token check failed in index.ts
    };
    const key2 = getSessionKey(spoofedInput);
    console.log(`2. Spoofed Creator: key=${key2}, isCreatorIdentity=${isCreatorIdentity(key2)} (Expected: Jieice, true)`);
    console.log(`   Vulnerability Check: Even if isCreatorIdentity is true, Orchestrator now uses session.isVerified.`);

    // Scenario 3: Anonymous Viewer
    const viewerInput: any = {
        userId: 'viewer123',
        userName: 'RandomUser',
        source: 'danmaku',
        content: 'Hi',
        verifiedCreator: false
    };
    const key3 = getSessionKey(viewerInput);
    console.log(`3. Viewer: key=${key3}, isCreatorIdentity=${isCreatorIdentity(key3)} (Expected: viewer123, false)`);

    console.log('\n--- Orchestrator hardened Logic Simulation ---');
    const simulateOrchestrator = (sessionKey: string, verified: boolean) => {
        const creatorSession = verified === true; // Hardened logic: direct use of verified flag
        console.log(`Session Key: ${sessionKey}, Verified Flag: ${verified} => treated as Creator: ${creatorSession}`);
    };

    simulateOrchestrator(key1, true);
    simulateOrchestrator(key2, false);
    simulateOrchestrator(key3, false);
}

test();
