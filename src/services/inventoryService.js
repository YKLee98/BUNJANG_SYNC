// src/services/inventoryService.js
// Shopify와 번개장터 간의 재고 동기화를 담당하는 서비스

const config = require('../config');
const logger = require('../config/logger');
const shopifyService = require('./shopifyService');
const bunjangService = require('./bunjangService');
const SyncedProduct = require('../models/syncedProduct.model');
const { AppError, ValidationError } = require('../utils/customErrors');

/**
 * 번개장터 재고를 Shopify로 동기화
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {number} bunjangQuantity - 번개장터 재고 수량
 * @returns {Promise<boolean>} 동기화 성공 여부
 */
async function syncBunjangInventoryToShopify(bunjangPid, bunjangQuantity) {
  try {
    logger.info(`[InventorySvc] Syncing inventory for Bunjang PID ${bunjangPid}: ${bunjangQuantity} units`);
    
    // DB에서 연결된 Shopify 상품 찾기
    const syncedProduct = await SyncedProduct.findOne({ bunjangPid }).lean();
    if (!syncedProduct || !syncedProduct.shopifyGid) {
      logger.warn(`[InventorySvc] No Shopify product found for Bunjang PID ${bunjangPid}`);
      return false;
    }
    
    // Shopify 상품의 variant 정보 가져오기
    const query = `
      query getProductVariants($id: ID!) {
        product(id: $id) {
          id
          variants(first: 1) {
            edges {
              node {
                id
                inventoryItem {
                  id
                }
                inventoryQuantity
              }
            }
          }
        }
      }
    `;
    
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: syncedProduct.shopifyGid });
    
    if (!response.data.product || !response.data.product.variants.edges.length) {
      logger.error(`[InventorySvc] Failed to fetch Shopify product variants for GID ${syncedProduct.shopifyGid}`);
      return false;
    }
    
    const variant = response.data.product.variants.edges[0].node;
    const inventoryItemId = variant.inventoryItem.id;
    const currentQuantity = variant.inventoryQuantity || 0;
    
    // 재고가 다른 경우에만 업데이트
    if (currentQuantity !== bunjangQuantity) {
      await shopifyService.updateInventoryLevel(
        inventoryItemId,
        config.shopify.defaultLocationId,
        bunjangQuantity
      );
      
      logger.info(`[InventorySvc] Updated Shopify inventory for PID ${bunjangPid}: ${currentQuantity} -> ${bunjangQuantity}`);
      
      // DB 업데이트
      await SyncedProduct.updateOne(
        { bunjangPid },
        { 
          $set: { 
            bunjangQuantity: bunjangQuantity,
            lastInventorySyncAt: new Date()
          }
        }
      );
      
      return true;
    }
    
    logger.debug(`[InventorySvc] Inventory already in sync for PID ${bunjangPid}: ${currentQuantity} units`);
    return true;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to sync inventory for PID ${bunjangPid}:`, error);
    throw error;
  }
}

/**
 * 여러 상품의 재고를 일괄 동기화
 * @param {Array<{pid: string, quantity: number}>} inventoryUpdates - 재고 업데이트 목록
 * @returns {Promise<{success: number, failed: number}>} 동기화 결과
 */
async function batchSyncInventory(inventoryUpdates) {
  const results = {
    success: 0,
    failed: 0,
    details: []
  };
  
  for (const update of inventoryUpdates) {
    try {
      const success = await syncBunjangInventoryToShopify(update.pid, update.quantity);
      if (success) {
        results.success++;
      } else {
        results.failed++;
      }
      results.details.push({
        pid: update.pid,
        success,
        quantity: update.quantity
      });
    } catch (error) {
      results.failed++;
      results.details.push({
        pid: update.pid,
        success: false,
        error: error.message
      });
    }
  }
  
  logger.info(`[InventorySvc] Batch inventory sync completed:`, results);
  return results;
}

/**
 * Shopify 주문 후 번개장터 재고 확인 및 동기화
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @returns {Promise<number>} 현재 재고 수량
 */
async function checkAndSyncBunjangInventory(bunjangPid) {
  try {
    // 번개장터 상품 상세 정보 조회
    const productDetails = await bunjangService.getBunjangProductDetails(bunjangPid);
    
    if (!productDetails) {
      logger.warn(`[InventorySvc] Could not fetch Bunjang product details for PID ${bunjangPid}`);
      return -1;
    }
    
    const currentQuantity = productDetails.quantity || 0;
    
    // Shopify로 동기화
    await syncBunjangInventoryToShopify(bunjangPid, currentQuantity);
    
    return currentQuantity;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to check and sync inventory for PID ${bunjangPid}:`, error);
    throw error;
  }
}

