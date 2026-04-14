import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.COINBASE_API_KEY;
const secret = process.env.COINBASE_SECRET_KEY;

console.log('═══════════════════════════════════════════════════');
console.log('CHECKING COINBASE KEYS');
console.log('═══════════════════════════════════════════════════\n');

console.log('API KEY:');
console.log('  Length:', apiKey?.length);
console.log('  First 40 chars:', apiKey?.substring(0, 40));
console.log('  Char at position 30:', `'${apiKey?.[30]}' (code: ${apiKey?.charCodeAt(30)})`);
console.log('  Char at position 31:', `'${apiKey?.[31]}' (code: ${apiKey?.charCodeAt(31)})`);

console.log('\nSECRET KEY:');
console.log('  Length:', secret?.length);
console.log('  First 40 chars:', secret?.substring(0, 40));
console.log('  Char at position 30:', `'${secret?.[30]}' (code: ${secret?.charCodeAt(30)})`);
console.log('  Char at position 31:', `'${secret?.[31]}' (code: ${secret?.charCodeAt(31)})`);

console.log('\n═══════════════════════════════════════════════════');

// Also check for non-printable characters
for (let i = 0; i < Math.min(50, apiKey?.length || 0); i++) {
  const code = apiKey?.charCodeAt(i);
  if (code < 32 || code > 126) {
    console.log(`⚠️ API Key has non-printable character at position ${i}: code ${code}`);
  }
}

for (let i = 0; i < Math.min(50, secret?.length || 0); i++) {
  const code = secret?.charCodeAt(i);
  if (code < 32 || code > 126) {
    console.log(`⚠️ SECRET Key has non-printable character at position ${i}: code ${code}`);
  }
}