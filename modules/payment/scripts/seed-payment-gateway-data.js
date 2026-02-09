/**
 * Seed Payment Gateway tables to match admin-development payment data.json files.
 * Populates: sessions (24), transactions (24), schedules (20), tokens (20), webhooks (24).
 *
 * Run (after init-dynamo-tables): NODE_ENV=test node scripts/seed-payment-gateway-data.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const paymentGatewayService = require('../src/services/paymentGatewayService.js');
const ScyllaDb = require('../src/utils/ScyllaDb.js');

const emptyPayloads = { requestData: {}, responseData: {} };

// Same user/order/transaction/session/subscription/registration ids as data.json
function ord(n) { return `ord_${String(n).padStart(3, '0')}`; }
function txn(n) { return `txn_${String(n).padStart(3, '0')}`; }
function chk(n) { return `chk_${String(n).padStart(3, '0')}`; }
function sub(n) { return `sub_${String(n).padStart(3, '0')}`; }
function reg(n) { return `reg_${String(n).padStart(3, '0')}`; }
function idem(n) { return `idem_${String(n).padStart(3, '0')}`; }

async function seed() {
  console.log('Seeding payment gateway data (data.json style)...');

  await ScyllaDb.ping();

  // 1) Sessions – 24 rows matching payment-sessions/data.json (id, orderContext, updatedAt, created_at for GSI)
  const sessionUsers = ['user_001','user_002','user_003','user_001','user_004','user_002','user_005','user_003','user_001','user_004','user_002','user_005','user_003','user_001','user_004','user_002','user_005','user_003','user_001','user_004','user_002','user_005','user_003','user_001'];
  const sessionStatuses = ['pending','success','authorized','completed','pending','completed','failed','success','voided','completed','success','authorized','pending','completed','success','pending','failed','completed','completed','pending','success','completed','completed','pending'];
  const sessionAmounts = [25.5,100,50,75.25,30,200,45,120,55.5,90,35.75,180,22,310,67,44.5,99.99,156,28,88.25,42,210,19.99,135];
  const sessionCurrencies = ['USD','USD','EUR','USD','USD','USD','GBP','USD','USD','USD','USD','USD','USD','USD','EUR','USD','USD','USD','USD','USD','USD','USD','USD','USD'];
  const sessionTypes = ['card','card','token','card','card','card','token','card','card','card','card','token','card','card','card','card','token','card','card','card','card','token','card','card'];
  const sessionPaymentTypes = ['DB','PA','PA','DB',null,'DB',null,'DB',null,'DB','DB','PA',null,'DB','PA',null,null,'DB',null,null,'DB','DB',null,null];
  const sessionOrderContexts = ['products_digital','subscription','wallet_topups','products_physical','mixed','subscription','products_digital','wallet_topups','products_physical','subscription','products_digital','mixed','wallet_topups','products_physical','subscription','products_digital','mixed','wallet_topups','products_physical','subscription','products_digital','wallet_topups','mixed','products_physical'];
  const sessionCreatedAt = ['2026-01-15T10:30:00Z','2026-01-16T14:20:00Z','2026-01-17T09:15:00Z','2026-01-18T16:45:00Z','2026-01-19T11:30:00Z','2026-01-20T13:20:00Z','2026-01-21T08:10:00Z','2026-01-22T15:55:00Z','2026-01-23T10:40:00Z','2026-01-24T12:25:00Z','2026-01-25T09:05:00Z','2026-01-26T14:50:00Z','2026-01-27T11:00:00Z','2026-01-28T09:30:00Z','2026-01-29T10:15:00Z','2026-01-30T14:45:00Z','2026-01-31T08:20:00Z','2026-02-01T12:05:00Z','2026-02-02T17:40:00Z','2026-02-03T09:55:00Z','2026-02-04T13:10:00Z','2026-02-05T11:25:00Z','2026-02-06T16:00:00Z','2026-02-07T19:35:00Z'];
  const sessionUpdatedAt = ['2026-01-15T10:30:00Z','2026-01-16T14:25:00Z','2026-01-17T09:16:00Z','2026-01-18T16:50:00Z','2026-01-19T11:30:00Z','2026-01-20T13:22:00Z','2026-01-21T08:12:00Z','2026-01-22T16:00:00Z','2026-01-23T11:00:00Z','2026-01-24T12:28:00Z','2026-01-25T09:06:00Z','2026-01-26T14:51:00Z','2026-01-27T11:00:00Z','2026-01-28T09:35:00Z','2026-01-29T10:18:00Z','2026-01-30T14:45:00Z','2026-01-31T08:22:00Z','2026-02-01T12:08:00Z','2026-02-02T17:42:00Z','2026-02-03T09:55:00Z','2026-02-04T13:11:00Z','2026-02-05T11:28:00Z','2026-02-06T16:01:00Z','2026-02-07T19:35:00Z'];

  for (let i = 1; i <= 24; i++) {
    const o = ord(i);
    const sess = {
      id: `session#${o}`,
      pk: `user#${sessionUsers[i-1]}`,
      sk: `session#${o}`,
      order_id: o,
      created_at: sessionCreatedAt[i - 1],
      checkoutId: chk(i),
      userId: sessionUsers[i - 1],
      orderId: o,
      sessionType: sessionTypes[i - 1],
      gateway: 'axcess',
      orderContext: sessionOrderContexts[i - 1],
      status: sessionStatuses[i - 1],
      amount: sessionAmounts[i - 1],
      currency: sessionCurrencies[i - 1],
      payloads: i === 7 ? { requestData: {}, responseData: { error: 'card_declined' } } : i === 17 ? { requestData: {}, responseData: { error: 'timeout' } } : emptyPayloads,
      createdAt: sessionCreatedAt[i - 1],
      updatedAt: sessionUpdatedAt[i - 1],
    };
    if (sessionPaymentTypes[i - 1]) sess.paymentType = sessionPaymentTypes[i - 1];
    if (['success','completed','authorized'].includes(sessionStatuses[i - 1])) sess.transactionId = `txn_gw_${String(i).padStart(3, '0')}`;
    await paymentGatewayService.saveSession(sess);
  }
  console.log('Seeded 24 payment sessions.');

  // 2) Transactions – 24 rows matching payment-transactions/data.json
  const txnUsers = ['user_001','user_003','user_002','user_004','user_001','user_005','user_002','user_004','user_003','user_001','user_005','user_001','user_002','user_004','user_006','user_002','user_003','user_001','user_005','user_006','user_003','user_002','user_004','user_001'];
  const txnBeneficiaries = ['user_002','user_001','user_004','user_002','user_005','user_003','user_001','user_005','user_002','user_003','user_004','user_003','user_005','user_001','user_002','user_006','user_004','user_006','user_002','user_003','user_006','user_005','user_002','user_004'];
  const txnOrderTypes = ['payment','transfer','payment','refund','payment','transfer','payment','transfer','payment','refund','payment','transfer','transfer','payment','payment','transfer','refund','payment','transfer','payment','transfer','refund','payment','transfer'];
  const txnStatuses = ['success','success','failed','refunded','authorized','success','success','failed','success','refunded','pending','success','success','failed','success','chargeback','refunded','failed','success','success','voided','refunded','success','pending'];
  const txnAmounts = [25.5,100,50,50,75.25,30,150,20,200,100,45.75,15,60,120,80,40,35,55.5,22,130,18,90,75,27];
  const txnCreatedAt = ['2026-01-15T10:30:00Z','2026-01-16T14:20:00Z','2026-01-17T09:15:00Z','2026-01-18T16:45:00Z','2026-01-19T11:30:00Z','2026-01-20T13:20:00Z','2026-01-21T08:10:00Z','2026-01-22T15:55:00Z','2026-01-23T10:40:00Z','2026-01-24T12:25:00Z','2026-01-25T09:05:00Z','2026-01-26T14:50:00Z','2026-01-27T11:00:00Z','2026-01-28T09:30:00Z','2026-01-29T10:15:00Z','2026-01-30T14:45:00Z','2026-01-31T08:20:00Z','2026-02-01T12:05:00Z','2026-02-02T17:40:00Z','2026-02-03T09:55:00Z','2026-02-04T13:10:00Z','2026-02-05T11:25:00Z','2026-02-06T16:00:00Z','2026-02-07T19:35:00Z'];
  const txnUpdatedAt = ['2026-01-15T10:30:05Z','2026-01-16T14:20:02Z','2026-01-17T09:15:01Z','2026-01-18T16:45:03Z','2026-01-19T11:30:01Z','2026-01-20T13:20:02Z','2026-01-21T08:10:04Z','2026-01-22T15:55:01Z','2026-01-23T10:40:06Z','2026-01-24T12:25:02Z','2026-01-25T09:05:00Z','2026-01-26T14:50:01Z','2026-01-27T11:00:02Z','2026-01-28T09:30:01Z','2026-01-29T10:15:03Z','2026-02-01T10:00:00Z','2026-01-31T08:20:02Z','2026-02-01T12:05:01Z','2026-02-02T17:40:01Z','2026-02-03T09:55:04Z','2026-02-04T14:00:00Z','2026-02-05T11:25:02Z','2026-02-06T16:00:03Z','2026-02-07T19:35:00Z'];
  const txnPayloads = [emptyPayloads,emptyPayloads,{requestData:{},responseData:{error:'declined'}},emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads,emptyPayloads];

  for (let i = 1; i <= 24; i++) {
    const o = ord(i);
    const t = txn(i);
    await paymentGatewayService.saveTransaction({
      pk: `user#${txnUsers[i - 1]}`,
      sk: `txn#${t}`,
      transactionId: t,
      userId: txnUsers[i - 1],
      orderId: o,
      gateway: 'axcess',
      gatewayTxnId: i <= 5 || i === 9 || i === 10 || i === 15 || i === 20 || i === 22 ? `axc_${String(i).padStart(3, '0')}` : undefined,
      registrationId: i === 1 ? 'reg_001' : undefined,
      amount: txnAmounts[i - 1],
      currency: 'USD',
      paymentType: i === 5 || i === 9 ? 'PA' : 'DB',
      orderType: txnOrderTypes[i - 1],
      status: txnStatuses[i - 1],
      resultCode: i === 3 ? '05' : i === 4 || i === 10 || i === 17 || i === 22 ? '00' : i === 8 ? '51' : i === 14 ? '14' : i === 16 ? 'CB' : undefined,
      resultDescription: i === 3 ? 'Declined' : i === 8 ? 'Insufficient funds' : i === 16 ? 'Chargeback' : i === 21 ? 'Voided by merchant' : undefined,
      uiMessage: i === 1 ? 'Payment successful' : i === 3 ? 'Card declined' : undefined,
      payerId: txnUsers[i - 1],
      beneficiaryId: txnBeneficiaries[i - 1],
      recipientId: txnBeneficiaries[i - 1],
      brand: i === 1 || i === 23 ? 'Visa' : i === 2 ? 'Mastercard' : undefined,
      last4: i === 1 ? '4242' : i === 2 ? '5555' : i === 6 ? '1234' : i === 23 ? '9999' : undefined,
      scheduleId: null,
      transactionType: txnOrderTypes[i - 1],
      subscriptionId: [1, 5, 9, 15, 20].includes(i) ? sub(i) : undefined,
      createdAt: txnCreatedAt[i - 1],
      updatedAt: txnUpdatedAt[i - 1],
      payloads: txnPayloads[i - 1],
      statusGSI: `status#${txnStatuses[i - 1]}`,
    });
  }
  console.log('Seeded 24 payment transactions.');

  // 3) Schedules – 20 rows matching payment-schedules/data.json (service requires subscriptionId, orderId, startDate, nextScheduleDate)
  const scheduleRows = [
    { userId: 'user_001', orderId: ord(1), subId: 'sub_001', regId: reg(1), status: 'active', frequency: 'monthly', amount: '25.00', startDate: '2026-01-01', nextScheduleDate: '2026-02-01', createdAt: '2026-01-01T00:00:00Z' },
    { userId: 'user_002', orderId: ord(2), subId: 'sub_002', regId: reg(2), status: 'active', frequency: 'yearly', amount: '200.00', startDate: '2025-06-01', nextScheduleDate: '2026-06-01', createdAt: '2025-06-01T00:00:00Z' },
    { userId: 'user_003', orderId: ord(3), subId: 'sub_003', regId: reg(3), status: 'paused', frequency: 'monthly', amount: '50.00', startDate: '2025-12-01', nextScheduleDate: '2026-02-01', createdAt: '2025-12-01T00:00:00Z' },
    { userId: 'user_001', orderId: ord(4), subId: 'sub_004', regId: reg(4), status: 'active', frequency: 'monthly', amount: '15.00', startDate: '2026-01-15', nextScheduleDate: '2026-02-15', createdAt: '2026-01-15T00:00:00Z' },
    { userId: 'user_004', orderId: ord(5), subId: 'sub_005', regId: reg(5), status: 'paused', frequency: 'yearly', amount: '120.00', startDate: '2025-03-01', nextScheduleDate: '2026-03-01', createdAt: '2025-03-01T00:00:00Z' },
    { userId: 'user_005', orderId: ord(6), subId: 'sub_006', regId: reg(6), status: 'active', frequency: 'monthly', amount: '30.00', currency: 'EUR', startDate: '2026-01-10', nextScheduleDate: '2026-02-10', createdAt: '2026-01-10T00:00:00Z' },
    { userId: 'user_002', orderId: ord(7), subId: 'sub_007', regId: reg(7), status: 'active', frequency: 'monthly', amount: '45.00', startDate: '2025-11-20', nextScheduleDate: '2026-02-20', createdAt: '2025-11-20T00:00:00Z' },
    { userId: 'user_003', orderId: ord(8), subId: 'sub_008', regId: reg(8), status: 'paused', frequency: 'monthly', amount: '20.00', startDate: '2026-01-05', nextScheduleDate: '2026-02-05', createdAt: '2026-01-05T00:00:00Z' },
    { userId: 'user_001', orderId: ord(9), subId: 'sub_009', regId: reg(9), status: 'active', frequency: 'yearly', amount: '99.00', startDate: '2026-01-01', nextScheduleDate: '2027-01-01', createdAt: '2026-01-01T00:00:00Z' },
    { userId: 'user_006', orderId: ord(10), subId: 'sub_010', regId: reg(10), status: 'active', frequency: 'monthly', amount: '35.00', startDate: '2026-01-20', nextScheduleDate: '2026-02-20', createdAt: '2026-01-20T00:00:00Z' },
    { userId: 'user_004', orderId: ord(11), subId: 'sub_011', regId: reg(11), status: 'active', frequency: 'monthly', amount: '40.00', startDate: '2025-10-01', nextScheduleDate: '2026-02-01', createdAt: '2025-10-01T00:00:00Z' },
    { userId: 'user_005', orderId: ord(12), subId: 'sub_012', regId: reg(12), status: 'paused', frequency: 'monthly', amount: '28.00', startDate: '2026-01-12', nextScheduleDate: '2026-02-12', createdAt: '2026-01-12T00:00:00Z' },
    { userId: 'user_002', orderId: ord(13), subId: 'sub_013', regId: reg(13), status: 'active', frequency: 'yearly', amount: '350.00', startDate: '2025-07-01', nextScheduleDate: '2026-07-01', createdAt: '2025-07-01T00:00:00Z' },
    { userId: 'user_003', orderId: ord(14), subId: 'sub_014', regId: reg(14), status: 'active', frequency: 'monthly', amount: '55.00', startDate: '2026-01-08', nextScheduleDate: '2026-02-08', createdAt: '2026-01-08T00:00:00Z' },
    { userId: 'user_001', orderId: ord(15), subId: 'sub_015', regId: reg(15), status: 'paused', frequency: 'monthly', amount: '18.00', startDate: '2025-09-15', nextScheduleDate: '2026-02-15', createdAt: '2025-09-15T00:00:00Z' },
    { userId: 'user_006', orderId: ord(16), subId: 'sub_016', regId: reg(16), status: 'active', frequency: 'monthly', amount: '22.00', startDate: '2026-01-25', nextScheduleDate: '2026-02-25', createdAt: '2026-01-25T00:00:00Z' },
    { userId: 'user_004', orderId: ord(17), subId: 'sub_017', regId: reg(17), status: 'active', frequency: 'monthly', amount: '60.00', startDate: '2025-08-01', nextScheduleDate: '2026-02-01', createdAt: '2025-08-01T00:00:00Z' },
    { userId: 'user_005', orderId: ord(18), subId: 'sub_018', regId: reg(18), status: 'active', frequency: 'yearly', amount: '180.00', startDate: '2026-01-01', nextScheduleDate: '2027-01-01', createdAt: '2026-01-01T00:00:00Z' },
    { userId: 'user_002', orderId: ord(19), subId: 'sub_019', regId: reg(19), status: 'paused', frequency: 'monthly', amount: '32.00', startDate: '2026-01-18', nextScheduleDate: '2026-02-18', createdAt: '2026-01-18T00:00:00Z' },
    { userId: 'user_003', orderId: ord(20), subId: 'sub_020', regId: reg(20), status: 'active', frequency: 'monthly', amount: '48.00', startDate: '2025-12-10', nextScheduleDate: '2026-02-10', createdAt: '2025-12-10T00:00:00Z' },
  ];
  const TABLE_SCHEDULES = 'paymentGateway_schedules';
  for (const row of scheduleRows) {
    await ScyllaDb.putItem(TABLE_SCHEDULES, {
      pk: `user#${row.userId}`,
      sk: `schedule#${row.subId}#${row.createdAt}`,
      subscriptionId: row.subId,
      orderId: row.orderId,
      registrationId: row.regId,
      userId: row.userId,
      amount: row.amount,
      currency: row.currency || 'USD',
      frequency: row.frequency,
      status: row.status,
      startDate: row.startDate,
      nextScheduleDate: row.nextScheduleDate,
      createdAt: row.createdAt,
    });
  }
  console.log('Seeded 20 payment schedules.');

  // 4) Tokens – 20 rows matching payment-tokens/data.json
  const tokenRows = [
    { userId: 'user_001', regId: reg(1), brand: 'Visa', last4: '4242', expiry: '2026-12', status: 'active', name: 'John Doe' },
    { userId: 'user_002', regId: reg(2), brand: 'Mastercard', last4: '5555', expiry: '2026-06', status: 'active', name: 'Jane Smith' },
    { userId: 'user_003', regId: reg(3), brand: 'Visa', last4: '1234', expiry: '2027-01', status: 'active', name: 'Bob Wilson' },
    { userId: 'user_001', regId: reg(4), brand: 'Visa', last4: '9876', expiry: '2026-03', status: 'expired', name: 'John Doe' },
    { userId: 'user_004', regId: reg(5), brand: 'Visa', last4: '1111', expiry: '2026-09', status: 'active', name: 'Alice Brown' },
    { userId: 'user_005', regId: reg(6), brand: 'Visa', last4: '2222', expiry: '2026-11', status: 'active', name: 'Charlie Davis' },
    { userId: 'user_002', regId: reg(7), brand: 'Visa', last4: '3333', expiry: '2027-02', status: 'active', name: 'Jane Smith' },
    { userId: 'user_003', regId: reg(8), brand: 'Visa', last4: '4444', expiry: '2026-08', status: 'active', name: 'Bob Wilson' },
    { userId: 'user_001', regId: reg(9), brand: 'Visa', last4: '6666', expiry: '2026-05', status: 'expired', name: 'John Doe' },
    { userId: 'user_006', regId: reg(10), brand: 'Visa', last4: '7777', expiry: '2026-10', status: 'active', name: 'Eve Clark' },
    { userId: 'user_004', regId: reg(11), brand: 'Visa', last4: '8888', expiry: '2027-03', status: 'active', name: 'Alice Brown' },
    { userId: 'user_005', regId: reg(12), brand: 'Visa', last4: '9999', expiry: '2026-07', status: 'active', name: 'Charlie Davis' },
    { userId: 'user_002', regId: reg(13), brand: 'Visa', last4: '0000', expiry: '2026-04', status: 'expired', name: 'Jane Smith' },
    { userId: 'user_003', regId: reg(14), brand: 'Visa', last4: '1212', expiry: '2027-06', status: 'active', name: 'Bob Wilson' },
    { userId: 'user_001', regId: reg(15), brand: 'Visa', last4: '3434', expiry: '2026-02', status: 'expired', name: 'John Doe' },
    { userId: 'user_006', regId: reg(16), brand: 'Visa', last4: '5656', expiry: '2026-12', status: 'active', name: 'Eve Clark' },
    { userId: 'user_004', regId: reg(17), brand: 'Visa', last4: '7878', expiry: '2026-11', status: 'active', name: 'Alice Brown' },
    { userId: 'user_005', regId: reg(18), brand: 'Visa', last4: '9090', expiry: '2027-01', status: 'active', name: 'Charlie Davis' },
    { userId: 'user_002', regId: reg(19), brand: 'Visa', last4: '2468', expiry: '2026-08', status: 'active', name: 'Jane Smith' },
    { userId: 'user_003', regId: reg(20), brand: 'Visa', last4: '1357', expiry: '2026-09', status: 'active', name: 'Bob Wilson' },
  ];
  for (let i = 0; i < tokenRows.length; i++) {
    const row = tokenRows[i];
    const createdAt = `2026-01-${String(15 + (i % 15)).padStart(2, '0')}T10:30:00Z`;
    await paymentGatewayService.saveToken({
      pk: `user#${row.userId}`,
      sk: `token#${row.regId}`,
      userId: row.userId,
      registrationId: row.regId,
      gateway: 'axcess',
      brand: row.brand,
      type: 'card',
      last4: row.last4,
      expiry: row.expiry,
      status: row.status,
      name: row.name,
      country: 'US',
      fingerprint: `fp_${row.regId}`,
      raw: {},
      metadata: {},
      createdAt,
    });
  }
  console.log('Seeded 20 payment tokens.');

  // 5) Webhooks – 24 rows matching payment-webhooks/data.json (handled + payload + createdAt)
  const webhookHandled = [true,true,false,true,false,true,true,false,true,true,false,true,true,false,true,false,true,true,false,true,true,false,true,true];
  const webhookPayloads = [
    { event: 'payment.completed' },{ event: 'payment.captured' },{ event: 'payment.pending' },{ event: 'processed' },{ event: 'refund.requested' },{ event: 'processed' },{ event: 'subscription.renewed' },{ event: 'processed' },{ event: 'processed' },{ event: 'payment.failed' },{ event: 'processed' },{ event: 'processed' },{ event: 'transfer.completed' },{ event: 'processed' },{ event: 'processed' },{ event: 'processed' },{ event: 'payment.disputed' },{ event: 'processed' },{ event: 'processed' },{ event: 'processed' },{ event: 'processed' },{ event: 'subscription.cancelled' },{ event: 'processed' },{ event: 'processed' },
  ];
  const webhookCreatedAt = ['2026-01-15T10:30:00Z','2026-01-16T14:20:00Z','2026-01-17T09:15:00Z','2026-01-18T16:45:00Z','2026-01-19T11:30:00Z','2026-01-20T13:20:00Z','2026-01-21T08:10:00Z','2026-01-22T15:55:00Z','2026-01-23T10:40:00Z','2026-01-24T12:25:00Z','2026-01-25T09:05:00Z','2026-01-26T14:50:00Z','2026-01-27T11:00:00Z','2026-01-28T09:30:00Z','2026-01-29T10:15:00Z','2026-01-30T14:45:00Z','2026-01-31T08:20:00Z','2026-02-01T12:05:00Z','2026-02-02T17:40:00Z','2026-02-03T09:55:00Z','2026-02-04T13:10:00Z','2026-02-05T11:25:00Z','2026-02-06T16:00:00Z','2026-02-07T19:35:00Z'];
  for (let i = 1; i <= 24; i++) {
    await paymentGatewayService.saveWebhook({
      orderId: ord(i),
      idempotencyKey: idem(i),
      actionTaken: 'processed',
      handled: webhookHandled[i - 1],
      payload: webhookPayloads[i - 1] || {},
      createdAt: webhookCreatedAt[i - 1],
    });
  }
  console.log('Seeded 24 payment webhooks.');

  console.log('Payment gateway seed complete.');
  if (typeof ScyllaDb.endSession === 'function') await ScyllaDb.endSession();
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
