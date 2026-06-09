/**
 * V Astra Create - Secure Backend Server
 * Handles AI routing, Firebase integration, Google Play billing, and subscription management
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import admin from 'firebase-admin';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================================================
// FIREBASE ADMIN INITIALIZATION
// ============================================================================

const firebaseConfig = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = admin.firestore();
const auth = admin.auth();

// ============================================================================
// AI ROUTING CONFIGURATION
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HUGGING_FACE_API_KEY = process.env.HUGGING_FACE_API_KEY;
const HUGGING_FACE_MODEL = process.env.HUGGING_FACE_MODEL || 'mistralai/Mistral-7B-Instruct-v0.1';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ============================================================================
// TIER CONFIGURATION
// ============================================================================

const TIER_CONFIG = {
  free: { maxPrompts: 5, maxApps: 2, monthlyCredits: 5 },
  plus: { maxPrompts: 25, maxApps: 5, monthlyCredits: 25 },
  pro: { maxPrompts: 60, maxApps: 15, monthlyCredits: 60 },
  ultra: { maxPrompts: 100, maxApps: 20, monthlyCredits: 100 },
};

const GOOGLE_PLAY_PRODUCT_IDS = {
  plus: process.env.GOOGLE_PLAY_PLUS_ID || 'v_astra_plus_monthly',
  pro: process.env.GOOGLE_PLAY_PRO_ID || 'v_astra_pro_monthly',
  ultra: process.env.GOOGLE_PLAY_ULTRA_ID || 'v_astra_ultra_monthly',
};

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================================================
// USER MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * Initialize or restore user data from Firebase
 * POST /api/user/init
 */
