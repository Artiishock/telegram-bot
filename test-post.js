// test-api.js
require('dotenv').config();
const axios = require('axios');

async function testAPI() {
  try {
    console.log('🧪 Тестируем API...');
    const response = await axios.get(process.env.STATAMIC_API_URL + '/test-simple');
    console.log('✅ API отвечает:', response.data);
  } catch (error) {
    console.log('❌ Ошибка API:');
    console.log('Status:', error.response?.status);
    console.log('Data:', error.response?.data);
    console.log('Message:', error.message);
  }
}

testAPI();