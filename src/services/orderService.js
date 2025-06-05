// src/services/orderService.js
// Shopify 주문 웹훅 수신 후 번개장터 주문 생성 등의 로직을 담당합니다.
// 이 서비스의 주요 함수(processShopifyOrderForBunjang)는 BullMQ 주문 워커에 의해 실행됩니다.

const config = require('../config');
const logger = require('../config/logger');
const bunjangService = require('./bunjangService');
const shopifyService = require('./shopifyService');
const orderMapper = require('../mappers/orderMapper');
const { AppError, ExternalServiceError, NotFoundError, ValidationError } = require('../utils/customErrors');
// const SyncedProduct = require('../models/syncedProduct.model'); // 상품 원본가 참조 시 필요

/**
 * Shopify 주문 데이터를 기반으로 번개장터에 주문을 생성합니다.
 * @param {object} shopifyOrder - Shopify 주문 객체 (웹훅 페이로드 또는 DB에서 가져온 객체).
 * @param {string} [jobId='N/A'] - 호출한 BullMQ 작업 ID (로깅용).
 * @returns {Promise<{success: boolean, bunjangOrderId?: string, message?: string}>} 처리 결과.
 */
async function processShopifyOrderForBunjang(shopifyOrder, jobId = 'N/A') {
  const shopifyOrderId = shopifyOrder.id; // Shopify REST API ID
  const shopifyOrderGid = shopifyOrder.admin_graphql_api_id; // Shopify GraphQL GID
  logger.info(`[OrderSvc:Job-${jobId}] Processing Shopify Order ID: ${shopifyOrderId} (GID: ${shopifyOrderGid}) for Bunjang.`);

  // Shopify 주문 객체 유효성 검사
  if (!shopifyOrder || !shopifyOrderId || !shopifyOrderGid || !Array.isArray(shopifyOrder.line_items) || shopifyOrder.line_items.length === 0) {
    throw new ValidationError('유효하지 않은 Shopify 주문 데이터입니다. (ID 또는 line_items 누락)', [{field: 'shopifyOrder', message: 'Order data invalid or missing line items.'}]);
  }

  const bunjangOrderIdentifier = `${config.bunjang.orderIdentifierPrefix}${shopifyOrderId}`;
  let bunjangOrderSuccessfullyCreatedOverall = false;
  let createdBunjangOrderIds = [];

  // TODO: 이미 이 Shopify 주문에 대해 번개장터 주문이 생성되었는지 확인하는 로직 추가
  // 예: Shopify 주문 메타필드 `bunjang.order_id` 조회 또는 내부 DB (ProcessedOrders 모델 등) 조회
  // const existingBunjangOrder = await shopifyService.getOrderMetafield(shopifyOrderGid, "bunjang", "order_id");
  // if (existingBunjangOrder && existingBunjangOrder.value) {
  //   logger.info(`[OrderSvc:Job-${jobId}] Bunjang order already exists (ID: ${existingBunjangOrder.value}) for Shopify Order ${shopifyOrderId}. Skipping.`);
  //   return { success: true, alreadyProcessed: true, bunjangOrderId: existingBunjangOrder.value };
  // }

  // Shopify 주문의 각 line item을 순회
  for (const item of shopifyOrder.line_items) {
    if (!item.sku || !item.sku.startsWith('BJ-')) { // 'BJ-' 프리픽스로 번개장터 연동 상품 SKU 식별
      logger.debug(`[OrderSvc:Job-${jobId}] Shopify item SKU "${item.sku}" (Order: ${shopifyOrderId}) is not a Bunjang-linked product. Skipping this item.`);
      continue;
    }

    const bunjangPid = item.sku.substring(3); // 'BJ-' 제외한 실제 번개장터 상품 ID
    logger.info(`[OrderSvc:Job-${jobId}] Found Bunjang-linked item for Order ${shopifyOrderId}: Shopify SKU ${item.sku} -> Bunjang PID ${bunjangPid}`);

    try {
      // 1. 주문 시점의 번개장터 상품 최신 정보 조회 (가격, 배송비 등 KRW 기준)
      const bunjangProductDetails = await bunjangService.getBunjangProductDetails(bunjangPid);
      if (!bunjangProductDetails) {
        // 상품 조회 실패 시, 이 아이템에 대한 번개장터 주문 생성 불가
        logger.warn(`[OrderSvc:Job-${jobId}] Could not fetch details for Bunjang product PID ${bunjangPid} (Order: ${shopifyOrderId}). Cannot create Bunjang order for this item.`);
        await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-NotFound`] });
        continue;
      }

      // 2. 번개장터 "Create Order V2" API 페이로드 구성 (orderMapper 사용)
      const bunjangOrderPayload = orderMapper.mapShopifyItemToBunjangOrderPayload(item, bunjangPid, bunjangProductDetails);
      if (!bunjangOrderPayload) {
        logger.error(`[OrderSvc:Job-${jobId}] Failed to map Bunjang order payload for PID ${bunjangPid} (Order: ${shopifyOrderId}).`);
        await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-MapFail`] });
        continue;
      }
      
      // 3. 배송비 0원 정책 적용 (요구사항)
      //    "주문 시 배송비는 자동으로 0원으로 설정되며, 배송비는 별도로 이메일을 통해 고객에게 청구됨"
      const actualBunjangShippingFeeKrw = bunjangProductDetails.shippingFee || 0;
      bunjangOrderPayload.deliveryPrice = 0; // API 요청 시 배송비 0으로 설정
      logger.info(`[OrderSvc:Job-${jobId}] Applying 0 KRW delivery fee policy for PID ${bunjangPid}. Actual Bunjang shipping fee: ${actualBunjangShippingFeeKrw} KRW.`);

      // 4. 번개장터 주문 생성 API 호출 (자동으로 포인트 차감됨)
      logger.info(`[OrderSvc:Job-${jobId}] Creating Bunjang order for PID ${bunjangPid} (Order: ${shopifyOrderId}). Total amount: ${bunjangOrderPayload.product.price + bunjangOrderPayload.deliveryPrice} KRW will be deducted from points.`);
      
      try {
        const bunjangApiResponse = await bunjangService.createBunjangOrderV2(bunjangOrderPayload);
        
        if (bunjangApiResponse && bunjangApiResponse.id) {
          const bunjangOrderId = bunjangApiResponse.id;
          logger.info(`[OrderSvc:Job-${jobId}] Successfully created Bunjang order for PID ${bunjangPid} (Order: ${shopifyOrderId}). Bunjang Order ID: ${bunjangOrderId}`);
          createdBunjangOrderIds.push(String(bunjangOrderId));
          bunjangOrderSuccessfullyCreatedOverall = true;

          // 5. Shopify 주문에 태그 및 메타필드 추가
          const tagsToAdd = ['BunjangOrderPlaced', bunjangOrderIdentifier, `BunjangOrderID-${bunjangOrderId}`];
          const metafieldsInput = [
            { namespace: "bunjang", key: "order_id", value: String(bunjangOrderId), type: "single_line_text_field" },
            { namespace: "bunjang", key: "ordered_pid", value: String(bunjangPid), type: "single_line_text_field" },
            { namespace: "bunjang", key: "ordered_item_price_krw", value: String(bunjangOrderPayload.product.price), type: "number_integer" },
            { namespace: "bunjang", key: "api_sent_shipping_fee_krw", value: String(bunjangOrderPayload.deliveryPrice), type: "number_integer" },
            { namespace: "bunjang", key: "actual_bunjang_shipping_fee_krw", value: String(actualBunjangShippingFeeKrw), type: "number_integer" },
          ];
          
          await shopifyService.updateOrder({ id: shopifyOrderGid, tags: tagsToAdd, metafields: metafieldsInput });
          
          // 6. 주문 생성 성공 시 포인트 잔액 확인
          try {
            const pointBalance = await bunjangService.getBunjangPointBalance();
            if (pointBalance) {
              logger.info(`[OrderSvc:Job-${jobId}] Current Bunjang point balance after order: ${pointBalance.balance} KRW, Expiring in 30 days: ${pointBalance.pointExpiredIn30Days} KRW`);
              
              // 포인트 잔액이 특정 임계값 이하면 경고
              const LOW_BALANCE_THRESHOLD = config.bunjang.lowBalanceThreshold || 1000000; // 기본 100만원
              if (pointBalance.balance < LOW_BALANCE_THRESHOLD) {
                logger.warn(`[OrderSvc:Job-${jobId}] LOW POINT BALANCE WARNING: Current balance ${pointBalance.balance} KRW is below threshold ${LOW_BALANCE_THRESHOLD} KRW`);
                // TODO: 관리자에게 알림 발송 (이메일, Slack 등)
                await shopifyService.updateOrder({ 
                  id: shopifyOrderGid, 
                  tags: [`LowPointBalance-${Math.floor(pointBalance.balance)}`] 
                });
              }
            }
          } catch (balanceError) {
            logger.warn(`[OrderSvc:Job-${jobId}] Failed to check point balance after order: ${balanceError.message}`);
          }
        } else {
          logger.error(`[OrderSvc:Job-${jobId}] Bunjang order creation response missing order ID for PID ${bunjangPid}`);
          await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-NoOrderId`] });
        }
      } catch (apiError) {
        // 번개장터 API 에러 코드에 따른 상세한 처리
        let errorTag = `PID-${bunjangPid}-CreateFail`;
        let errorMessage = apiError.message;
        
        if (apiError.originalError?.response?.data?.errorCode) {
          const errorCode = apiError.originalError.response.data.errorCode;
          errorMessage = `${errorCode}: ${apiError.originalError.response.data.reason || apiError.message}`;
          
          // 에러 코드별 특수 처리
          switch(errorCode) {
            case 'PRODUCT_NOT_FOUND':
            case 'PRODUCT_SOLD_OUT':
            case 'PRODUCT_ON_HOLD':
              errorTag = `PID-${bunjangPid}-NotAvailable`;
              break;
            case 'INVALID_PRODUCT_PRICE':
              errorTag = `PID-${bunjangPid}-PriceChanged`;
              break;
            case 'INVALID_PRODUCT_QTY':
              errorTag = `PID-${bunjangPid}-OutOfStock`;
              break;
            case 'POINT_SHORTAGE':
              errorTag = `PID-${bunjangPid}-InsufficientPoints`;
              logger.error(`[OrderSvc:Job-${jobId}] CRITICAL: Insufficient Bunjang points to create order for PID ${bunjangPid}`);
              // TODO: 긴급 관리자 알림 발송
              break;
            case 'INVALID_SELF_PURCHASE':
              errorTag = `PID-${bunjangPid}-SelfPurchase`;
              break;
            case 'BLOCKED_BY_OPPONENT':
            case 'BLOCKED_BY_SELF':
              errorTag = `PID-${bunjangPid}-Blocked`;
              break;
            default:
              errorTag = `PID-${bunjangPid}-${errorCode}`;
          }
        }
        
        logger.error(`[OrderSvc:Job-${jobId}] Failed to create Bunjang order for PID ${bunjangPid}: ${errorMessage}`, {
          errorCode: apiError.errorCode,
          details: apiError.details,
          stack: apiError.stack?.substring(0, 500)
        });
        
        await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, errorTag] });
        // 개별 상품 실패 시 다음 상품으로 계속 진행
      }

    } catch (error) {
      logger.error(`[OrderSvc:Job-${jobId}] Error processing Bunjang order for Shopify item SKU ${item.sku} (PID ${bunjangPid}, Order: ${shopifyOrderId}): ${error.message}`, {
        errorCode: error.errorCode, details: error.details, stack: error.stack?.substring(0,500)
      });
      await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-Exception`] });
    }
  } // end of for loop for line_items

  if (bunjangOrderSuccessfullyCreatedOverall) {
    logger.info(`[OrderSvc:Job-${jobId}] Bunjang order(s) (IDs: ${createdBunjangOrderIds.join(', ')}) successfully processed for Shopify Order ID: ${shopifyOrderId}.`);
    return { success: true, bunjangOrderIds: createdBunjangOrderIds, message: `번개장터 주문(들) 생성 성공: ${createdBunjangOrderIds.join(', ')}` };
  } else {
    logger.warn(`[OrderSvc:Job-${jobId}] No Bunjang order was successfully created for Shopify Order ID: ${shopifyOrderId}.`);
    return { success: false, message: 'Shopify 주문에 포함된 번개장터 연동 상품에 대해 번개장터 주문을 생성하지 못했습니다.' };
  }
}