app.post('/api/user/init', verifyToken, async (req, res) => {
  try {
    const { uid, email } = req.user;

    // Check if user exists
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      // Return existing user data
      const userData = userDoc.data();
      return res.json({
        uid,
        email,
        tier: userData.tier || 'free',
        remainingCredits: userData.remainingCredits || TIER_CONFIG.free.monthlyCredits,
        totalPrompts: userData.totalPrompts || 0,
        maxPrompts: TIER_CONFIG[userData.tier || 'free'].maxPrompts,
        createdAt: userData.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }

    // Create new user with free tier
    const newUserData = {
      uid,
      email,
      tier: 'free',
      remainingCredits: TIER_CONFIG.free.monthlyCredits,
      totalPrompts: 0,
      maxPrompts: TIER_CONFIG.free.maxPrompts,
      apps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCreditReset: new Date().toISOString(),
    };

    await userRef.set(newUserData);

    res.json({
      uid,
      email,
      tier: 'free',
      remainingCredits: TIER_CONFIG.free.monthlyCredits,
      totalPrompts: 0,
      maxPrompts: TIER_CONFIG.free.maxPrompts,
      createdAt: newUserData.createdAt,
      updatedAt: newUserData.updatedAt,
    });
  } catch (error) {
    console.error('User init error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user profile and subscription status
 * GET /api/user/profile
 */
app.get('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    res.json({
      uid,
      email: req.user.email,
      tier: userData.tier,
      remainingCredits: userData.remainingCredits,
      totalPrompts: userData.totalPrompts,
      maxPrompts: TIER_CONFIG[userData.tier].maxPrompts,
      apps: userData.apps || [],
      createdAt: userData.createdAt,
      updatedAt: userData.updatedAt,
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// AI GENERATION ENDPOINTS
// ============================================================================

/**
 * Generate app from prompt using tier-based AI routing
 * POST /api/generate
 */
app.post('/api/generate', verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { prompt, appName } = req.body;

    if (!prompt || !appName) {
      return res.status(400).json({ error: 'prompt and appName required' });
    }

    // Get user data
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    // Check credit limit
    if (userData.remainingCredits <= 0) {
      return res.status(402).json({
        error: 'Insufficient credits',
        remainingCredits: 0,
        tier: userData.tier,
      });
    }

    // Route to appropriate AI provider based on tier
    let html, provider;

    if (userData.tier === 'free') {
      // Route to Hugging Face (free tier)
      ({ html, provider } = await generateWithHuggingFace(prompt, appName));
    } else {
      // Route to Gemini (paid tiers)
      ({ html, provider } = await generateWithGemini(prompt, appName));
    }

    // Deduct credit
    const newCredits = userData.remainingCredits - 1;
    const newTotalPrompts = (userData.totalPrompts || 0) + 1;

    await userRef.update({
      remainingCredits: newCredits,
      totalPrompts: newTotalPrompts,
      updatedAt: new Date().toISOString(),
    });

    // Generate unique app ID
    const appId = `app_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store app in user's apps array
    await userRef.update({
      apps: admin.firestore.FieldValue.arrayUnion({
        appId,
        appName,
        prompt,
        html,
        provider,
        createdAt: new Date().toISOString(),
        isPublished: false,
      }),
    });

    res.json({
      success: true,
      appId,
      html,
      provider,
      remainingCredits: newCredits,
      maxPrompts: TIER_CONFIG[userData.tier].maxPrompts,
      totalPrompts: newTotalPrompts,
    });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Edit existing app with new prompt
 * POST /api/edit/:appId
 */
app.post('/api/edit/:appId', verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { appId } = req.params;
    const { editPrompt } = req.body;

    if (!editPrompt) {
      return res.status(400).json({ error: 'editPrompt required' });
    }

    // Get user data
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    // Check credit limit
    if (userData.remainingCredits <= 0) {
      return res.status(402).json({
        error: 'Insufficient credits',
        remainingCredits: 0,
      });
    }

    // Find app
    const app = userData.apps?.find(a => a.appId === appId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Route to appropriate AI provider
    let updatedHtml, provider;

    if (userData.tier === 'free') {
      ({ html: updatedHtml, provider } = await generateWithHuggingFace(editPrompt, app.appName));
    } else {
      ({ html: updatedHtml, provider } = await generateWithGemini(editPrompt, app.appName));
    }

    // Deduct credit
    const newCredits = userData.remainingCredits - 1;
    const newTotalPrompts = (userData.totalPrompts || 0) + 1;

    // Update app in array
    const updatedApps = userData.apps.map(a =>
      a.appId === appId
        ? {
            ...a,
            html: updatedHtml,
            prompt: editPrompt,
            provider,
            updatedAt: new Date().toISOString(),
          }
        : a
    );

    await userRef.update({
      apps: updatedApps,
      remainingCredits: newCredits,
      totalPrompts: newTotalPrompts,
      updatedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      appId,
      html: updatedHtml,
      provider,
      remainingCredits: newCredits,
      totalPrompts: newTotalPrompts,
    });
  } catch (error) {
    console.error('Edit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// AI PROVIDER IMPLEMENTATIONS
// ============================================================================

/**
 * Generate HTML using Gemini API (Paid tiers)
 */
async function generateWithGemini(prompt, appName) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const systemPrompt = `You are an expert web developer. Generate a complete, production-ready HTML5 application for: "${appName}". 
    The user's request: "${prompt}"
    
    Requirements:
    - Return ONLY valid HTML5 code (no markdown, no code blocks)
    - Include inline CSS and JavaScript
    - Make it responsive and mobile-friendly
    - Use modern UI with Tailwind CSS classes (include CDN link)
    - Ensure the app is fully functional
    - Add proper error handling
    - Start with <!DOCTYPE html>`;

    const result = await model.generateContent(systemPrompt);
    const html = result.response.text();

    return {
      html: html.includes('<!DOCTYPE') ? html : `<!DOCTYPE html>\n${html}`,
      provider: 'gemini-2.5-flash',
    };
  } catch (error) {
    console.error('Gemini generation error:', error);
    throw new Error(`Gemini generation failed: ${error.message}`);
  }
}

/**
 * Generate HTML using Hugging Face API (Free tier)
 */
async function generateWithHuggingFace(prompt, appName) {
  try {
    const response = await axios.post(
      `https://api-inference.huggingface.co/models/${HUGGING_FACE_MODEL}`,
      {
        inputs: `Generate a complete HTML5 web application for "${appName}" based on this request: "${prompt}". Return only valid HTML5 code starting with <!DOCTYPE html>.`,
      },
      {
        headers: {
          Authorization: `Bearer ${HUGGING_FACE_API_KEY}`,
        },
      }
    );

    let html = response.data[0]?.generated_text || '';

    // Clean up response
    if (!html.includes('<!DOCTYPE')) {
      html = `<!DOCTYPE html>\n${html}`;
    }

    return {
      html,
      provider: HUGGING_FACE_MODEL,
    };
  } catch (error) {
    console.error('Hugging Face generation error:', error);
    throw new Error(`Hugging Face generation failed: ${error.message}`);
  }
}

// ============================================================================
// GOOGLE PLAY BILLING ENDPOINTS
// ============================================================================

/**
 * Verify purchase token with Google Play Console API
 * POST /api/billing/verify-purchase
 */
app.post('/api/billing/verify-purchase', verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { purchaseToken, packageName, productId } = req.body;

    if (!purchaseToken || !packageName || !productId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify with Google Play API
    const isValid = await verifyGooglePlayPurchase(packageName, productId, purchaseToken);

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid purchase token' });
    }

    // Get tier from product ID
    const tier = Object.entries(GOOGLE_PLAY_PRODUCT_IDS).find(
      ([_, id]) => id === productId
    )?.[0];

    if (!tier) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    // Update user tier and credits
    const userRef = db.collection('users').doc(uid);
    const tierConfig = TIER_CONFIG[tier];

    await userRef.update({
      tier,
      remainingCredits: tierConfig.monthlyCredits,
      maxPrompts: tierConfig.maxPrompts,
      purchaseToken,
      purchaseDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      tier,
      remainingCredits: tierConfig.monthlyCredits,
      maxPrompts: tierConfig.maxPrompts,
    });
  } catch (error) {
    console.error('Purchase verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Restore purchases from Google Play
 * POST /api/billing/restore-purchases
 */
app.post('/api/billing/restore-purchases', verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { purchaseTokens } = req.body;

    if (!Array.isArray(purchaseTokens) || purchaseTokens.length === 0) {
      return res.status(400).json({ error: 'No purchase tokens provided' });
    }

    // Verify all purchase tokens
    const validPurchases = [];

    for (const token of purchaseTokens) {
      const isValid = await verifyGooglePlayPurchase(
        process.env.PACKAGE_NAME,
        token.productId,
        token.purchaseToken
      );

      if (isValid) {
        validPurchases.push(token);
      }
    }

    if (validPurchases.length === 0) {
      return res.status(400).json({ error: 'No valid purchases found' });
    }

    // Get the highest tier from valid purchases
    const tiers = validPurchases
      .map(p => Object.entries(GOOGLE_PLAY_PRODUCT_IDS).find(([_, id]) => id === p.productId)?.[0])
      .filter(Boolean);

    const highestTier = tiers.includes('ultra') ? 'ultra' : tiers.includes('pro') ? 'pro' : 'plus';
    const tierConfig = TIER_CONFIG[highestTier];

    // Update user
    const userRef = db.collection('users').doc(uid);
    await userRef.update({
      tier: highestTier,
      remainingCredits: tierConfig.monthlyCredits,
      maxPrompts: tierConfig.maxPrompts,
      restoredPurchases: validPurchases,
      updatedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      tier: highestTier,
      remainingCredits: tierConfig.monthlyCredits,
      maxPrompts: tierConfig.maxPrompts,
    });
  } catch (error) {
    console.error('Purchase restoration error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Verify Google Play purchase (placeholder - implement with Google Play Billing Library)
 */
async function verifyGooglePlayPurchase(packageName, productId, purchaseToken) {
  try {
    // TODO: Implement actual Google Play API verification
    // This requires OAuth2 credentials from Google Play Console
    // For now, return true for testing
    console.log(`Verifying purchase: ${packageName} / ${productId}`);
    return true;
  } catch (error) {
    console.error('Google Play verification error:', error);
    return false;
  }
}

// ============================================================================
// APP PUBLISHING ENDPOINTS
// ============================================================================

/**
 * Publish app to shareable link
 * POST /api/publish/:appId
 */
app.post('/api/publish/:appId', verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { appId } = req.params;

    // Get user data
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const app = userData.apps?.find(a => a.appId === appId);

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Generate shareable link
    const shareId = `share_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const publishedUrl = `${process.env.APP_BASE_URL || 'https://vastracreate.app'}/app/${shareId}`;

    // Store published app
    const publishedRef = db.collection('published_apps').doc(shareId);
    await publishedRef.set({
      appId,
      uid,
      appName: app.appName,
      html: app.html,
      createdAt: new Date().toISOString(),
      views: 0,
    });

    // Update user's app
    const updatedApps = userData.apps.map(a =>
      a.appId === appId
        ? {
            ...a,
            isPublished: true,
            publishedUrl,
            shareId,
            publishedAt: new Date().toISOString(),
          }
        : a
    );

    await userRef.update({
      apps: updatedApps,
      updatedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      appId,
      shareId,
      publishedUrl,
    });
  } catch (error) {
    console.error('Publish error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get published app
 * GET /api/published/:shareId
 */
app.get('/api/published/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;

    const publishedRef = db.collection('published_apps').doc(shareId);
    const publishedDoc = await publishedRef.get();

    if (!publishedDoc.exists) {
      return res.status(404).json({ error: 'App not found' });
    }

    const appData = publishedDoc.data();

    // Increment view count
    await publishedRef.update({
      views: (appData.views || 0) + 1,
    });

    res.json({
      appName: appData.appName,
      html: appData.html,
      createdAt: appData.createdAt,
      views: appData.views + 1,
    });
  } catch (error) {
    console.error('Fetch published app error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  console.log(`[V Astra Create Backend] Server running on http://localhost:${PORT}`);
  console.log(`[AI Routing] Gemini API: ${GEMINI_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log(`[AI Routing] Hugging Face API: ${HUGGING_FACE_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log(`[Firebase] Initialized: ${admin.apps.length > 0 ? '✓' : '✗'}`);
});

export default app;
