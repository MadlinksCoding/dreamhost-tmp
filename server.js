const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const morgan = require('morgan');

// Import module routers directly
const { router: blockUserRouter, initBlockUserService } = require('./modules/blockUserService/server.js');
const { router: usersRouter, initUsersService } = require('./modules/users/server.js');
const { router: mediaRouter, initMediaService } = require('./modules/media/server.js');
const { router: moderationRouter, initModerationService } = require('./modules/moderation/server.js');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Environment configuration
const RUN_SEPARATELY = process.env.RUN_MODULES_SEPARATELY === 'true';
const ENABLED_MODULES = process.env.ENABLED_MODULES ?
  process.env.ENABLED_MODULES.split(',').map(m => m.trim()) :
  ['blockUserService', 'users', 'media', 'moderation'];

// Middleware
const corsOptions = {
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: '*',
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(morgan('dev'));

// Module configurations with static imports
const modules = {
  blockUserService: {
    router: blockUserRouter,
    init: initBlockUserService,
    routePrefix: '',
    port: process.env.BLOCK_USER_PORT || 3001
  },
  users: {
    router: usersRouter,
    init: initUsersService,
    routePrefix: '',
    port: process.env.USERS_PORT || 3002
  },
  media: {
    router: mediaRouter,
    init: initMediaService,
    routePrefix: '',
    port: process.env.MEDIA_PORT || 3003
  },
  moderation: {
    router: moderationRouter,
    init: initModerationService,
    routePrefix: '',
    port: process.env.MODERATION_PORT || 3004
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    modules: ENABLED_MODULES,
    mode: RUN_SEPARATELY ? 'separate' : 'combined'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Multi-Module API Server',
    version: '1.0.0',
    modules: ENABLED_MODULES,
    endpoints: ENABLED_MODULES.map(module => ({
      name: module,
      path: modules[module].routePrefix,
      port: RUN_SEPARATELY ? modules[module].port : null
    }))
  });
});

// Dynamic module loading
async function loadModules() {
  const loadedModules = [];

  for (const moduleName of ENABLED_MODULES) {
    try {
      const moduleConfig = modules[moduleName];
      if (!moduleConfig) {
        console.warn(`⚠️  Module '${moduleName}' not found in configuration`);
        continue;
      }

      console.log(`🔄 Loading module: ${moduleName}`);

      // All modules are now ES modules
      const moduleRouter = moduleConfig.router;
      const moduleInit = moduleConfig.init;

      if (RUN_SEPARATELY) {
        // Run module separately on its own port
        const moduleApp = express();
        moduleApp.use(cors(corsOptions));
        moduleApp.use(express.json());
        moduleApp.use(morgan('dev'));

        // Initialize module services if init function exists
        if (moduleInit) {
          await moduleInit();
        }

        // Mount module routes
        if (moduleRouter) {
          moduleApp.use('/', moduleRouter);
        } else {
          console.warn(`⚠️  Module '${moduleName}' does not export a router`);
          continue;
        }

        // Start separate server for this module
        const server = moduleApp.listen(moduleConfig.port, () => {
          console.log(`✅ ${moduleName} running separately on port ${moduleConfig.port}`);
        });

        loadedModules.push({
          name: moduleName,
          port: moduleConfig.port,
          server,
          status: 'running'
        });

      } else {
        // Initialize module services if init function exists
        if (moduleInit) {
          await moduleInit();
        }

        // Mount module routes under combined server
        if (moduleRouter) {
          app.use(moduleConfig.routePrefix, moduleRouter);
        } else {
          console.warn(`⚠️  Module '${moduleName}' does not export a router`);
          continue;
        }

        console.log(`✅ ${moduleName} mounted at ${moduleConfig.routePrefix}`);
        loadedModules.push({
          name: moduleName,
          route: moduleConfig.routePrefix,
          status: 'mounted'
        });
      }

    } catch (error) {
      console.error(`❌ Failed to load module '${moduleName}':`, error.message);
      loadedModules.push({
        name: moduleName,
        status: 'failed',
        error: error.message
      });
    }
  }

  return loadedModules;
}

// Graceful shutdown
let servers = [];

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  servers.forEach(server => server.close());
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  servers.forEach(server => server.close());
  process.exit(0);
});

// Initialize and start server
async function startServer() {
  try {
    console.log('🚀 Starting Multi-Module API Server...');
    console.log(`📋 Mode: ${RUN_SEPARATELY ? 'SEPARATE' : 'COMBINED'}`);
    console.log(`📦 Enabled modules: ${ENABLED_MODULES.join(', ')}`);

    const loadedModules = await loadModules();

    if (!RUN_SEPARATELY) {
      // Start combined server
      const server = app.listen(PORT, () => {
        console.log(`✅ Combined server running on port ${PORT}`);
        console.log(`🌐 Health check: http://localhost:${PORT}/health`);
        console.log(`📖 API docs: http://localhost:${PORT}/`);
      });
      servers.push(server);
    } else {
      console.log('🌐 Individual module servers started:');
      loadedModules.forEach(module => {
        if (module.status === 'running') {
          console.log(`   - ${module.name}: http://localhost:${module.port}`);
        }
      });
    }

    // Log module status
    console.log('\n📊 Module Status:');
    loadedModules.forEach(module => {
      const status = module.status === 'running' ? '✅' :
                    module.status === 'mounted' ? '✅' :
                    module.status === 'failed' ? '❌' : '⚠️';
      console.log(`   ${status} ${module.name}: ${module.status}`);
      if (module.error) {
        console.log(`      Error: ${module.error}`);
      }
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Start the server
startServer();

module.exports = app;
