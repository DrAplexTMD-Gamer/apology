#!/usr/bin/env node
/**
 * Cleanup script to deduplicate analytics data
 * Keeps only the latest entry for each sessionId
 */

const fs = require('fs');
const path = require('path');

const ANALYTICS_FILE = path.join('/tmp', 'analytics-log.json');
const BACKUP_FILE = path.join('/tmp', 'analytics-log.backup.json');

function deduplicateAnalytics() {
  console.log('Reading analytics file...');

  let data;
  try {
    data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
  } catch (error) {
    console.error('Error reading analytics file:', error.message);
    process.exit(1);
  }

  console.log(`Found ${data.length} total entries`);

  // Create backup
  console.log('Creating backup...');
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2));
  console.log(`Backup saved to: ${BACKUP_FILE}`);

  // Group by sessionId and keep only the latest entry
  const sessionMap = new Map();

  data.forEach(entry => {
    const sessionId = entry.sessionId;
    const existing = sessionMap.get(sessionId);

    if (!existing) {
      sessionMap.set(sessionId, entry);
    } else {
      // Keep the entry with the latest created_at or updated_at
      const existingTime = new Date(existing.updated_at || existing.created_at);
      const currentTime = new Date(entry.updated_at || entry.created_at);

      if (currentTime > existingTime) {
        sessionMap.set(sessionId, entry);
      }
    }
  });

  // Convert back to array
  const deduplicated = Array.from(sessionMap.values());

  // Sort by timestamp (newest first)
  deduplicated.sort((a, b) => {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  console.log(`After deduplication: ${deduplicated.length} unique sessions`);
  console.log(`Removed ${data.length - deduplicated.length} duplicate entries`);

  // Write deduplicated data
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(deduplicated, null, 2));
  console.log(`✅ Cleanup complete! Analytics file updated.`);
  console.log(`\nStats:`);
  console.log(`  - Original entries: ${data.length}`);
  console.log(`  - Unique sessions: ${deduplicated.length}`);
  console.log(`  - Duplicates removed: ${data.length - deduplicated.length}`);
  console.log(`\nBackup location: ${BACKUP_FILE}`);
}

// Run the cleanup
deduplicateAnalytics();