/**
 * 번개장터 주문 상태를 동기화합니다.
 * @param {Date|string} startDate - 조회 시작일
 * @param {Date|string} endDate - 조회 종료일 (최대 15일 간격)
 * @param {string} [jobId='N/A'] - 작업 ID (로깅용)
 * @returns {Promise<{success: boolean, syncedOrders: number, errors: number}>}
 */
async function syncBunjangOrderStatuses(startDate, endDate, jobId = 'N/A') {
  logger.info(`[OrderSvc:Job-${jobId}] Starting Bunjang order status sync from ${startDate} to ${endDate}`);
  
  // 날짜 포맷 변환 (UTC ISO 형식으로)
  const startDateUTC = new Date(startDate).toISOString();
  const endDateUTC = new Date(endDate).toISOString();
  
  // 날짜 범위 검증 (최대 15일)
  const diffDays = (new Date(endDateUTC) - new Date(startDateUTC)) / (1000 * 60 * 60 * 24);
  if (diffDays > 15) {
    throw new ValidationError('번개장터 주문 조회는 최대 15일 범위만 가능합니다.', [
      { field: 'dateRange', message: `요청된 범위: ${diffDays}일` }
    ]);
  }
  
  let syncedCount = 0;
  let errorCount = 0;
  let page = 0;
  let hasMore = true;
  
  try {
    while (hasMore) {
      const ordersResponse = await bunjangService.getBunjangOrders({
        statusUpdateStartDate: startDateUTC,
        statusUpdateEndDate: endDateUTC,
        page: page,
        size: 100 // 최대값 사용
      });
      
      if (!ordersResponse || !ordersResponse.data) break;
      
      for (const order of ordersResponse.data) {
        try {
          await updateShopifyOrderFromBunjangStatus(order, jobId);
          syncedCount++;
        } catch (error) {
          logger.error(`[OrderSvc:Job-${jobId}] Failed to sync order ${order.id}: ${error.message}`);
          errorCount++;
        }
      }
      
      hasMore = page < (ordersResponse.totalPages - 1);
      page++;
    }
    
    logger.info(`[OrderSvc:Job-${jobId}] Order status sync completed. Synced: ${syncedCount}, Errors: ${errorCount}`);
    return { success: true, syncedOrders: syncedCount, errors: errorCount };
    
  } catch (error) {
    logger.error(`[OrderSvc:Job-${jobId}] Order status sync failed: ${error.message}`);
    throw error;
  }
}

