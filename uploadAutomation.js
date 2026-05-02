const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('../config/database');


// ================================
// CONFIG
// ================================
const MAX_RETRIES = 3;
const DELAY_BETWEEN_CLIENTS = 3000; // 3 sec

// ================================
// SIMPLE LOGGER
// ================================
function log(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// ================================
// RETRY WRAPPER
// ================================
async function retry(fn, retries = MAX_RETRIES) {
    for (let i = 1; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            log(`⚠️ Attempt ${i} failed: ${err.message}`);
            if (i === retries) throw err;
            await new Promise(res => setTimeout(res, 3000));
        }
    }
}
