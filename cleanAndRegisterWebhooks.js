// cleanAndRegisterWebhooks.js
// 모든 웹훅을 삭제하고 올바른 경로로 재등록하는 스크립트

const axios = require('axios');
const config = require('./src/config');

const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || config.middlewareBaseUrl || 'https://b446-2001-e60-87b5-e1cd-5030-5985-2477-77b0.ngrok-free.app';

async function cleanAndRegisterWebhooks() {
  console.log('🧹 Cleaning and re-registering webhooks...\n');
  console.log(`📍 Base URL: ${WEBHOOK_BASE_URL}`);
  console.log(`🏪 Shop: ${config.shopify.shopDomain}\n`);

  const shopifyApiUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks.json`;
  
  try {
    // 1. 모든 기존 웹훅 삭제
    console.log('Step 1: Deleting all existing webhooks...\n');
    
    const listResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken,
        'Content-Type': 'application/json'
      }
    });
    
    const existingWebhooks = listResponse.data.webhooks || [];
    console.log(`Found ${existingWebhooks.length} existing webhooks to delete:\n`);
    
    for (const webhook of existingWebhooks) {
      console.log(`🗑️  Deleting: ${webhook.topic} (${webhook.address})`);
      try {
        await axios.delete(
          `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion || '2025-04'}/webhooks/${webhook.id}.json`,
          {
            headers: {
              'X-Shopify-Access-Token': config.shopify.adminAccessToken
            }
          }
        );
        console.log(`   ✅ Deleted successfully\n`);
      } catch (error) {
        console.error(`   ❌ Failed to delete: ${error.message}\n`);
      }
    }
    
    console.log('✅ All webhooks deleted\n');
    console.log('='.repeat(60));
    
    // 2. 새 웹훅 등록 (올바른 경로로)
    console.log('\nStep 2: Registering new webhooks with correct paths...\n');
    
    const webhooksToRegister = [
      {
        topic: 'orders/create',
        address: `${WEBHOOK_BASE_URL}/webhooks/orders/create`,
        format: 'json'
      },
      {
        topic: 'orders/updated', 
        address: `${WEBHOOK_BASE_URL}/webhooks/orders/updated`,
        format: 'json'
      },
      {
        topic: 'orders/cancelled',
        address: `${WEBHOOK_BASE_URL}/webhooks/orders/cancelled`,
        format: 'json'
      }
    ];
    
    for (const webhook of webhooksToRegister) {
      console.log(`🔗 Registering: ${webhook.topic}`);
      console.log(`   URL: ${webhook.address}`);
      
      try {
        const response = await axios.post(
          shopifyApiUrl,
          { webhook },
          {
            headers: {
              'X-Shopify-Access-Token': config.shopify.adminAccessToken,
              'Content-Type': 'application/json'
            }
          }
        );
        
        console.log(`   ✅ Success! ID: ${response.data.webhook.id}\n`);
      } catch (error) {
        console.error(`   ❌ Failed!`);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
          console.error(`   Error: ${JSON.stringify(error.response.data, null, 2)}\n`);
        } else {
          console.error(`   Error: ${error.message}\n`);
        }
      }
    }
    
    // 3. 최종 확인
    console.log('='.repeat(60));
    console.log('\nStep 3: Verifying final webhook configuration...\n');
    
    const finalResponse = await axios.get(shopifyApiUrl, {
      headers: {
        'X-Shopify-Access-Token': config.shopify.adminAccessToken
      }
    });
    
    const finalWebhooks = finalResponse.data.webhooks || [];
    console.log(`✅ Total webhooks registered: ${finalWebhooks.length}\n`);
    
    finalWebhooks.forEach((webhook, index) => {
      console.log(`${index + 1}. ${webhook.topic}`);
      console.log(`   ID: ${webhook.id}`);
      console.log(`   URL: ${webhook.address}`);
      console.log(`   Created: ${webhook.created_at}\n`);
    });
    
    console.log('='.repeat(60));
    console.log('✅ Webhook cleanup and registration completed!');
    console.log('\n⚠️  IMPORTANT: Make sure your app.js has the correct webhook routes:');
    console.log('   app.use(\'/webhooks\', webhookRoutes);');
    console.log('\n💡 Test by creating an order in Shopify and checking:');
    console.log('   1. ngrok logs should show 200 OK');
    console.log('   2. pm2 logs should show webhook processing');
    
  } catch (error) {
    console.error('❌ Failed to clean and register webhooks:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// 실행
cleanAndRegisterWebhooks().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});