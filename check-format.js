import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.COINBASE_API_KEY;
const secret = process.env.COINBASE_SECRET_KEY;

console.log('API Key length:', apiKey?.length);
console.log('API Key first 40 chars:', apiKey?.substring(0, 40));
console.log('Secret length:', secret?.length);
console.log('Secret first 40 chars:', secret?.substring(0, 40));
console.log('Secret has BEGIN:', secret?.includes('BEGIN'));
console.log('Secret has END:', secret?.includes('END'));
console.log('Secret has \\n:', secret?.includes('\\n'));