/**
 * 재고 부족 상품 확인
 * @param {number} threshold - 재고 임계값 (기본값: 5)
 * @returns {Promise<Array>} 재고 부족 상품 목록
 */
async function checkLowStockProducts(threshold = 5) {
  try {
    const lowStockProducts = await SyncedProduct.find({
      bunjangQuantity: { $lte: threshold, $gte: 0 },
      syncStatus: 'SYNCED'
    }).lean();
    
    logger.info(`[InventorySvc] Found ${lowStockProducts.length} low stock products (threshold: ${threshold})`);
    
    return lowStockProducts.map(product => ({
      bunjangPid: product.bunjangPid,
      shopifyGid: product.shopifyGid,
      productName: product.bunjangProductName,
      currentStock: product.bunjangQuantity,
      lastUpdated: product.bunjangUpdatedAt
    }));
    
  } catch (error) {
    logger.error('[InventorySvc] Failed to check low stock products:', error);
    throw error;
  }
}

/**
 * 재고 알림 발송
 * @param {Array} lowStockProducts - 재고 부족 상품 목록
 */
async function sendLowStockNotification(lowStockProducts) {
  if (!lowStockProducts || lowStockProducts.length === 0) return;
  
  logger.warn(`[InventorySvc] Low stock alert for ${lowStockProducts.length} products:`, 
    lowStockProducts.map(p => `${p.productName} (PID: ${p.bunjangPid}): ${p.currentStock} units`)
  );
  
  // TODO: 이메일 또는 Slack 알림 발송
  // if (config.notifications.enabled) {
  //   await notificationService.sendLowStockAlert(lowStockProducts);
  // }
}

/**
 * 전체 재고 동기화 작업
 * @param {string} [jobId='MANUAL'] - 작업 ID
 * @returns {Promise<object>} 동기화 결과
 */
async function performFullInventorySync(jobId = 'MANUAL') {
  logger.info(`[InventorySvc:Job-${jobId}] Starting full inventory sync`);
  
  const startTime = Date.now();
  const results = {
    totalProducts: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    lowStock: []
  };
  
  try {
    // 동기화된 모든 상품 조회
    const syncedProducts = await SyncedProduct.find({
      syncStatus: 'SYNCED',
      bunjangPid: { $exists: true }
    }).limit(1000).lean(); // 한 번에 최대 1000개 처리
    
    results.totalProducts = syncedProducts.length;
    
    // 각 상품의 재고 확인 및 동기화
    for (const product of syncedProducts) {
      try {
        const currentQuantity = await checkAndSyncBunjangInventory(product.bunjangPid);
        
        if (currentQuantity >= 0) {
          results.synced++;
          
          // 재고 부족 확인
          if (currentQuantity <= 5) {
            results.lowStock.push({
              bunjangPid: product.bunjangPid,
              productName: product.bunjangProductName,
              currentStock: currentQuantity
            });
          }
        } else {
          results.skipped++;
        }
        
      } catch (error) {
        results.failed++;
        logger.error(`[InventorySvc:Job-${jobId}] Failed to sync inventory for PID ${product.bunjangPid}:`, error.message);
      }
      
      // Rate limiting - 1초에 2개 상품 처리
      if (results.synced % 2 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info(`[InventorySvc:Job-${jobId}] Full inventory sync completed in ${duration}ms:`, results);
    
    // 재고 부족 알림
    if (results.lowStock.length > 0) {
      await sendLowStockNotification(results.lowStock);
    }
    
    return results;
    
  } catch (error) {
    logger.error(`[InventorySvc:Job-${jobId}] Full inventory sync failed:`, error);
    throw error;
  }
}

module.exports = {
  syncBunjangInventoryToShopify,
  batchSyncInventory,
  checkAndSyncBunjangInventory,
  checkLowStockProducts,
  sendLowStockNotification,
  performFullInventorySync,
};