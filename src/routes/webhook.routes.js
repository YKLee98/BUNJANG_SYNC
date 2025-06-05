// src/routes/webhook.routes.js
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const crypto = require('crypto');
const config = require('../config');
const inventoryService = require('../services/inventoryService');
const SyncedProduct = require('../models/syncedProduct.model');

// Shopify 웹훅 검증 미들웨어
const verifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic');
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  
  // 디버깅 로그
  logger.debug('[Webhook] Verification attempt:', {
    topic,
    shopDomain,
    hasHmac: !!hmac,
    hasRawBody: !!req.rawBody,
    rawBodyType: typeof req.rawBody,
    rawBodyLength: req.rawBody ? req.rawBody.length : 0,
    headers: {
      'content-type': req.get('content-type'),
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': shopDomain
    }
  });
  
  if (!hmac) {
    logger.error('[Webhook] Missing HMAC header');
    return res.status(401).send('Unauthorized - Missing HMAC');
  }
  
  if (!req.rawBody) {
    logger.error('[Webhook] Missing raw body. Make sure bodyParser.json verify callback is configured in app.js');
    return res.status(401).send('Unauthorized - Missing body');
  }
  
  // 웹훅 시크릿 확인
  const webhookSecret = config.shopify.webhookSecret;
  
  if (!webhookSecret) {
    logger.error('[Webhook] SHOPIFY_WEBHOOK_SECRET not configured');
    return res.status(500).send('Server configuration error');
  }
  
  // rawBody를 Buffer로 확인
  const rawBodyBuffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody, 'utf8');
  
  // HMAC 계산
  const calculatedHmac = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBodyBuffer)
    .digest('base64');
  
  logger.debug('[Webhook] HMAC comparison:', {
    received: hmac.substring(0, 10) + '...',
    calculated: calculatedHmac.substring(0, 10) + '...',
    secretUsed: webhookSecret.substring(0, 10) + '...'
  });
  
  // 타이밍 공격 방지를 위한 안전한 비교
  const hmacBuffer = Buffer.from(hmac, 'base64');
  const calculatedBuffer = Buffer.from(calculatedHmac, 'base64');
  
  if (hmacBuffer.length !== calculatedBuffer.length || !crypto.timingSafeEqual(hmacBuffer, calculatedBuffer)) {
    logger.error('[Webhook] HMAC verification failed', {
      topic,
      shopDomain,
      hint: 'Check if SHOPIFY_WEBHOOK_SECRET in .env matches the webhook signing secret in Shopify'
    });
    return res.status(401).send('Unauthorized - Invalid HMAC');
  }
  
  // body 파싱 (아직 파싱되지 않은 경우)
  if (!req.body || typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    try {
      const bodyString = rawBodyBuffer.toString('utf8');
      req.body = JSON.parse(bodyString);
    } catch (e) {
      logger.error('[Webhook] Failed to parse body:', e);
      return res.status(400).send('Bad Request - Invalid JSON');
    }
  }
  
  logger.info('[Webhook] Verification successful', { topic, shopDomain });
  next();
};

// 주문 생성 웹훅
router.post('/orders/create', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order created: #${order.order_number || order.name} (${order.id})`);
    
    // 주문 상품별 재고 처리
    for (const lineItem of order.line_items || []) {
      try {
        // 상품의 번개장터 PID 찾기
        const variantId = lineItem.variant_id;
        const productId = lineItem.product_id;
        
        logger.debug(`[Webhook] Processing line item:`, {
          productId,
          variantId,
          quantity: lineItem.quantity,
          title: lineItem.title
        });
        
        // DB에서 연결된 번개장터 상품 찾기
        const syncedProduct = await SyncedProduct.findOne({
          $or: [
            { shopifyGid: `gid://shopify/Product/${productId}` },
            { 'shopifyData.id': productId },
            { 'shopifyData.id': String(productId) }
          ]
        }).lean();
        
        if (syncedProduct && syncedProduct.bunjangPid) {
          logger.info(`[Webhook] Found Bunjang product:`, {
            bunjangPid: syncedProduct.bunjangPid,
            productName: syncedProduct.bunjangProductName,
            quantity: lineItem.quantity
          });
          
          // 번개장터 재고 확인 및 차감
          const currentStock = await inventoryService.checkAndSyncBunjangInventory(syncedProduct.bunjangPid);
          
          if (currentStock !== null && currentStock >= 0) {
            const newStock = Math.max(0, currentStock - lineItem.quantity);
            await inventoryService.syncBunjangInventoryToShopify(syncedProduct.bunjangPid, newStock);
            
            logger.info(`[Webhook] Inventory updated for PID ${syncedProduct.bunjangPid}: ${currentStock} -> ${newStock}`);
          }
        } else {
          logger.warn(`[Webhook] No Bunjang product found for Shopify product ${productId}`);
        }
      } catch (itemError) {
        logger.error(`[Webhook] Failed to process line item ${lineItem.id}:`, itemError);
        // 개별 아이템 실패는 전체 웹훅 처리를 실패시키지 않음
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order creation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 주문 업데이트 웹훅
router.post('/orders/updated', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order updated: #${order.order_number || order.name} (${order.id}), Status: ${order.financial_status}`);
    
    // 주문 취소시 재고 복구
    if (order.cancelled_at) {
      logger.info(`[Webhook] Order cancelled, restoring inventory`);
      
      for (const lineItem of order.line_items || []) {
        try {
          const productId = lineItem.product_id;
          
          const syncedProduct = await SyncedProduct.findOne({
            $or: [
              { shopifyGid: `gid://shopify/Product/${productId}` },
              { 'shopifyData.id': productId },
              { 'shopifyData.id': String(productId) }
            ]
          }).lean();
          
          if (syncedProduct && syncedProduct.bunjangPid) {
            // 재고 복구
            const currentStock = await inventoryService.checkAndSyncBunjangInventory(syncedProduct.bunjangPid);
            
            if (currentStock !== null) {
              const restoredStock = currentStock + lineItem.quantity;
              await inventoryService.syncBunjangInventoryToShopify(syncedProduct.bunjangPid, restoredStock);
              
              logger.info(`[Webhook] Inventory restored for PID ${syncedProduct.bunjangPid}: ${currentStock} -> ${restoredStock}`);
            }
          }
        } catch (itemError) {
          logger.error(`[Webhook] Failed to restore inventory for line item ${lineItem.id}:`, itemError);
        }
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 재고 업데이트 웹훅
router.post('/inventory_levels/update', verifyWebhook, async (req, res) => {
  try {
    const { inventory_item_id, available, location_id } = req.body;
    logger.info(`[Webhook] Inventory level updated: Item ${inventory_item_id}, Available: ${available}, Location: ${location_id}`);
    
    // 여기에 필요한 재고 동기화 로직 추가
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process inventory update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 테스트 엔드포인트 (개발용)
if (config.env !== 'production') {
  router.post('/test', (req, res) => {
    logger.info('[Webhook] Test endpoint hit:', {
      headers: req.headers,
      hasRawBody: !!req.rawBody,
      rawBodyType: typeof req.rawBody,
      bodyType: typeof req.body
    });
    res.json({ 
      success: true, 
      message: 'Test webhook received',
      hasRawBody: !!req.rawBody,
      bodyParsed: typeof req.body === 'object'
    });
  });
}

module.exports = router;