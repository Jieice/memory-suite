#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const RUNTIME_URL = process.env.MEMORY_SUITE_URL || process.env.MEMORY_UNIVERSE_URL || 'http://localhost:8080';

async function showLearnedContent() {
  try {
    console.log('Loading unified knowledge catalog...\n');

    const response = await fetch(`${RUNTIME_URL}/api/knowledge/catalog?limit=20`);
    const data = await response.json();

    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    const memoryEntries = Array.isArray(data.memory_entries) ? data.memory_entries : [];
    const configArtifacts = Array.isArray(data.config_artifacts) ? data.config_artifacts : [];

    console.log(`Profiles: ${profiles.length}`);
    console.log(`Memory entries: ${memoryEntries.length}`);
    console.log(`Config artifacts: ${configArtifacts.length}\n`);

    for (const profile of profiles.slice(0, 10)) {
      console.log(`- ${profile.preferred_name || profile.user_id} (${profile.user_id})`);
    }

    if (memoryEntries.length) {
      console.log('\nRecent memory entries:');
      for (const entry of memoryEntries.slice(0, 10)) {
        console.log(`- ${entry.user_id} / ${entry.entry_type} / ${entry.source}`);
      }
    }
  } catch (error) {
    console.error('Failed to load unified knowledge catalog:', error.message);
    console.error('\nStart the runtime first with:');
    console.error('  start-unified.bat');
  }
}

showLearnedContent();
