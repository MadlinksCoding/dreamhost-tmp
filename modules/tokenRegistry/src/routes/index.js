const express = require('express');
const router = express.Router();
const userTokensController = require('../controllers/userTokensController');
const tokenRegistryController = require('../controllers/tokenRegistryController');

// User Tokens endpoints
router.get('/user-tokens', userTokensController.list);
router.get('/user-tokens/count', userTokensController.count);
router.get('/user-tokens/creator-free-tokens', userTokensController.listCreatorFreeTokens);
router.get('/user-tokens/:userId/drilldown', userTokensController.drilldown);

// Token Registry endpoints
router.get('/token-registry', tokenRegistryController.list);
router.get('/token-registry/count', tokenRegistryController.count);
router.get('/token-registry/:id', tokenRegistryController.getById);

module.exports = router;
