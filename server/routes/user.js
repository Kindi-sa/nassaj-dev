import express from 'express';
import { userDb } from '../modules/database/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { getSystemGitConfig } from '../utils/gitConfig.js';
import { getClaudeConnectionStatus } from '../services/isolation/claude-onboarding.service.js';
import { getAgyConnectionStatus } from '../services/isolation/agy-onboarding.service.js';

const router = express.Router();

router.get('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let gitConfig = userDb.getGitConfig(userId);

    // If database is empty, try to get from system git config
    if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
      const systemConfig = await getSystemGitConfig();

      // If system has values, save them to database for this user
      if (systemConfig.git_name || systemConfig.git_email) {
        userDb.updateGitConfig(userId, systemConfig.git_name, systemConfig.git_email);
        gitConfig = systemConfig;
        console.log(`Auto-populated git config from system for user ${userId}: ${systemConfig.git_name} <${systemConfig.git_email}>`);
      }
    }

    res.json({
      success: true,
      gitName: gitConfig?.git_name || null,
      gitEmail: gitConfig?.git_email || null
    });
  } catch (error) {
    console.error('Error getting git config:', error);
    res.status(500).json({ error: 'Failed to get git configuration' });
  }
});

// Persist the user's git identity to their DB row ONLY (B-MU-UX-GIT-ID).
//
// This no longer runs `git config --global`: in the shared nassaj workspace a
// global write was last-writer-wins and clobbered every other brother's
// identity in ~/.gitconfig. The stored name/email is instead injected
// per-commit at each commit site via GIT_AUTHOR_*/GIT_COMMITTER_*, so saving an
// identity never affects other users or the system gitconfig.
router.post('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { gitName, gitEmail } = req.body;

    if (!gitName || !gitEmail) {
      return res.status(400).json({ error: 'Git name and email are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(gitEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    userDb.updateGitConfig(userId, gitName, gitEmail);

    res.json({
      success: true,
      gitName,
      gitEmail
    });
  } catch (error) {
    console.error('Error updating git config:', error);
    res.status(500).json({ error: 'Failed to update git configuration' });
  }
});

router.post('/complete-onboarding', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    userDb.completeOnboarding(userId);

    res.json({
      success: true,
      message: 'Onboarding completed successfully'
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

router.get('/onboarding-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const hasCompleted = userDb.hasCompletedOnboarding(userId);

    res.json({
      success: true,
      hasCompletedOnboarding: hasCompleted
    });
  } catch (error) {
    console.error('Error checking onboarding status:', error);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

// Reports whether the current user has registered their own Claude credential
// in their isolated config dir (B-MU-ONBOARD). Returns only a boolean — never
// the token itself — so the onboarding UI can render "connected/not connected".
//
//   curl -H "Authorization: Bearer <jwt>" \
//        https://nassaj-dev.alkindy.tech/api/user/claude-connection
router.get('/claude-connection', authenticateToken, async (req, res) => {
  try {
    const status = await getClaudeConnectionStatus(req.user.id);
    res.json(status);
  } catch (error) {
    console.error('Error checking Claude connection status:', error);
    res.status(500).json({ error: 'Failed to check Claude connection status' });
  }
});

// Reports whether the current user has authenticated their own agy (antigravity)
// credential in their isolated config dir (ADR-023). Returns only a boolean —
// never the token — so the onboarding UI can render "connected/not connected".
// userId comes from the JWT, never from input.
//
//   curl -H "Authorization: Bearer <jwt>" \
//        https://nassaj-dev.alkindy.tech/api/user/agy-connection
router.get('/agy-connection', authenticateToken, async (req, res) => {
  try {
    const status = await getAgyConnectionStatus(req.user.id);
    res.json(status);
  } catch (error) {
    console.error('Error checking agy connection status:', error);
    res.status(500).json({ error: 'Failed to check agy connection status' });
  }
});

export default router;
