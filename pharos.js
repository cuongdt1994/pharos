const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Constants
const CONFIG = {
  TOKEN_FILE: path.join(__dirname, 'prdt_tokens.json'),
  CHECK_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  API_ENDPOINTS: {
    REQUEST_MESSAGE: 'https://api7.prdt.finance/auth/request-message',
    VERIFY: 'https://api7.prdt.finance/auth/verify',
    CHECKIN: 'https://apim.prdt.finance/api/v1/mine/checkin'
  }
};

// File operations
function saveTokens(tokens) {
  try {
    fs.writeFileSync(CONFIG.TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log(`Saved tokens to: ${CONFIG.TOKEN_FILE}`);
    return true;
  } catch (error) {
    console.error(`Error saving tokens:`, error.message);
    return false;
  }
}

function loadTokens() {
  try {
    if (fs.existsSync(CONFIG.TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.TOKEN_FILE, 'utf8'));
    }
    return null;
  } catch (error) {
    console.error(`Error loading tokens:`, error.message);
    return null;
  }
}

// Get request headers
function getHeaders(domain = 'api7.prdt.finance', tokens = null) {
  const headers = {
    'authority': domain,
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'origin': 'https://prdt.finance',
    'referer': 'https://prdt.finance/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  };

  // Add auth cookies if available
  if (tokens && tokens.accessToken && tokens.refreshToken) {
    headers.cookie = `accessToken=${tokens.accessToken}; refreshToken=${tokens.refreshToken}`;
  }

  return headers;
}

// Get options headers for preflight
function getOptionsHeaders(domain = 'apim.prdt.finance') {
  return {
    'authority': domain,
    'accept': '*/*',
    'access-control-request-headers': 'content-type',
    'access-control-request-method': 'POST',
    'origin': 'https://prdt.finance',
    'referer': 'https://prdt.finance/'
  };
}

// Login function
async function login(privateKey) {
  try {
    // Create wallet from private key
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;
    
    console.log(`Logging in with address: ${address}`);
    
    // Request message to sign
    const requestMessageResponse = await axios.post(
      CONFIG.API_ENDPOINTS.REQUEST_MESSAGE, 
      { address, chain: 688688, network: 'evm' },
      { headers: getHeaders() }
    );
    
    const { message, nonce } = requestMessageResponse.data;
    
    // Sign message with private key
    const signature = await wallet.signMessage(message);
    
    // Verify signature
    const verifyResponse = await axios.post(
      CONFIG.API_ENDPOINTS.VERIFY, 
      { address, message, nonce, signature },
      { headers: getHeaders(), withCredentials: true }
    );
    
    console.log('Login successful!');
    
    // Extract auth tokens
    const authTokens = { address, signature, accessToken: null, refreshToken: null };
    
    // Extract tokens from cookies
    if (verifyResponse.headers['set-cookie']) {
      const cookies = verifyResponse.headers['set-cookie'];
      
      for (const cookie of cookies) {
        if (cookie.includes('accessToken=')) {
          authTokens.accessToken = cookie.split('accessToken=')[1].split(';')[0];
        }
        if (cookie.includes('refreshToken=')) {
          authTokens.refreshToken = cookie.split('refreshToken=')[1].split(';')[0];
        }
      }
    }
    
    // Fallback to response data if cookies didn't have tokens
    if (!authTokens.accessToken && verifyResponse.data.accessToken) {
      authTokens.accessToken = verifyResponse.data.accessToken;
    }
    
    if (!authTokens.refreshToken && verifyResponse.data.refreshToken) {
      authTokens.refreshToken = verifyResponse.data.refreshToken;
    }
    
    // Save tokens
    saveTokens(authTokens);
    
    return authTokens;
  } catch (error) {
    console.error('Error during login:', error.message);
    if (error.response) {
      console.error('API Error Details:', error.response.data);
    }
    return null;
  }
}

// Daily check-in function
async function dailyCheckIn(tokens) {
  try {
    if (!tokens?.address) {
      throw new Error('No authentication info. Please login again.');
    }
    
    console.log(`Performing daily check-in for address: ${tokens.address}`);
    
    // First, make OPTIONS request (preflight)
    await axios({
      method: 'OPTIONS',
      url: CONFIG.API_ENDPOINTS.CHECKIN,
      headers: getOptionsHeaders()
    });
    
    // Then POST to check-in
    const checkInResponse = await axios.post(
      CONFIG.API_ENDPOINTS.CHECKIN, 
      {}, // Empty body
      { 
        headers: getHeaders('apim.prdt.finance', tokens),
        withCredentials: true
      }
    );
    
    console.log('Check-in successful!');
    console.log(`Next check-in active: ${checkInResponse.data.user.nextCheckInActive}`);
    console.log(`Mined tokens: ${checkInResponse.data.user.minedTokens}`);
    
    return true;
  } catch (error) {
    console.error('Error during check-in:', error.message);
    
    if (error.response) {
      console.error('API Error Details:', error.response.data);
      
      // Check for specific errors
      if (error.response.status === 401) {
        console.log('Authentication expired. Need to login again.');
        return { needRelogin: true };
      }
      
      if (error.response.status === 400) {
        const message = error.response.data?.message;
        if (message === "Check-in not within valid window") {
          console.log('Already checked in or not within check-in window.');
          return { alreadyDone: true };
        }
      }
    }
    
    return { error: true };
  }
}

// Main function
async function main() {
  try {
    // Get private key from .env or command line arguments
    const privateKey = process.env.PRIVATE_KEY || process.argv[2];
    
    if (!privateKey) {
      console.error('Please provide PRIVATE_KEY in .env file or as a command line argument');
      process.exit(1);
    }
    
    // Function for check-in process
    async function performCheckIn() {
      // Get saved tokens or log in
      let tokens = loadTokens();
      
      if (!tokens) {
        console.log('No tokens found. Logging in...');
        tokens = await login(privateKey);
        
        if (!tokens) {
          console.error('Login failed. Exiting...');
          return;
        }
      }
      
      // Try to check in
      const checkInResult = await dailyCheckIn(tokens);
      
      // If we need to re-login
      if (checkInResult && checkInResult.needRelogin) {
        console.log('Token expired, logging in again...');
        tokens = await login(privateKey);
        
        if (tokens) {
          await dailyCheckIn(tokens);
        }
      }
    }
    
    // Perform initial check-in
    await performCheckIn();
    
    // Setup scheduled checking
    console.log(`Automated check-in scheduled every ${CONFIG.CHECK_INTERVAL/1000/60/60} hours`);
    setInterval(performCheckIn, CONFIG.CHECK_INTERVAL);
    
  } catch (error) {
    console.error('Error during execution:', error.message);
    process.exit(1);
  }
}

// Run the program
main();