/**
 * 번개장터 주문 상태를 기반으로 Shopify 주문을 업데이트합니다.
 * @param {object} bunjangOrder - 번개장터 주문 정보
 * @param {string} [jobId='N/A'] - 작업 ID
 */
async function updateShopifyOrderFromBunjangStatus(bunjangOrder, jobId = 'N/A') {
  const bunjangOrderId = bunjangOrder.id;
  
  // Shopify에서 해당 번개장터 주문과 연결된 주문 찾기
  const query = `
    query findOrderByBunjangId($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            tags
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                }
              }
            }
          }
        }
      }
    }
  `;
  
  const searchQuery = `tag:"BunjangOrderID-${bunjangOrderId}"`;
  const response = await shopifyService.shopifyGraphqlRequest(query, { query: searchQuery });
  
  if (!response.data.orders.edges || response.data.orders.edges.length === 0) {
    logger.warn(`[OrderSvc:Job-${jobId}] No Shopify order found for Bunjang order ${bunjangOrderId}`);
    return;
  }
  
  const shopifyOrder = response.data.orders.edges[0].node;
  const shopifyOrderGid = shopifyOrder.id;
  
  // 각 주문 아이템의 상태 확인
  for (const orderItem of bunjangOrder.orderItems) {
    const status = orderItem.status;
    const productId = orderItem.product.id;
    
    logger.info(`[OrderSvc:Job-${jobId}] Bunjang order ${bunjangOrderId}, product ${productId} status: ${status}`);
    
    // 상태별 처리
    switch(status) {
      case 'SHIP_READY':
      case 'IN_TRANSIT':
      case 'DELIVERY_COMPLETED':
        // 배송 관련 상태 - Shopify fulfillment 업데이트 필요
        await updateShopifyFulfillmentStatus(shopifyOrderGid, status, orderItem, jobId);
        break;
        
      case 'PURCHASE_CONFIRM':
        // 구매 확정 - 메타필드 업데이트
        await shopifyService.updateOrder({
          id: shopifyOrderGid,
          metafields: [{
            namespace: 'bunjang',
            key: 'purchase_confirmed',
            value: 'true',
            type: 'single_line_text_field'
          }, {
            namespace: 'bunjang',
            key: 'purchase_confirmed_at',
            value: orderItem.purchaseConfirmedAt || new Date().toISOString(),
            type: 'date_time'
          }]
        });
        break;
        
      case 'CANCEL_REQUESTED_BEFORE_SHIPPING':
      case 'REFUNDED':
      case 'RETURN_REQUESTED':
      case 'RETURNED':
        // 취소/반품 관련 - 태그 추가
        await shopifyService.updateOrder({
          id: shopifyOrderGid,
          tags: [`BunjangStatus-${status}`, `BunjangOrder-${bunjangOrderId}-${status}`]
        });
        // TODO: Shopify 환불 처리 로직 추가 필요
        break;
    }
    
    // 상태 업데이트 시간 기록
    await shopifyService.updateOrder({
      id: shopifyOrderGid,
      metafields: [{
        namespace: 'bunjang',
        key: 'last_status_sync',
        value: new Date().toISOString(),
        type: 'date_time'
      }, {
        namespace: 'bunjang',
        key: 'last_bunjang_status',
        value: status,
        type: 'single_line_text_field'
      }]
    });
  }
}

