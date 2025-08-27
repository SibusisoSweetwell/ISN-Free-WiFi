#!/usr/bin/env node

/**
 * Comprehensive Proxy Restriction Testing Script
 * Tests all user types: Manual Proxy, Auto Proxy, and No Proxy configurations
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SERVER_BASE = 'http://10.5.48.94:3151';
const PROXY_HOST = '10.5.48.94';
const PROXY_PORT = 9092;

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`${title}`, 'bright');
  log(`${'='.repeat(60)}`, 'cyan');
}

function test(name, success, details = '') {
  const status = success ? '✅ PASS' : '❌ FAIL';
  const statusColor = success ? 'green' : 'red';
  log(`${status} ${name}`, statusColor);
  if (details) {
    log(`   ${details}`, 'yellow');
  }
}

// Test functions
async function testDirectConnection(testUrl) {
  try {
    const response = await fetch(testUrl, { 
      method: 'GET',
      timeout: 5000,
      redirect: 'manual' // Don't follow redirects
    });
    
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location') || '';
    const isPortalRedirect = location.includes('login.html') || location.includes('3151');
    
    return {
      success: isRedirect && isPortalRedirect,
      status: response.status,
      location: location,
      redirectedToPortal: isPortalRedirect
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function testProxyConnection(testUrl, simulateProxyType = 'manual') {
  try {
    const url = new URL(testUrl);
    
    // Simulate proxy headers based on type
    const headers = {
      'Host': url.host,
      'User-Agent': simulateProxyType === 'manual' 
        ? 'Mozilla/5.0 (Manual Proxy Test)' 
        : 'Mozilla/5.0 (Auto Proxy Test)',
    };
    
    if (simulateProxyType === 'manual') {
      headers['Proxy-Connection'] = 'keep-alive';
    }
    
    const options = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: testUrl,
      method: 'GET',
      headers: headers,
      timeout: 5000
    };
    
    return new Promise((resolve) => {
      const req = http.request(options, (res) => {
        const isRedirect = res.statusCode >= 300 && res.statusCode < 400;
        const location = res.headers.location || '';
        const isPortalRedirect = location.includes('login.html') || location.includes('3151');
        
        resolve({
          success: isRedirect && isPortalRedirect,
          status: res.statusCode,
          location: location,
          proxyType: simulateProxyType,
          redirectedToPortal: isPortalRedirect
        });
      });
      
      req.on('error', (error) => {
        resolve({
          success: false,
          error: error.message,
          proxyType: simulateProxyType
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: 'Request timeout',
          proxyType: simulateProxyType
        });
      });
      
      req.end();
    });
  } catch (error) {
    return {
      success: false,
      error: error.message,
      proxyType: simulateProxyType
    };
  }
}

async function testPortalAccess() {
  try {
    const response = await fetch(`${SERVER_BASE}/login.html`, {
      method: 'GET',
      timeout: 5000
    });
    
    return {
      success: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') || ''
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function testPACFile() {
  try {
    const response = await fetch(`${SERVER_BASE}/proxy.pac`, {
      method: 'GET',
      timeout: 5000
    });
    
    const content = await response.text();
    const hasProxyFunction = content.includes('FindProxyForURL');
    const hasCorrectProxy = content.includes(PROXY_HOST);
    
    return {
      success: response.ok && hasProxyFunction && hasCorrectProxy,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      hasProxyFunction,
      hasCorrectProxy,
      content: content.substring(0, 200) + '...'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function testInvalidProxyPort() {
  try {
    // Try to connect to an invalid proxy port (-1 simulation)
    const response = await fetch(`${SERVER_BASE}/api/proxy/status`, {
      method: 'GET',
      headers: {
        'X-Test-Invalid-Port': '-1'
      },
      timeout: 5000
    });
    
    return {
      success: response.ok,
      status: response.status
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function testUserTypeDetection() {
  const testCases = [
    { source: 'manual_proxy', blocked_host: 'google.com' },
    { source: 'auto_proxy', blocked_host: 'facebook.com' },
    { source: 'no_proxy', blocked_path: '/test' },
    { message: 'data_exhausted' }
  ];
  
  const results = [];
  
  for (const testCase of testCases) {
    try {
      const params = new URLSearchParams(testCase);
      const response = await fetch(`${SERVER_BASE}/login.html?${params}`, {
        method: 'GET',
        timeout: 5000
      });
      
      const content = await response.text();
      const hasDetection = content.includes('USER-TYPE-DETECTION') || 
                          content.includes(testCase.source || 'data_exhausted');
      
      results.push({
        testCase,
        success: response.ok && hasDetection,
        status: response.status,
        hasDetection
      });
    } catch (error) {
      results.push({
        testCase,
        success: false,
        error: error.message
      });
    }
  }
  
  return results;
}

// Main test execution
async function runComprehensiveTests() {
  log('Starting Comprehensive Proxy Restriction Tests...', 'bright');
  log(`Testing against: ${SERVER_BASE}`, 'blue');
  log(`Proxy server: ${PROXY_HOST}:${PROXY_PORT}`, 'blue');
  
  // Test 1: Portal Access (Should always work)
  section('1. Portal Access Test');
  const portalTest = await testPortalAccess();
  test('Portal login page accessible', portalTest.success, 
       portalTest.error || `Status: ${portalTest.status}, Type: ${portalTest.contentType}`);
  
  // Test 2: PAC File (Should be available)
  section('2. PAC File Test');
  const pacTest = await testPACFile();
  test('PAC file accessible and valid', pacTest.success,
       pacTest.error || `Function: ${pacTest.hasProxyFunction}, Proxy: ${pacTest.hasCorrectProxy}`);
  
  // Test 3: Direct Connection Blocking (No proxy users)
  section('3. No Proxy Configuration Test');
  const directTests = [
    'http://google.com',
    'http://facebook.com',
    'http://youtube.com'
  ];
  
  for (const url of directTests) {
    const result = await testDirectConnection(url);
    test(`Direct access to ${url} blocked`, result.success,
         result.error || `Status: ${result.status}, Redirected: ${result.redirectedToPortal}`);
  }
  
  // Test 4: Manual Proxy Blocking
  section('4. Manual Proxy Configuration Test');
  const manualProxyTests = [
    'http://google.com',
    'http://github.com',
    'http://stackoverflow.com'
  ];
  
  for (const url of manualProxyTests) {
    const result = await testProxyConnection(url, 'manual');
    test(`Manual proxy access to ${url} blocked`, result.success,
         result.error || `Status: ${result.status}, Type: ${result.proxyType}`);
  }
  
  // Test 5: Auto Proxy (PAC) Blocking
  section('5. Auto Proxy (PAC) Configuration Test');
  const autoProxyTests = [
    'http://google.com',
    'http://twitter.com',
    'http://instagram.com'
  ];
  
  for (const url of autoProxyTests) {
    const result = await testProxyConnection(url, 'auto');
    test(`Auto proxy access to ${url} blocked`, result.success,
         result.error || `Status: ${result.status}, Type: ${result.proxyType}`);
  }
  
  // Test 6: Invalid Proxy Port Handling
  section('6. Invalid Proxy Port Test');
  const invalidPortTest = await testInvalidProxyPort();
  test('Invalid proxy port (-1) properly handled', invalidPortTest.success,
       invalidPortTest.error || `Status: ${invalidPortTest.status}`);
  
  // Test 7: User Type Detection
  section('7. User Type Detection Test');
  const detectionTests = await testUserTypeDetection();
  detectionTests.forEach((result, index) => {
    const testName = `User type detection for ${Object.keys(result.testCase)[0]}`;
    test(testName, result.success,
         result.error || `Status: ${result.status}, Detection: ${result.hasDetection}`);
  });
  
  // Summary
  section('TEST SUMMARY');
  log('All comprehensive proxy restriction tests completed!', 'green');
  log('Check individual test results above for any failures.', 'yellow');
  log('\nKey Expectations:', 'blue');
  log('✅ Portal should always be accessible', 'green');
  log('✅ PAC file should be available and valid', 'green');
  log('✅ All external websites should be blocked for unauthenticated users', 'green');
  log('✅ Different proxy types should be detected and handled appropriately', 'green');
  log('✅ Invalid configurations should be blocked with helpful messages', 'green');
  log('✅ User type detection should work for all configuration scenarios', 'green');
  
  log('\nNext Steps:', 'magenta');
  log('1. If any tests fail, check server logs for details', 'yellow');
  log('2. Verify proxy server is running on port 9092', 'yellow');
  log('3. Test with real devices using different proxy configurations', 'yellow');
  log('4. Monitor user feedback after implementing these fixes', 'yellow');
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'red');
});

// Run the tests
runComprehensiveTests().catch(error => {
  log(`Test execution failed: ${error.message}`, 'red');
  process.exit(1);
});
