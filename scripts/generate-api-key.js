#!/usr/bin/env node

const crypto = require('crypto');

/**
 * Generate a secure 256-character API key
 * Uses URL-safe base64 encoding to ensure the key is safe for use in URLs and headers
 */
function generateApiKey() {
  // Generate 192 random bytes (192 * 4/3 = 256 base64 characters)
  // We use 192 bytes because base64 encoding expands by 4/3
  const randomBytes = crypto.randomBytes(192);
  
  // Convert to base64 and remove padding (which can add extra characters)
  let apiKey = randomBytes.toString('base64url');
  
  // Ensure exactly 256 characters
  // base64url encoding of 192 bytes gives us 256 characters exactly
  // If for some reason it's not exactly 256, pad or truncate
  if (apiKey.length < 256) {
    // If shorter, pad with more random characters
    const additionalBytes = crypto.randomBytes(Math.ceil((256 - apiKey.length) * 3 / 4));
    apiKey += additionalBytes.toString('base64url').substring(0, 256 - apiKey.length);
  } else if (apiKey.length > 256) {
    // If longer, truncate to exactly 256
    apiKey = apiKey.substring(0, 256);
  }
  
  return apiKey;
}

// Generate and output the API key
const apiKey = generateApiKey();
console.log('Generated 256-character API key:');
console.log(apiKey);
console.log(`\nLength: ${apiKey.length} characters`);