/**
 * Shopify fulfillment 상태를 업데이트합니다.
 * @param {string} shopifyOrderGid - Shopify 주문 GID
 * @param {string} bunjangStatus - 번개장터 주문 상태
 * @param {object} orderItem - 번개장터 주문 아이템
 * @param {string} jobId - 작업 ID
 */
async function updateShopifyFulfillmentStatus(shopifyOrderGid, bunjangStatus, orderItem, jobId) {
  // TODO: Shopify Fulfillment API를 사용한 배송 상태 업데이트 구현
  // 이 부분은 Shopify의 Fulfillment API와 연동하여 구현해야 합니다.
  logger.info(`[OrderSvc:Job-${jobId}] TODO: Update Shopify fulfillment for order ${shopifyOrderGid} with Bunjang status ${bunjangStatus}`);
  
  // 예시 구현:
  // if (bunjangStatus === 'IN_TRANSIT') {
  //   const fulfillmentMutation = `
  //     mutation fulfillmentCreateV2($fulfillment: FulfillmentInput!) {
  //       fulfillmentCreateV2(fulfillment: $fulfillment) {
  //         fulfillment {
  //           id
  //           status
  //         }
  //         userErrors {
  //           field
  //           message
  //         }
  //       }
  //     }
  //   `;
  //   
  //   const fulfillmentInput = {
  //     notifyCustomer: true,
  //     trackingInfo: {
  //       company: "배송 회사",
  //       number: "운송장 번호",
  //       url: "추적 URL"
  //     }
  //   };
  //   
  //   await shopifyService.shopifyGraphqlRequest(fulfillmentMutation, { fulfillment: fulfillmentInput });
  // }
}

module.exports = {
  processShopifyOrderForBunjang, // BullMQ 주문 워커가 호출
  syncBunjangOrderStatuses, // 주문 상태 동기화
  updateShopifyOrderFromBunjangStatus, // 개별 주문 상태 업데이트
};